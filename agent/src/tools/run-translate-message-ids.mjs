import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { CURSOR_KEYS, withoutLinks } from '../ingestion/delta-poller.mjs';
import { createGraphClient } from '../ingestion/graph-client.mjs';
import { ID_TABLES, compareWithDelta, planIdTranslation } from '../ingestion/immutable-ids.mjs';
import { resolveShopId } from '../lib/shop.mjs';

// Moves every stored Graph message id to its immutable id, then switches the
// poller over. Run once. See `ingestion/immutable-ids.mjs` for why the order
// matters: ids first, marker last.
//
//   npm run ids:translate:dry-run   # translate and verify, write nothing
//   npm run ids:translate           # rewrite the ids, then set the marker
//
// STOP THE WORKER FIRST. A poll that runs during the writes stores new mail in
// the old format. The sweep below catches rows that appear during the run, but
// a stopped worker is the real guarantee.
//
// What it writes, in order:
//   1. `graph_message_id` on ticket_messages, spam_audit, categorisation_review;
//   2. `sync_cursors.mail_id_type = 'immutable'` and both mail links dropped,
//      so the next poll does a full read in the new format. Only when step 1
//      finished with no write error; otherwise re-run it.

const dryRun = process.argv.includes('--dry-run');
const VERIFY_PAGES = 4; // ~200 of the newest messages, pages of 50
const WRITE_CONCURRENCY = 8;
const MAX_SWEEPS = 3;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const graph = createGraphClient(config);

  const cursors = (await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors'))[0]?.sync_cursors || {};
  if (cursors[CURSOR_KEYS.idType] === 'immutable') {
    console.log('\nThe stored ids are already immutable (sync_cursors.mail_id_type). Nothing to do.\n');
    return;
  }

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Translating for real. Is the worker stopped?'}\n`);

  const rowsByTable = await loadRows(supabase, shopId);
  const { plan, translated } = await translate(graph, rowsByTable);
  report(rowsByTable, plan);

  if (plan.conflicts.length > 0) {
    console.log('\nConflicts — nothing will be written:');
    for (const conflict of plan.conflicts.slice(0, 20)) console.log(`  ${conflict}`);
    process.exitCode = 1;
    return;
  }

  const proof = await verifyAgainstDelta(graph, rowsByTable.ticket_messages, translated);
  console.log(`\nDelta under IdType="ImmutableId", newest ${proof.read} messages: ` +
    `${proof.equal} match the translation, ${proof.differ} differ.`);
  if (proof.differ > 0 || proof.equal === 0) {
    console.log('The translation is not what the poller would see. Nothing will be written.\n');
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log('\nNothing was written. Re-run without --dry-run to rewrite the ids.\n');
    return;
  }

  let errors = await write(supabase, plan.updates);

  // Rows that arrived while this ran, in the old format.
  for (let sweep = 1; sweep <= MAX_SWEEPS && errors === 0; sweep += 1) {
    const fresh = await loadRows(supabase, shopId);
    const pending = Object.fromEntries(
      Object.entries(fresh).map(([table, rows]) => [table, rows.filter((row) => !plan.attempted.has(row.graph_message_id) && !plan.targets.has(row.graph_message_id))])
    );
    const count = Object.values(pending).reduce((n, rows) => n + rows.length, 0);
    if (count === 0) break;
    console.log(`Sweep ${sweep}: ${count} row(s) appeared during the run.`);
    const next = await translate(graph, pending);
    for (const [source, target] of next.translated) translated.set(source, target);
    for (const target of next.plan.targets) plan.targets.add(target);
    for (const source of next.plan.attempted) plan.attempted.add(source);
    if (next.plan.conflicts.length > 0) {
      console.log('Conflicts in the sweep; the marker is not set. Re-run.');
      process.exitCode = 1;
      return;
    }
    errors += await write(supabase, next.plan.updates);
  }

  if (errors > 0) {
    console.log(`\n${errors} write(s) failed. The marker is NOT set, so the poller keeps REST ids. Re-run.\n`);
    process.exitCode = 1;
    return;
  }

  const latest = (await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors'))[0]?.sync_cursors || {};
  await supabaseUpdateById(supabase, 'shops', shopId, {
    sync_cursors: { ...withoutLinks(latest), [CURSOR_KEYS.idType]: 'immutable' }
  });
  console.log('\nDone. sync_cursors.mail_id_type = immutable; the next poll starts a full read in the new format.\n');
}

async function loadRows(supabase, shopId) {
  const rowsByTable = {};
  for (const table of ID_TABLES) {
    const select = table === 'ticket_messages' ? 'id,graph_message_id,internet_message_id' : 'id,graph_message_id';
    rowsByTable[table] = await supabaseSelectAll(supabase, table, { shop_id: shopId }, select);
  }
  return rowsByTable;
}

async function translate(graph, rowsByTable) {
  const sources = [...new Set(Object.values(rowsByTable).flat().map((row) => row.graph_message_id))];
  const results = sources.length > 0 ? await graph.translateToImmutableIds(sources) : [];
  const translated = new Map(results.filter((r) => r.targetId).map((r) => [r.sourceId, r.targetId]));
  const plan = planIdTranslation(rowsByTable, results);
  plan.targets = new Set(plan.updates.map((u) => u.to));
  // Everything already sent to Graph, translated or not, so a sweep only picks
  // up rows that are genuinely new.
  plan.attempted = new Set(sources);
  return { plan, translated };
}

function report(rowsByTable, plan) {
  for (const table of ID_TABLES) {
    const rows = rowsByTable[table].length;
    const updates = plan.updates.filter((u) => u.table === table).length;
    const failed = plan.failedByTable[table] || 0;
    console.log(`  ${table.padEnd(22)} ${String(rows).padStart(5)} rows · ${String(updates).padStart(5)} to rewrite · ${String(failed).padStart(4)} kept (not translatable)`);
  }
  const codes = Object.entries(plan.failed);
  if (codes.length > 0) {
    console.log(`  not translatable, by Graph's reason: ${codes.map(([code, n]) => `${code} ${n}`).join(', ')}`);
  }
}

async function verifyAgainstDelta(graph, storedMessages, translated) {
  const seen = [];
  let url = null;
  for (let page = 0; page < VERIFY_PAGES; page += 1) {
    const result = await graph.getDeltaPage(url, page === 0 ? { top: 50, immutableIds: true } : { immutableIds: true });
    seen.push(...result.messages);
    if (!result.nextLink) break;
    url = result.nextLink;
  }
  return { read: seen.length, ...compareWithDelta(storedMessages, translated, seen) };
}

async function write(supabase, updates) {
  let errors = 0;
  let done = 0;
  const queue = [...updates];
  async function worker() {
    while (queue.length > 0) {
      const update = queue.shift();
      try {
        await supabaseUpdateById(supabase, update.table, update.id, { graph_message_id: update.to });
      } catch (error) {
        errors += 1;
        console.error(`  ${update.table} ${update.id}: ${error.message}`);
      }
      done += 1;
      if (done % 500 === 0) console.log(`  ${done} / ${updates.length} written`);
    }
  }
  await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, worker));
  console.log(`  ${updates.length - errors} of ${updates.length} rewritten, ${errors} failed.`);
  return errors;
}
