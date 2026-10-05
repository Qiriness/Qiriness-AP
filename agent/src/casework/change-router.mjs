import { needsNamedBy, selectAnswer } from '../investigation/answer-selection.mjs';
import { TOOL_NAMES } from '../investigation/investigation-rules.mjs';
import { ORDER_STATE_KEYS } from '../investigation/order-states-at.mjs';

// What a change means for a ticket, decided in code. DECISIONS § Change router.
//
// REFRESH BROADLY, RE-INVESTIGATE NARROWLY, REDRAFT STALE ANSWERS. The order
// copy is rebuilt whenever Shopify has a newer version (order-context-runner);
// this module decides what that new copy, or the passing of time, means for the
// reply we owe. Four outcomes, cheapest first:
//
//   none           nothing the case was decided on, or the reply relies on, moved
//   redraft        the rule still holds; a fact the reply states moved
//   reinvestigate  the rule the case file followed would no longer be chosen
//
// and waking, which stays where it already is: new mail, the snooze deadline,
// and the webhook's partner wake on an order update (snooze-order-wake.mjs).
//
// NO MODEL. The investigation stores the findings its rule was chosen on and
// the rule it chose (`exemplar_match.policy`), and `selectAnswer` is pure: swap
// the new states in, choose again, compare. The Case Manager reads messages; an
// order state is a fact with one right value (the same reasoning as DECISIONS
// § Human overrides).
//
// ONLY WHEN WE OWE THE NEXT STEP. Once our reply has gone and the case waits on
// the customer, a colleague or a partner, a change does nothing but refresh the
// copy: the customer's reply re-investigates anyway, and a colleague's or a
// person's reply is most likely a closing one, so working ahead of it is spent
// for nothing.
//
// `awaiting_human` IS REDRAFTED, NEVER RE-INVESTIGATED (decided with the owner,
// 2026-10-04). The agent handed the case to a person, and drafting still writes
// them a draft to review; leaving « pas encore expédiée » in front of them after
// the parcel left is the stale output this exists to stop. A new investigation
// would reopen the status and take the case back from the person, so a moved
// rule is downgraded to a redraft and named (`…:held_for_person`). The router
// therefore never reopens an `awaiting_*` status.

/**
 * The triggers that re-investigate whatever changed, written down here so the
 * table is one table. Their writers predate the router and are not routed
 * through it: `ticket-record.mjs` (new message), `reinvestigationColumns`
 * (order linked), `ticket-overrides.mjs` (a person's correction).
 */
export const ALWAYS_REINVESTIGATE = Object.freeze(['new_message', 'order_linked', 'correction']);

export const OUTCOMES = Object.freeze(['none', 'redraft', 'reinvestigate']);

/** The statuses the router acts on: ours to draft, and ours held for a person. */
export const ROUTED_STATUSES = Object.freeze(['open', 'awaiting_human']);

/**
 * The established claims that rest on the order bundle alone: every evidence id
 * is a `getOrderContext` call. A claim that also cites another tool is kept —
 * the other half of it may still hold, and dropping it would lose that.
 */
export function orderSourcedClaims(investigation) {
  const calls = new Set(
    (Array.isArray(investigation?.tool_calls) ? investigation.tool_calls : [])
      .filter((call) => call?.tool === TOOL_NAMES.GET_ORDER_CONTEXT)
      .map((call) => call.id)
      .filter(Boolean)
  );
  if (calls.size === 0) return [];
  return (Array.isArray(investigation?.established) ? investigation.established : []).filter((claim) => {
    const ids = Array.isArray(claim?.evidence_ids) ? claim.evidence_ids : [];
    return ids.length > 0 && ids.every((id) => calls.has(id));
  });
}

/**
 * The order states the case file was decided on: the last findings the run
 * recorded (`findings_trace`, which carries the whole vector), else the
 * findings the rule was chosen on. Only the order-state keys, only where a
 * value was recorded.
 */
export function statesSeen(investigation) {
  const trace = Array.isArray(investigation?.findings_trace) ? investigation.findings_trace : [];
  const source = trace.at(-1)?.findings ?? investigation?.exemplar_match?.policy?.findings ?? null;
  if (!source || typeof source !== 'object') return null;
  const seen = {};
  for (const key of ORDER_STATE_KEYS) if (source[key] !== undefined) seen[key] = source[key];
  return Object.keys(seen).length > 0 ? seen : null;
}

/**
 * `{ state: { from, to } }` for every recorded state now reading otherwise.
 *
 * A MOVE TO `unknown` IS NOT A CHANGE. `unknown` is « could not tell », not a
 * fact: a parameter that failed to load or was unset since turns every time
 * state into it, and acting on that would redraft every open case for knowing
 * less. A move FROM `unknown` is information, and counts.
 */
