import { createSupabaseClient, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createCaseCurrentStore } from '../casework/case-current-store.mjs';
import { caseStatusRecord, statusFromCase } from '../casework/case-status.mjs';
import { AUTO_CLOSE_EXEMPT_LEVELS } from '../lifecycle/auto-close.mjs';

// What stage 5c would do to the queue: each ticket's status against what its
// `case_current.next_actor` asks for. Reads the folds already stored; folds
// nothing and calls no model.
//
//   npm run case-status            # dry run: the moves, and why the rest stay
//   npm run case-status -- --apply # make the moves
//
// The worker makes the same moves as it folds (case-current-store.mjs); this is
// for seeing them first, and for moving tickets whose fold is not stale.

const apply = process.argv.includes('--apply');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.caseStatusByNextActor) {
    console.log('\nAGENT_CASE_STATUS_BY_NEXT_ACTOR is off: nothing to do.\n');
    return;
  }
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createCaseCurrentStore(supabase, { shopId });

  const [tickets, current] = await Promise.all([
    supabaseSelectAll(
      supabase,
      T.TICKETS,
      { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
      'id,subject,status,resolved_at,level,deleted_at,archived_at,needs_categorisation,needs_investigation,metadata,last_message_at'
    ),
    supabaseSelectAll(supabase, T.CASE_CURRENT, { shop_id: shopId }, 'ticket_id,next_actor,version', { order: 'ticket_id.asc' })
  ]);
  const byTicket = new Map(current.map((row) => [row.ticket_id, row]));

  const reasons = {};
  const moves = [];
  for (const ticket of tickets) {
    const state = byTicket.get(ticket.id);
    const verdict = statusFromCase(ticket, state, { map: config.caseStatusByNextActor, keepOpenLevels: [...AUTO_CLOSE_EXEMPT_LEVELS] });
    reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
    if (verdict.status) moves.push({ ticket, state, to: verdict.status });
  }

  const count = (rows) => rows.reduce((acc, m) => ({ ...acc, [`${m.ticket.status} → ${m.to}`]: (acc[`${m.ticket.status} → ${m.to}`] ?? 0) + 1 }), {});
  const recentSince = Date.now() - 28 * 864e5;
  const recent = moves.filter((m) => Date.parse(m.ticket.last_message_at ?? '') > recentSince);
  console.log(`\n${tickets.length} tickets. Why each stays or moves:`, reasons);
  console.log('Moves:', count(moves));
  console.log('Of which a message in the last 28 days:', count(recent));
  for (const m of recent) {
    console.log(`  ${m.ticket.id.slice(0, 8)}  ${m.ticket.status} → ${m.to}  (next: ${m.state.next_actor})  ${String(m.ticket.subject ?? '').slice(0, 60)}`);
  }

  if (!apply) {
    console.log('\nDry run. `-- --apply` makes these moves.\n');
    return;
  }
  let moved = 0;
  let skipped = 0;
  for (const m of moves) {
    const at = new Date().toISOString();
    const row = await store.setStatus(m.ticket, m.to, caseStatusRecord({ status: m.to, state: m.state, from: m.ticket.status, at }), at);
    if (row) moved += 1;
    else skipped += 1;
  }
  console.log(`\nMoved ${moved}; ${skipped} changed meanwhile and were left.\n`);
}
