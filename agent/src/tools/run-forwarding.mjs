import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';
import { resolveInternalDomains } from '../../../scripts/lib/message-audience.mjs';
import { isActive } from '../../../scripts/lib/forwarding-destinations.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createOutlookGraphAdapter } from '../mail/outlook-graph-adapter.mjs';
import { createDestinationChooser } from '../routing/destination-router.mjs';
import { createForwardingStore } from '../routing/forwarding-store.mjs';
import { runForwarding } from '../routing/forward-runner.mjs';

// Runs the forwarding pass on its own, without a mailbox poll.
//
// The worker already does this at the end of every poll; this exists so it can
// be rehearsed and re-run deliberately — a full `ingest:once` re-reads the
// mailbox and spends tokens on triage and categorisation, which is a lot of
// machinery to exercise one send.
//
//   npm run forward:dry-run     # decide everything (router included), send nothing
//   npm run forward:once        # actually forward and acknowledge
//   npm run forward:dry-run -- --since=2026-07-01   # rehearse on older mail
//
// Nothing happens until Agent Setup > Forwarding has a start date, and only mail
// received since then is considered.

const dryRun = process.argv.includes('--dry-run');
// `--since=2026-07-01` rehearses as if forwarding had been on since then.
// Dry runs only.
const rehearseSince = process.argv.find((arg) => arg.startsWith('--since='))?.split('=')[1] ?? null;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createForwardingStore(supabase);
  const graphClient = createGraphClient(config);
  const provider = createOutlookGraphAdapter({ graphClient, mailbox: config.graph.mailbox });
  const chooser = config.openaiApiKey
    ? createDestinationChooser(createOpenAIClient({ apiKey: config.openaiApiKey }), { model: config.routerModel })
    : null;
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });
  const internalDomains = resolveInternalDomains({
    supportMailbox: config.graph.mailbox,
    extra: config.internalEmailDomains
  });

  if (rehearseSince && !dryRun) {
    console.error('--since is for dry runs only: a real run forwards mail received since the start date set on the page.');
    process.exitCode = 1;
    return;
  }
  const { destinations, settings } = await store.loadConfig(shopId);
  if (!settings.forward_since && !rehearseSince) {
    console.log('Forwarding is off: no start date is set in Agent Setup > Forwarding, so nothing would be sent.');
    return;
  }
  const active = destinations.filter(isActive);
  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be sent or recorded.' : 'Forwarding for real.'}\n` +
      `mailbox: ${config.graph.mailbox}\n` +
      `mail received since: ${rehearseSince ?? settings.forward_since}${rehearseSince ? ' (rehearsal)' : ''}\n` +
      `acknowledgement: ${settings.ack_enabled ? 'on' : 'off'}\n` +
      `internal domains (never forwarded): ${internalDomains.join(', ') || 'none'}\n` +
      `destinations: ${active.map((d) => `${d.label} -> ${d.forward_email}`).join(', ') || 'none'}\n`
  );

  const totals = await runForwarding({
    store,
    graphClient,
    provider,
    chooser,
    senderDirectory,
    shopId,
    logger,
    internalDomains,
    dryRun,
    rehearseSince: rehearseSince ? new Date(rehearseSince).toISOString() : null,
    onPreview: (preview) => {
      if (preview.kind === 'route') {
        const where = preview.decision.outcome === 'forward' ? preview.decision.destination_label : 'stays';
        console.log(`  [${preview.ticket.category}] ${oneLine(preview.ticket.subject, 70)}\n     route -> ${where}${preview.decision.reason ? `  — ${preview.decision.reason}` : ''}`);
      } else if (preview.kind === 'forward') {
        console.log(`     forward "${oneLine(preview.subject, 60)}" -> ${preview.address}`);
      } else if (preview.kind === 'ack') {
        console.log(`     acknowledge -> ${preview.recipient}\n${indent(preview.bodyText)}`);
      }
    }
  });

  console.log(
    `\n${dryRun ? 'Would forward' : 'Forwarded'} ${totals.forwarded} of ${totals.considered} message(s): ` +
      `${totals.kept} kept, ${totals.waiting} waiting for our reply, ${totals.undecided} undecided, ` +
      `${totals.skipped} skipped, ${totals.failed} failed. ` +
      `Acknowledgements: ${totals.acknowledged} ${dryRun ? 'would be sent' : 'sent'}, ${totals.ackSkipped} skipped, ${totals.ackFailed} failed.`
  );
}

function oneLine(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function indent(text) {
  return String(text).split('\n').map((line) => `        | ${line}`).join('\n');
}
