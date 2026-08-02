import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';
import { resolveInternalDomains } from '../../../scripts/lib/message-audience.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import { createForwardingStore } from '../routing/forwarding-store.mjs';
import { runForwarding } from '../routing/forward-runner.mjs';

// Runs the forwarding pass on its own, without a mailbox poll or any LLM call.
//
// The worker already does this at the end of every poll; this exists so it can
// be rehearsed and re-run deliberately — a full `ingest:once` re-reads the
// mailbox and spends tokens on triage and categorisation, which is a lot of
// machinery to exercise one send.
//
//   npm run forward:dry-run     # decide everything, send nothing
//   npm run forward:once        # actually forward
//
// The first real run forwards the whole existing backlog at once, so start with
// the dry run and read the list.

const dryRun = process.argv.includes('--dry-run');

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
  const internalDomains = resolveInternalDomains({
    supportMailbox: config.graph.mailbox,
    extra: config.internalEmailDomains
  });

  const book = await store.loadAddressBook(shopId);
  if (book.size === 0) {
    console.log(
      'No forwarding addresses configured, so nothing would be forwarded.\n' +
        'Set them in the dashboard at /settings.'
    );
    return;
  }

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be sent.' : 'Forwarding for real.'}\n` +
      `mailbox: ${config.graph.mailbox}\n` +
      `internal domains (never forwarded): ${internalDomains.join(', ') || 'none'}\n` +
      `addresses: ${[...book.entries()].map(([c, a]) => `${c} -> ${a}`).join(', ')}\n`
  );

  let shown = 0;
  const totals = await runForwarding({
    store,
    graphClient,
    shopId,
    logger,
    internalDomains,
    dryRun,
    onPreview: ({ category, address, subject }) => {
      shown += 1;
      console.log(
        `  ${String(shown).padStart(3)}. [${category}] -> ${address}\n` +
          `       "${String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 76)}"`
      );
    }
  });

  console.log(
    `\n${dryRun ? 'Would forward' : 'Forwarded'} ${totals.forwarded} of ${totals.considered} ` +
      `candidate message(s); ${totals.skipped} skipped, ${totals.failed} failed.`
  );
  if (dryRun && totals.forwarded > 0) {
    console.log('Nothing was sent and nothing was recorded. Re-run without --dry-run to send.\n');
  }
}