export function changedStates(seen, now) {
  const changed = {};
  if (!seen || !now) return changed;
  for (const key of ORDER_STATE_KEYS) {
    if (seen[key] === undefined || now[key] === undefined || now[key] === 'unknown') continue;
    if (seen[key] !== now[key]) changed[key] = { from: seen[key], to: now[key] };
  }
  return changed;
}

/**
 * Would the rules choose differently on the new states?
 *
 * One selection per request (`per_request` on a multi-request ticket), each
 * replayed against its own answer set and situation. `undefined` when it cannot
 * be told: no stored selection, or an answer set that did not load.
 */
export function decisionMoved({ policy, answersBySet, statesNow, changed }) {
  if (!policy?.answer_set) return undefined;
  const selections = Array.isArray(policy.per_request) && policy.per_request.length > 0 ? policy.per_request : [policy];
  const patch = {};
  for (const key of Object.keys(changed)) patch[key] = statesNow[key];
  const findings = { ...(policy.findings ?? {}), ...patch };
  let moved = false;
  const named = new Set();
  for (const selection of selections) {
    const answers = answersBySet?.get(selection.answer_set);
    if (!answers) return undefined;
    for (const need of needsNamedBy(answers)) named.add(need);
    const result = selectAnswer(answers, findings, { situationKey: selection.situation_key ?? null });
    const key = result.answer?.answerKey ?? null;
    if (key !== (selection.answer_key ?? null)) moved = true;
    // A lone selection also carries its verdict: « ambiguous » becoming
    // « selected » is a different case file even when no key changes hands.
    if (selection === policy && policy.verdict && result.verdict !== policy.verdict) moved = true;
  }
  return { moved, named };
}

/**
 * The decision for one ticket.
 *
 * @param ticket        `{ status, needs_investigation, needs_categorisation, shopify_order_number }`
 * @param caseCurrent   `{ next_actor }`, or null before the first fold
 * @param investigation the ticket's latest case file row
 * @param statesNow     `orderStatesAt(bundle, parameters, now)`
 * @param answersBySet  `Map(answer_set → answers)`, `answerFromRow` shape
 * @returns {{ outcome, reason, changed }}
 */
export function routeChange({ ticket, caseCurrent, investigation, statesNow, answersBySet }) {
  const none = (reason, changed = {}) => ({ outcome: 'none', reason, changed });
  const heldForPerson = ticket?.status === 'awaiting_human';
  const reinvestigate = (reason, changed) =>
    heldForPerson
      ? { outcome: 'redraft', reason: `${reason}:held_for_person`, changed }
      : { outcome: 'reinvestigate', reason, changed };

  if (!ROUTED_STATUSES.includes(ticket?.status)) return none('not_open');
  // A pass already queued will read the fresh copy itself.
  if (ticket.needs_categorisation || ticket.needs_investigation) return none('pass_pending');
  if (caseCurrent?.next_actor !== 'support') return none('not_our_turn');
  if (!investigation) return none('no_case_file');
  if (!statesNow) return none('no_order_context');
  // A different order than the case file ran on is the linker's to queue
  // (`reinvestigationColumns`), never a state change of the same order.
  const ranOn = investigation.context_ref?.orderName ?? null;
  if (ranOn !== (ticket.shopify_order_number ?? null)) return none('order_relinked');

  const changed = changedStates(statesSeen(investigation), statesNow);
  if (Object.keys(changed).length === 0) return none('unchanged');

  const decision = decisionMoved({
    policy: investigation.exemplar_match?.policy ?? null,
    answersBySet,
    statesNow,
    changed
  });

  // NO STORED SELECTION TO REPLAY. The verdict was the model's own, so whether
  // it still holds cannot be computed. Whether the order is still on its way, has
  // arrived or was cancelled changes what any reply about it says; the other
  // states change what it states, not what it decides.
  if (decision === undefined) {
    if (changed.order_state) return reinvestigate('order_state_without_rule', changed);
  } else if (decision.moved) {
    return reinvestigate('rule_changed', changed);
  }

  // THE RULE HOLDS. Redraft only when the reply rests on what moved: the case
  // file states an order fact, or a rule in its set reads one of the states.
  const reliesOnOrder = orderSourcedClaims(investigation).length > 0;
  const readByRules = decision ? Object.keys(changed).some((key) => decision.named.has(key)) : false;
  if (reliesOnOrder || readByRules) return { outcome: 'redraft', reason: 'facts_changed', changed };
  return none('irrelevant', changed);
}

