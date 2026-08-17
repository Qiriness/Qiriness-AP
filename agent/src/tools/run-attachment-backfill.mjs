import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import {
  createAttachmentBackfillStore,
  runAttachmentBackfill
} from '../ingestion/attachment-backfill.mjs';

// Fills attachment metadata for messages ingested before the column existed.
//
//   npm run attachments:backfill:dry-run          # fetch and show, write nothing
//   npm run attachments:backfill                  # write, 25 rows
//   npm run attachments:backfill -- --limit=100   # write, 100 rows
//
// START WITH THE DRY RUN AND READ THE FILENAMES. It makes the same Graph calls
// and prints what each message actually carries, which is the only way to see
// whether the classification is right before it starts backing a photo check:
// a `logo.png` at 8 KB reported as evidence would be a bug you can see here and
// nowhere else.
//
// Needs Graph credentials (Mail.Read). Metadata only — no attachment bytes are
// ever requested.

const dryRun = process.argv.includes('--dry-run');
const limit = parseLimit(process.argv) ?? 25;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing attachment metadata for real.'}\n` +
      `rows: up to ${limit}, newest first\n`
  );

  const totals = await runAttachmentBackfill({
    store: createAttachmentBackfillStore(supabase),
    graphClient: createGraphClient(config),
    shopId,
    limit,
    dryRun,
    logger,
    onPreview: ({ row, outcome, attachments, summary, error }) => {
      const subject = String(row.subject || '(no subject)').replace(/\s+/g, ' ').trim().slice(0, 50);
      const head = `  ${outcome.padEnd(6)} "${subject}"`;
      if (outcome === 'filled') {
        const parts = attachments
          .map((a) => `${a.name || '(unnamed)'} ${a.contentType || '?'} ${kb(a.size)}${a.isInline ? ' inline' : ''}`)
          .join('\n             ');
        console.log(
          `${head}\n             ${parts}\n` +
            `             -> ${summary.images} photo(s), ${summary.nonImages} other file(s), ` +
            `${summary.furniture} ignored as furniture`
        );
      } else if (outcome === 'failed') {
        console.log(`${head}\n             ${error}`);
      } else {
        console.log(head);
      }
    }
  });

  if (totals.mailboxMismatch) {
    console.error(
      `\nSTOPPED: Graph rejected the stored ids as invalid for ${config.graph.mailbox}.\n\n` +
        'Exchange item ids are scoped to the mailbox they were read from. These rows\n' +
        'were ingested while SUPPORT_MAILBOX pointed somewhere else, and every stored\n' +
        'id is equally unusable against the current one. Point SUPPORT_MAILBOX at the\n' +
        'mailbox this corpus came from and re-run.\n\n' +
        'Mail ingested from now on records its attachments at ingestion and needs no\n' +
        'backfill.\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n${dryRun ? 'Would fill' : 'Filled'} ${totals.filled} of ${totals.considered} row(s); ` +
      `${totals.withImages} carry a photo, ${totals.gone} no longer in the mailbox, ` +
      `${totals.failed} failed.`
  );
  if (totals.gone > 0) {
    console.log(
      'Rows marked "gone" keep their null: the email has left the Inbox, so what it\n' +
        'carried cannot be established. The photo check reports those as unknown rather\n' +
        'than as "no photo".'
    );
  }
  if (dryRun && totals.filled > 0) {
    console.log('Nothing was written. Re-run without --dry-run to store them.\n');
  }
}

function kb(size) {
  const n = Number(size) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
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
