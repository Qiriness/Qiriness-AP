import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { snoozeDecision } from '../casework/snooze-rule.mjs';
import { AUTO_CLOSE_EXEMPT_LEVELS } from '../lifecycle/auto-close.mjs';

// What AGENT_AUTO_SNOOZE would have done: every ticket whose last message is
// ours, judged as if that message had just been sent (the rule only ever fires
// on a send). Reads the stored folds; writes nothing, calls no model.
//
//   npm run snooze -- --dry-run
//   npm run snooze -- --dry-run --try=customer_reply_wait_days=5   # a delay not saved yet
//
// « Would snooze » counts the tickets the rule would have hidden at the send.
// Those whose deadline has passed since are listed apart: switching the rule on
// does not touch them, since it only fires on a message of ours sent after.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (!process.argv.includes('--dry-run')) {
    console.log('\nRead-only: run with `-- --dry-run`. The worker snoozes when AGENT_AUTO_SNOOZE=true.\n');
    return;
  }
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const [tickets, current, open, parameterRows] = await Promise.all([
    supabaseSelectAll(
      supabase,
      T.TICKETS,
      { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
      'id,subject,status,level,deleted_at,archived_at,needs_categorisation,needs_investigation,overrides,last_message_at'
    ),
    supabaseSelectAll(
      supabase,
      T.CASE_CURRENT,
      { shop_id: shopId },
      'ticket_id,version,last_actor,as_of_message_id,as_of_at,next_actor,obligations',
      { order: 'ticket_id.asc' }
    ),
    // Before migration 54 there is no table, and nothing is snoozed.
    supabaseSelectAll(supabase, T.TICKET_SNOOZES, { shop_id: shopId, woke_at: { operator: 'is', value: 'null' } }, 'id,ticket_id').catch(() => []),
    supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value')
  ]);
  // `--try=key=value`: judge with a delay the shop has not saved, to choose one.
  const tried = process.argv
    .filter((arg) => arg.startsWith('--try='))
    .map((arg) => arg.slice('--try='.length).split('='))
    .map(([parameter_key, value]) => ({ parameter_key, value }));
  const parameters = toParameterMap([...parameterRows.filter((row) => !tried.some((t) => t.parameter_key === row.parameter_key)), ...tried]);
  const stateOf = new Map(current.map((row) => [row.ticket_id, row]));
  const snoozed = new Set(open.map((row) => row.ticket_id));

  const reasons = {};
  const would = [];
  for (const ticket of tickets) {
    const state = stateOf.get(ticket.id);
    if (!state || state.last_actor !== 'support') {
      reasons.last_message_not_ours = (reasons.last_message_not_ours ?? 0) + 1;
      continue;
    }
    // Judged a minute after the send, as the fold would have.
    const sentAt = Date.parse(state.as_of_at ?? '') || Date.now();
    const decision = snoozeDecision({
      ticket,
      state,
      previous: { as_of_message_id: null, next_actor: null },
      openSnooze: snoozed.has(ticket.id) ? { id: 'open' } : null,
      parameters,
      keepOpenLevels: [...AUTO_CLOSE_EXEMPT_LEVELS],
      now: new Date(sentAt + 60_000)
    });
    const key = decision.action === 'snooze' ? `snooze:${decision.waitingFor}` : decision.reason;
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (decision.action === 'snooze') would.push({ ticket, state, decision });
  }

  const now = Date.now();
  const live = would.filter((w) => w.decision.wakeAt.getTime() > now);
  console.log(`\n${tickets.length} tickets. Why each would or would not snooze on its last reply:`, reasons);
  console.log(`Would snooze ${would.length}; ${live.length} of them would still be snoozed today:`);
  for (const w of live) {
    console.log(
      `  ${w.ticket.id.slice(0, 8)}  ${w.ticket.status.padEnd(17)} waiting ${w.decision.waitingFor.padEnd(9)} until ${w.decision.wakeAt.toISOString().slice(0, 16)}  ${String(w.ticket.subject ?? '').slice(0, 60)}`
    );
  }
  const missing = ['customer_reply_wait_days', 'colleague_check_overdue_days', 'partner_check_overdue_days'].filter((key) => !parameters.get(key));
  if (missing.length > 0) console.log(`\nNot set, so never snoozed automatically: ${missing.join(', ')}.`);
  console.log('\nDry run: nothing was written.\n');
}