/**
 * The record a routed change leaves on the ticket (`tickets.fact_drift`).
 *
 * `case_file_at` ties it to the case file it was measured against: the drift is
 * « these states moved since THAT case file ». The fold hashes `changed` and
 * `case_file_at` (case-fold.mjs), so a drift raises the case version once.
 */
export function factDrift({ changed, outcome, reason, investigation, at }) {
  return {
    changed,
    outcome,
    reason,
    case_file_at: investigation?.investigated_at ?? null,
    checked_at: at
  };
}

/** Whether `next` says anything `stored` does not. Idempotence: the same drift is never written twice. */
export function driftDiffers(stored, next) {
  if (!stored) return true;
  return (
    stored.case_file_at !== next.case_file_at ||
    stored.outcome !== next.outcome ||
    canonical(stored.changed) !== canonical(next.changed)
  );
}

/** Whether the drift was measured against a case file at least as new as this one. */
export function driftCurrentFor(drift, investigation) {
  if (!drift?.case_file_at || !investigation?.investigated_at) return false;
  return Date.parse(drift.case_file_at) >= Date.parse(investigation.investigated_at);
}

function canonical(changed) {
  const entries = Object.entries(changed ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries.map(([key, value]) => [key, value?.from ?? null, value?.to ?? null]));
}

// --- Refund notice (DECISIONS § Refund notice) ------------------------------
//
// A MESSAGE WE SEND UNASKED. Every other path here answers the customer; this
// one tells them something they did not ask about: a refund recorded in Shopify
// that no message of ours has reported. It ignores the gates above on purpose —
// the refund usually lands after our last reply, when the case is waiting on
// nobody or already closed.
//
// WHICH RULE, AND FOR WHICH TICKETS, IS DATA. `support_answers.notify_on` marks
// the template; its answer set is the scope (a ticket qualifies when its
// category or second subject maps to that set). The window is the shop's
// `refund_notice_window_days`. Unset either way, nothing happens.

/** The events a rule may be the template for (72_refund_notice.sql); one list, shared with the rule editor. */
export { NOTICE_EVENTS } from '../../../scripts/lib/notice-events.mjs';

/** What a draft is for (72_refund_notice.sql). */
export const DRAFT_PURPOSES = Object.freeze(['reply', 'refund_notice']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a refund notice is due on this ticket, and for which refunds.
 *
 * A refund counts when it was created:
 *   - after the ticket's first message (one from before is not news to this case);
 *   - after our last message on the case (we have not told them since);
 *   - within `windowDays` of the ticket's last message (still about this ticket).
 * Due only when one of those is not already in the recorded notice: the same
 * refunds are never noticed twice, a later refund is.
 *
 * @param inScope        the ticket's subject maps to the template's answer set
 * @param refunds        `orders.refunds`: `[{ id, created_at }]`
 * @param firstMessageAt the ticket's first message
 * @param lastMessageAt  the ticket's last message, either direction
 * @param lastOutboundAt our last message on the case, or null
 * @param windowDays     `refund_notice_window_days`; null switches it off
 * @param recorded       the notice already recorded (`fact_drift.notice`), or null
 * @returns `{ refund_ids }` (every untold refund, sorted) or null
 */
export function noticeDue({ inScope, refunds, firstMessageAt, lastMessageAt, lastOutboundAt = null, windowDays, recorded = null }) {
  if (!inScope || !Number.isInteger(windowDays) || windowDays < 0) return null;
  const first = Date.parse(firstMessageAt ?? '');
  const last = Date.parse(lastMessageAt ?? '');
  const told = Date.parse(lastOutboundAt ?? '');
  if (!Number.isFinite(last)) return null;
  const untold = (Array.isArray(refunds) ? refunds : [])
    .filter((refund) => {
      const at = Date.parse(refund?.created_at ?? '');
      if (!refund?.id || !Number.isFinite(at)) return false;
      if (Number.isFinite(first) && at <= first) return false;
      if (Number.isFinite(told) && at <= told) return false;
      return at - last <= windowDays * DAY_MS;
    })
    .map((refund) => refund.id)
    .sort();
  if (untold.length === 0) return null;
  const already = new Set(recorded?.refund_ids ?? []);
  if (untold.every((id) => already.has(id))) return null;
  return { refund_ids: untold };
}

/**
 * The notice recorded on the ticket (`fact_drift.notice`). `recorded_at` is the
 * moment it was found: the fold keeps the case on us until a message of ours is
 * newer than it (case-fold.mjs).
 */
export function noticeRecord({ event = 'refund_recorded', refundIds, template, at }) {
  return {
    event,
    refund_ids: refundIds,
    answer_set: template.answer_set,
    answer_key: template.answer_key,
    recorded_at: at
  };
}
