import { NEXT_ACTORS } from './actors.mjs';

// The ticket's status, from who acts next. Stage 5c of
// codex_plans/Case_State_Plan.md (Q10).
//
// `case_current.next_actor` is the source of truth (Q8); the status is how the
// queue shows it. No new statuses: a colleague and an operations partner both
// read `awaiting_human`, and the ticket page shows which one.
//
// EACH ACTOR ACCEPTS A LIST, AND THE FIRST IS WHERE A TICKET MOVES. A ticket
// already on any listed status is left alone. That is what keeps « our turn »
// two statuses: `open`, and `awaiting_human` where the investigation handed the
// case to a person. Auto-close exempts `awaiting_human` (auto-close.mjs), so
// folding it back to `open` would let four weeks of silence close work nobody
// did. Measured on the live queue 2026-09-27: 15 such tickets.
//
// ONLY WHAT THE AGENT OWNS IS REWRITTEN. A person can set `open`, `resolved` and
// `closed` from the dashboard; `closed` is also auto-close's, `forwarded` the
// forwarding pass's, `spam` the filter's. So this moves a ticket between `open`,
// `awaiting_customer` and `awaiting_human`, and to `resolved` when nobody owes
// anything. It moves a `resolved` ticket back only when the fold itself resolved
// it: the `resolved_at` recorded in `metadata.case_status` is the proof. A
// person's resolve carries no such record and is never undone here; the
// customer writing again reopens it at ingestion, as before.
//
// A TICKET THE PIPELINE STILL OWES A PASS STAYS OPEN. The categoriser and the
// investigation claim only `status = 'open'`, so moving a flagged ticket out of
// open would strand it (ticket-writer.mjs, « Stranded, silently, forever »).

/** next_actor → accepted statuses, the first being the one to move to. */
export const DEFAULT_STATUS_BY_NEXT_ACTOR = Object.freeze({
  customer: Object.freeze(['awaiting_customer']),
  support: Object.freeze(['open', 'awaiting_human']),
  colleague: Object.freeze(['awaiting_human']),
  partner: Object.freeze(['awaiting_human']),
  nobody: Object.freeze(['resolved'])
});

/** The statuses this may move a ticket out of, besides a `resolved` it set itself. */
export const CASE_MANAGED_STATUSES = Object.freeze(['open', 'awaiting_customer', 'awaiting_human']);

/** The statuses this may move a ticket to. */
const TARGETS = Object.freeze([...CASE_MANAGED_STATUSES, 'resolved']);

/**
 * `AGENT_CASE_STATUS_BY_NEXT_ACTOR`: `off`, or `nobody:open,support:open|awaiting_human`
 * over the default. Null means off: the fold then writes `case_current` only.
 * An unknown actor or a status this may not set is refused, not guessed at.
 */
export function parseCaseStatusMap(text) {
  const raw = String(text ?? '').trim();
  if (raw.toLowerCase() === 'off') return null;
  const map = { ...DEFAULT_STATUS_BY_NEXT_ACTOR };
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const [actor, statuses] = part.split(':').map((value) => value?.trim());
    if (!actor || !statuses) continue;
    if (!NEXT_ACTORS.includes(actor)) {
      throw new Error(`AGENT_CASE_STATUS_BY_NEXT_ACTOR: "${actor}" is not a next actor (${NEXT_ACTORS.join(', ')}).`);
    }
    const list = statuses.split('|').map((value) => value.trim()).filter(Boolean);
    const bad = list.find((status) => !TARGETS.includes(status));
    if (bad || list.length === 0) {
      throw new Error(`AGENT_CASE_STATUS_BY_NEXT_ACTOR: "${bad ?? statuses}" is not a status the fold may set (${TARGETS.join(', ')}).`);
    }
    map[actor] = list;
  }
  return map;
}

/**
 * The status the case asks for, or `{ status: null, reason }` when it must not move.
 *
 * @param ticket  `{ status, resolved_at, level, deleted_at, archived_at,
 *                  needs_categorisation, needs_investigation, metadata }`
 * @param state   the `case_current` row: `{ next_actor, version }`
 * @param map     next_actor → accepted statuses (`parseCaseStatusMap`)
 * @param keepOpenLevels levels the fold never resolves: a person closes those
 */
export function statusFromCase(ticket, state, { map = DEFAULT_STATUS_BY_NEXT_ACTOR, keepOpenLevels = [] } = {}) {
  if (!ticket || !state) return { status: null, reason: 'no_case' };
  if (ticket.deleted_at || ticket.archived_at) return { status: null, reason: 'archived' };
  const current = ticket.status ?? null;

  const ownResolve =
    current === 'resolved' &&
    ticket.metadata?.case_status?.status === 'resolved' &&
    sameInstant(ticket.metadata.case_status.resolved_at, ticket.resolved_at);
  if (!CASE_MANAGED_STATUSES.includes(current) && !ownResolve) return { status: null, reason: 'not_ours' };

  let accepted = map[state.next_actor] ?? [];
  if (accepted.includes('resolved') && keepOpenLevels.includes(Number(ticket.level))) {
    accepted = ['open', 'awaiting_human'];
  }
  if (accepted.length === 0) return { status: null, reason: 'unmapped' };
  if (accepted.includes(current)) return { status: null, reason: 'unchanged' };

  if (current === 'open' && (ticket.needs_categorisation || ticket.needs_investigation)) {
    return { status: null, reason: 'pass_pending' };
  }
  return { status: accepted[0], reason: 'next_actor' };
}

/** Postgres returns `+00:00` where the record holds `.000Z`: compare instants, not strings. */
function sameInstant(a, b) {
  const x = Date.parse(a ?? '');
  return !Number.isNaN(x) && x === Date.parse(b ?? '');
}

/** The `metadata.case_status` record written with a move: what the fold set, from what. */
export function caseStatusRecord({ status, state, from, at }) {
  return {
    status,
    from,
    next_actor: state.next_actor,
    version: state.version ?? null,
    at,
    resolved_at: status === 'resolved' ? at : null
  };
}
