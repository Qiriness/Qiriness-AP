import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import {
  createSpamBodyBackfillStore,
  runSpamBodyBackfill
} from '../ingestion/spam-body-backfill.mjs';

// Re-reads dropped emails from Graph to fill in spam_audit bodies for rows that
// predate the body columns.
//
//   npm run spam:backfill:dry-run              # fetch and show, write nothing
//   npm run spam:backfill                      # write, 5 rows
//   npm run spam:backfill -- --limit=50        # write, 50 rows
//
// START SMALL AND LOOK AT THE OUTPUT. The dry run makes the same Graph calls and
// prints the first lines of each body, so you can confirm the text is the
// customer's own — not a wrapper, not markup — before letting it write. Newest
// decisions first, because a recent block is the one still worth overturning.
//
// Needs Graph credentials (Mail.Read); this is the only backfill that leaves
// Supabase.

const dryRun = process.argv.includes('--dry-run');
const limit = parseLimit(process.argv) ?? 5;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createSpamBodyBackfillStore(supabase);
  const graphClient = createGraphClient(config);

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing bodies for real.'}\n` +
      `rows: up to ${limit}, newest decisions first\n` +
      `retention: bodies expire ${config.spamAuditBodyRetentionDays} days after capture\n`
  );

  const totals = await runSpamBodyBackfill({
    store,
    graphClient,
    shopId,
    mailbox: config.graph.mailbox,
    limit,
    retentionDays: config.spamAuditBodyRetentionDays,
    dryRun,
    logger,
    onPreview: ({ row, outcome, body, error }) => {
      const subject = String(row.subject || '(no subject)').replace(/\s+/g, ' ').trim().slice(0, 56);
      const head = `  ${outcome.padEnd(6)} "${subject}"`;
      if (outcome === 'filled') {
        // The first line of what would be stored: enough to see whether the
        // mapper produced readable text or a wrapper.
        const preview = body.replace(/\s+/g, ' ').trim().slice(0, 100);
        console.log(`${head}\n           ${preview}${body.length > 100 ? '…' : ''}`);
      } else if (outcome === 'failed') {
        console.log(`${head}\n           ${error}`);
      } else {
        console.log(head);
      }
    }
  });

  if (totals.mailboxMismatch) {
    console.error(
      `\nSTOPPED: Graph rejected the stored ids as invalid for ${config.graph.mailbox}.\n\n` +
        'Exchange item ids are scoped to the mailbox they were read from, so this is\n' +
        'not recoverable mail loss — it means these rows were ingested while\n' +
        'SUPPORT_MAILBOX pointed at a different mailbox. Every stored id is equally\n' +
        'unusable against the current one, kept mail included.\n\n' +
        'Point SUPPORT_MAILBOX at the mailbox this corpus came from and re-run, or\n' +
        'accept that the pre-existing rows keep only their decision record. Mail\n' +
        'ingested from now on stores its body at the moment of the decision and\n' +
        'needs no backfill.\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n${dryRun ? 'Would fill' : 'Filled'} ${totals.filled} of ${totals.considered} row(s); ` +
      `${totals.gone} no longer in the mailbox, ${totals.empty} empty, ${totals.failed} failed.`
  );
  if (totals.gone > 0) {
    console.log(
      'Rows marked "gone" cannot be recovered — the email has left the Inbox, so the\n' +
        'decision record is all there will ever be for them.'
    );
  }
  if (dryRun && totals.filled > 0) {
    console.log('Nothing was written. Re-run without --dry-run to store them.\n');
  }
}

function parseLimit(argv) {
  const eq = argv.find((arg) => arg.startsWith('--limit='));
  if (eq) return toPositiveInt(eq.slice('--limit='.length));
  const i = argv.indexOf('--limit');
  if (i >= 0) return toPositiveInt(argv[i + 1]);
  return undefined;
}

function toPositiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
