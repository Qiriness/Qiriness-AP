import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { CURSOR_KEYS } from '../ingestion/delta-poller.mjs';
import { resolveShopId } from '../lib/shop.mjs';

// Takes tickets whose every message predates the mailbox cutover out of the
// categorisation queue. Decided 2026-09-26: the first complete read imported
// history back to 2025-09-30, and 831 tickets sat flagged. Categorising them
// would spend a model call each, then an investigation, on threads nobody is
// waiting on.
//
//   npm run tickets:unqueue-pre-cutover:dry-run
//   npm run tickets:unqueue-pre-cutover -- [--keep-after=<ISO>]
//
// ONLY `needs_categorisation` MOVES. Category, level, subject and every other
// label stay as they are, for reporting. A customer message received after the
// cutover raises the flag again through the ordinary ingestion rule, so nothing
// here needs undoing later.
//
// "BEFORE THE CUTOVER" IS READ FROM THE MESSAGES, not from `last_message_at`:
// the latest `received_at` on the ticket must be earlier than
// `sync_cursors.mail_ingest_cutover_at`. `--keep-after` leaves tickets with a
// message after that time in the queue.

const dryRun = process.argv.includes('--dry-run');
const keepAfterArg = process.argv.find((arg) => arg.startsWith('--keep-after='))?.slice('--keep-after='.length) || null;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const cursors = (await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors'))[0]?.sync_cursors || {};
  const cutover = cursors[CURSOR_KEYS.cutoverAt];
  if (!cutover) {
    throw new Error('No mail_ingest_cutover_at: a full read has not completed, so there is no boundary to apply.');
  }
  const keepAfter = keepAfterArg ? new Date(keepAfterArg).toISOString() : null;

  const flagged = await supabaseSelectAll(
    supabase,
    'tickets',
    { shop_id: shopId, needs_categorisation: true },
    'id,subject,status,category'
  );
  const latest = new Map();
  for (const message of await supabaseSelectAll(supabase, 'ticket_messages', { shop_id: shopId }, 'ticket_id,received_at')) {
    const at = message.received_at ? Date.parse(message.received_at) : NaN;
    if (!Number.isNaN(at) && at > (latest.get(message.ticket_id) ?? -Infinity)) latest.set(message.ticket_id, at);
  }

  const cutoverAt = Date.parse(cutover);
  const keepAt = keepAfter ? Date.parse(keepAfter) : Infinity;
  const clear = [];
  const kept = { afterCutover: 0, keptRecent: [], noMessages: 0 };
  for (const ticket of flagged) {
    const at = latest.get(ticket.id);
    if (at === undefined) { kept.noMessages += 1; continue; }
    if (at >= cutoverAt) { kept.afterCutover += 1; continue; }
    if (at > keepAt) { kept.keptRecent.push({ ...ticket, at }); continue; }
    clear.push(ticket);
  }

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Clearing the categorisation flag.'}`);
  console.log(`cutover ${cutover}${keepAfter ? ` · keeping anything after ${keepAfter}` : ''}\n`);
  console.log(`  ${flagged.length} tickets flagged for categorisation`);
  console.log(`  ${clear.length} have every message before the cutover → ${dryRun ? 'would be' : 'being'} cleared`);
  console.log(`     of which ${clear.filter((t) => t.category).length} already carry a category (kept)`);
  console.log(`  ${kept.afterCutover} have a message after the cutover → stay queued`);
  if (keepAfter) console.log(`  ${kept.keptRecent.length} have a message after ${keepAfter} → stay queued`);
  if (kept.noMessages) console.log(`  ${kept.noMessages} have no dated message → left alone`);

  const recent = [...clear].map((t) => ({ ...t, at: latest.get(t.id) })).sort((a, b) => b.at - a.at).slice(0, 5);
  console.log('\n  Most recent among those to clear:');
  for (const t of recent) console.log(`    ${new Date(t.at).toISOString()}  ${t.status.padEnd(17)} ${String(t.subject || '').replace(/\s+/g, ' ').slice(0, 60)}`);

  if (dryRun) {
    console.log('\nNothing was written. Re-run without --dry-run to clear them.\n');
    return;
  }

  let failed = 0;
  for (const ticket of clear) {
    try {
      await supabaseUpdateById(supabase, 'tickets', ticket.id, { needs_categorisation: false });
    } catch (error) {
      failed += 1;
      console.error(`  ${ticket.id}: ${error.message}`);
    }
  }
  console.log(`\n${clear.length - failed} cleared, ${failed} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}
