import { createHash } from 'node:crypto';

import { versionMaterial } from '../../../scripts/lib/ticket-overrides.mjs';

import { workingDaysBetween } from '../lib/working-days.mjs';
import { advanceSequences, sequencesOf, startSequences } from './rule-checks.mjs';

// The current state of a case, folded from what the ticket holds. Stage 4 of
// codex_plans/Case_State_Plan.md.
//
// PURE AND MODEL-FREE. Messages, readings and case files in; a `case_current`
// row out. It is cheap enough to recompute from the start of the thread on
// every event, which is what makes arrival order irrelevant: the fold sorts by
// `received_at` itself, so a late message is simply folded into its place.
//
// WHAT IT CAN SAY TODAY, AND WHAT IT CANNOT. The Case Manager has read only a
// handful of messages (4 readings on 2026-09-26), so the fold leans on who wrote
// last and on the latest case file. Obligations (who owes a check) arrive in
// stage 5; until then « waiting on Deret » and « waiting on us » both read as
// `support`, and nothing uses `next_actor` to move a ticket's status.

/** A message's actor: the stored one, else what direction alone implies. */
export function defaultActorFor(message) {
  if (message?.actor) return message.actor;
  return message?.direction === 'outbound' ? 'support' : 'customer';
}

const timeOf = (message) => {
  const value = Date.parse(message?.received_at ?? message?.sent_at ?? '');
  return Number.isNaN(value) ? 0 : value;
};

/** The thread oldest first; ties keep their stored order. */
export function orderedThread(messages = []) {
  return messages
    .filter((message) => message?.id)
    .map((message, index) => ({ message, index }))
    .sort((a, b) => timeOf(a.message) - timeOf(b.message) || a.index - b.index)
    .map((entry) => entry.message);
}

const fieldsOf = (missing) =>
  (Array.isArray(missing) ? missing : []).map((item) => (typeof item === 'string' ? item : item?.field)).filter(Boolean);

const unique = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Who owes the next step, first rule that applies wins. The order is the one
 * stage 5 will complete with obligations; each rule here is one the labels
 * support (Notes/Labelling_Cheat_Sheet.md, « La suite revient à »).
 *
 * 1. Someone other than us spoke last (the customer, a colleague, an operations
 *    partner): we act — reply, relay, or decide.
 * 2. We spoke last and asked the customer something still unanswered: the
 *    customer.
 * 3. Otherwise nobody owes anything.
 *
 * NOT « the case file says a person must act ». Tried and measured on the 132
 * labelled cuts (`npm run eval:fold`, 2026-09-26): with that rule 74 agree,
 * without it 79. Case files are mostly written at the end of a thread, so the
 * verdict was usually stale by the time our reply had settled it. Who still
 * owes a check is what obligations will say (stage 5).
 */
export function nextActorFor({ lastActor, pending = [] }) {
  if (!lastActor) return null;
  if (lastActor !== 'support') return 'support';
  if (pending.length > 0) return 'customer';
  return 'nobody';
}

/**
 * One message's reading applied to the state before it (stage 5).
 *
 * Questions: those the message answered are struck off; those OUR message
 * asked are added. Checks: those it cleared are fulfilled, those it opened are
 * added as pending. An obligation's id is derived from the message that opened
 * it, so the same thread folds to the same ids every time.
 *
 * @param before  { pending: string[], obligations: [{ id, owner, need, status }], lastSupportAt }
 * @param reading { resolvedInputs, asked, obligationsOpened, obligationsCleared, effect }
 */
export function applyReading(before, reading, { actor, at = null, messageId = null } = {}) {
  const answered = new Set(reading?.resolvedInputs ?? []);
  let pending = (before.pending ?? []).filter((field) => !answered.has(field));
  if (actor === 'support') pending = unique([...pending, ...(reading?.asked ?? [])]);

  const cleared = new Set(reading?.obligationsCleared ?? []);
  const obligations = (before.obligations ?? []).map((o) =>
    cleared.has(o.id) && o.status === 'pending' ? { ...o, status: 'fulfilled', cleared_by: messageId } : o
  );
  (reading?.obligationsOpened ?? []).forEach((o, index) => {
    obligations.push({
      id: `o-${messageId ?? 'x'}-${index}`,
      owner: o.owner,
      need: o.need,
      status: 'pending',
      opened_by: messageId,
      opened_at: at
    });
  });

  return {
    pending,
    obligations,
    lastActor: actor,
    lastEffect: reading?.effect ?? null,
    lastCleared: cleared.size > 0,
    lastAsked: actor === 'support' && ((reading?.asked ?? []).length > 0 || reading?.effect === 'asks_customer'),
    lastAt: at,
    lastSupportAt: actor === 'support' ? at : before.lastSupportAt ?? null
  };
}

/** A reading written by the stage 5 Case Manager, stored or in memory. */
function isStageFiveReading(row) {
  return row?.effect !== undefined && row?.effect !== null;
}

/** A stored row (snake case) or an in-memory reading (camel case), as `applyReading` takes it. */
function readingOf(row) {
  return {
    effect: row.effect ?? null,
    resolvedInputs: row.resolvedInputs ?? row.resolved_inputs ?? [],
    asked: row.asked ?? [],
    obligationsOpened: row.obligationsOpened ?? row.obligations_opened ?? [],
    obligationsCleared: row.obligationsCleared ?? row.obligations_cleared ?? []
  };
}

/**
 * Dashboard actions applied to the obligations: the latest action per check
 * wins, and only a pending check moves.
 */
export function applyActions(obligations = [], actions = []) {
  const latest = new Map();
  for (const row of [...actions].sort((a, b) => String(a.acted_at ?? '').localeCompare(String(b.acted_at ?? '')))) {
    latest.set(row.obligation_id, row);
  }
  return obligations.map((o) => {
    const row = latest.get(o.id);
    if (!row || o.status !== 'pending') return o;
    return { ...o, status: row.action, cleared_by: { kind: 'manual', by: row.acted_by ?? null, at: row.acted_at ?? null } };
  });
}

/**
 * How long each pending check has been open, and whether it is overdue, for
 * the dashboard. An alert only (decided 2026-09-26): nothing reads it to act.
 *
 * @param delays { colleague, partner, support? } working days, null = no alert
 */
export function obligationAges(obligations = [], { now = new Date(), delays = {} } = {}) {
  return obligations.map((o) => {
    if (o.status !== 'pending' || !o.opened_at) return { ...o, workingDaysOpen: null, overdue: false };
    const open = workingDaysBetween(o.opened_at, now);
    const limit = delays[o.owner] ?? null;
    return { ...o, workingDaysOpen: open, overdue: limit !== null && open !== null && open > limit };
  });
}

// Queued rule steps are owed by nobody yet: only a pending check counts.
const openOf = (state) => (state.obligations ?? []).filter((o) => o.status === 'pending');

/**
 * Who owes the next step once readings exist (stage 5). First rule wins.
 *
 * After the CUSTOMER:
 *   - a thank-you (`closes_case`) with nothing owed on either side: nobody; with
 *     our question still open: us (a short closing reply); with a check open:
 *     that check's owner;
 *   - a chase with nothing new, while a colleague's or partner's check is open
 *     and our last message is within the holding interval: that owner (no
 *     reply yet: Notes/Labelling_Cheat_Sheet.md, holding reply);
 *   - otherwise us.
 * After a COLLEAGUE or OPERATIONS PARTNER: us when they settled a check (the
 * customer is owed the result); the owner of a check still open otherwise; us.
 * After US: nobody when we closed and nothing is open; then an open check of
 * ours, then one of a colleague or partner, then the customer's pending
 * question; otherwise nobody.
 *
 * With no reading for the last message the effect is unknown, and this falls
 * back to the stage 4 rule (`nextActorFor`).
 */
export function nextActorAfter(state, { now = null, holdingDays = null } = {}) {
  const actor = state.lastActor;
  if (!actor) return null;
  const open = openOf(state);
  const ours = open.find((o) => o.owner === 'support');
  const theirs = open.find((o) => o.owner !== 'support');
  const effect = state.lastEffect;

  if (actor === 'customer') {
    if (effect === 'closes_case') {
      if (open.length > 0) return (ours ?? theirs).owner;
      return (state.pending ?? []).length > 0 ? 'support' : 'nobody';
    }
    if ((effect === 'chase' || effect === 'continuation') && theirs && holdingDays !== null && state.lastSupportAt) {
      const since = workingDaysBetween(state.lastSupportAt, now ?? state.lastAt);
      if (since !== null && since <= holdingDays) return theirs.owner;
    }
    return 'support';
  }
  if (actor === 'colleague' || actor === 'partner') {
    if (effect === null) return 'support';
    if (state.lastCleared) return 'support';
    return theirs ? theirs.owner : 'support';
  }
  // Us. An unread message of ours (no effect) still leaves the checks and the
  // questions the thread holds: only « we closed it » needs the reading.
  // (Found live 2026-09-27 on 2aa6604e: an open check of ours folded to
  // `nobody` because our last reply had no stage 5 reading.)
  if (effect === 'closes_case' && open.length === 0) return 'nobody';
  // A message that ASKED the customer something hands the next step to them,
  // even with a check of ours still open (the labels, 11 cuts, 2026-09-27).
  if (state.lastAsked && (state.pending ?? []).length > 0) return 'customer';
  if (ours) return 'support';
  if (theirs) return theirs.owner;
  if ((state.pending ?? []).length > 0) return 'customer';
  return 'nobody';
}

/**
 * @param messages  the ticket's messages: { id, direction, actor?, received_at|sent_at }
 * @param readings  ticket_case_state rows: { trigger_message_id, pending_customer_inputs, commitments, contradictions }
 * @param caseFiles ticket_investigations rows: { trigger_message_id, verdict, missing, investigated_at?, check_sequences? }
 * @param actorFor  message → actor; defaults to the stored actor
 */
export function foldCase({
  messages = [],
  readings = [],
  caseFiles = [],
  actorFor = defaultActorFor,
  holdingDays = null,
  now = null,
  // ticket_case_actions rows: { obligation_id, action, acted_by, acted_at }
  actions = [],
  // tickets.overrides: a person's corrections. Only the version fields count.
  overrides = null,
  // tickets.fact_drift: order states that moved under the latest case file
  // (change-router.mjs). Only what moved and against which case file count.
  factDrift = null
} = {}) {
  const thread = orderedThread(messages);
  const position = new Map(thread.map((message, index) => [message.id, index]));
  const at = (row) => position.get(row?.trigger_message_id);
  const inThread = (rows) => rows.filter((row) => at(row) !== undefined).sort((a, b) => at(a) - at(b));

  const last = thread.at(-1) ?? null;
  const lastActor = last ? actorFor(last) : null;
  const reads = inThread(readings);
  const files = inThread(caseFiles);
  const reading = reads.at(-1) ?? null;
  const caseFile = files.at(-1) ?? null;

  // WHAT WE ARE WAITING FOR FROM THE CUSTOMER. The newer of two sources wins:
  // the latest reading (which already struck off what the customer answered),
  // or the latest case file's missing fields — which count only once one of
  // our messages follows it, because a question is pending when it has been
  // ASKED, not when a case file decided it would be.
  let pending = [];
  const askedAfter = (index) => thread.some((message, i) => i > index && actorFor(message) === 'support');
  if (reading && (!caseFile || at(reading) >= at(caseFile))) {
    pending = [...(reading.pending_customer_inputs ?? [])];
  } else if (caseFile?.verdict === 'needs_customer_input' && askedAfter(at(caseFile))) {
    pending = fieldsOf(caseFile.missing);
  }
  pending = unique(pending);

  let next = nextActorFor({ lastActor, pending });
  let obligations = [];

  // STAGE 5: WALK THE THREAD WHEN READINGS CARRY THE NEW FIELDS, OR A CASE FILE
  // SELECTED A RULE THAT OPENS CHECKS. One timeline: each message with its
  // reading, each case file's rule steps just after the message it was written
  // on, and each dashboard action at its time. Readings from before stage 5 have
  // no `effect`; a thread made only of those, with no rule checks, folds
  // exactly as stage 4 did.
  const stageFive = reads.some(isStageFiveReading);
  const ruleFiles = files.filter((file) => sequencesOf(file).length > 0);
  if (stageFive || ruleFiles.length > 0) {
    const byTrigger = new Map(stageFive ? reads.map((row) => [row.trigger_message_id, row]) : []);
    const filesAt = new Map();
    for (const file of ruleFiles) filesAt.set(file.trigger_message_id, [...(filesAt.get(file.trigger_message_id) ?? []), file]);
    // WHAT A PERSON DID IN THE DASHBOARD settles a check whatever the thread
    // says: work done by phone or in Shopify leaves no email to read. In time
    // order, so « Mark done » on step 1 opens step 2 from that moment.
    const queue = [...actions].sort((a, b) => String(a.acted_at ?? '').localeCompare(String(b.acted_at ?? '')));
    let sequences = [];
    let walk = { pending: [], obligations: [], lastSupportAt: null };
    const settle = (until) => {
      while (queue.length > 0 && (until === null || Date.parse(queue[0].acted_at ?? '') < until)) {
        const action = queue.shift();
        walk = { ...walk, obligations: advanceSequences(applyActions(walk.obligations, [action]), sequences, { at: action.acted_at ?? null }) };
      }
    };
    for (const message of thread) {
      const actor = actorFor(message);
      const when = message.received_at ?? message.sent_at ?? null;
      settle(timeOf(message));
      const row = byTrigger.get(message.id);
      walk = row
        ? applyReading(walk, readingOf(row), { actor, at: when, messageId: message.id })
        : {
            ...walk,
            lastActor: actor,
            lastEffect: null,
            lastCleared: false,
            lastAsked: false,
            lastAt: when,
            lastSupportAt: actor === 'support' ? when : walk.lastSupportAt
          };
      for (const file of filesAt.get(message.id) ?? []) {
        const started = startSequences(walk.obligations, file, { at: file.investigated_at ?? when });
        sequences = [...sequences, ...started.sequences];
        walk = { ...walk, obligations: started.obligations };
      }
      walk = { ...walk, obligations: advanceSequences(walk.obligations, sequences, { at: when }) };
    }
    settle(null);
    // Without stage 5 readings, what we wait on from the customer is stage 4's.
    if (!stageFive) walk = { ...walk, pending };
    pending = walk.pending;
    obligations = walk.obligations;
    next = nextActorAfter(walk, { now, holdingDays });
  }

  const state = {
    as_of_message_id: last?.id ?? null,
    as_of_at: last ? last.received_at ?? last.sent_at ?? null : null,
    last_actor: lastActor,
    pending_customer_inputs: pending,
    commitments: unique(reads.flatMap((row) => row.commitments ?? [])),
    contradictions: unique(reads.flatMap((row) => row.contradictions ?? [])),
    obligations,
    next_actor: next,
    resolved: next === 'nobody'
  };
  return { ...state, material_hash: materialHash(state, versionMaterial(overrides), driftMaterial(factDrift)) };
}

/**
 * The part of a drift the version turns on: which states moved, and against
 * which case file. Never `checked_at`, so the router re-finding the same drift
 * on the next poll moves nothing. Null when there is none.
 */
export function driftMaterial(factDrift) {
  if (!factDrift?.changed || Object.keys(factDrift.changed).length === 0) return null;
  const changed = Object.keys(factDrift.changed)
    .sort()
    .map((key) => [key, factDrift.changed[key]?.from ?? null, factDrift.changed[key]?.to ?? null]);
  return { changed, case_file_at: factDrift.case_file_at ?? null };
}

/**
 * The hash the version turns on. Only what changes what somebody must do:
 * pending inputs, commitments, contradictions, obligations, the next actor and
 * whether it is resolved. Never timestamps or ids, so a thank-you that changes
 * nothing leaves the version, and any draft written against it, alone.
 */
export function materialHash(state, overrides = null, drift = null) {
  const material = {
    pending: [...(state.pending_customer_inputs ?? [])].map(String).sort(),
    commitments: (state.commitments ?? []).map((c) => JSON.stringify(c)).sort(),
    contradictions: (state.contradictions ?? []).map((c) => JSON.stringify(c)).sort(),
    obligations: (state.obligations ?? []).map((o) => JSON.stringify(o)).sort(),
    next: state.next_actor ?? null,
    resolved: Boolean(state.resolved),
    // A PERSON'S CORRECTION MOVES THE CASE: a new situation, subject or level
    // changes what the reply must say, so drafts written before it go stale and
    // the pre-send check refuses them (`case_moved`). ADDED ONLY WHEN PRESENT:
    // a key on every ticket would change every hash and stale every draft.
    ...(overrides ? { overrides } : {}),
    // A FACT THE CASE FILE WAS DECIDED ON MOVED (DECISIONS § Change router): the
    // reply must say something else, so drafts written before it go stale and
    // the pre-send check refuses them. Added only when present, like overrides.
    ...(drift ? { drift } : {})
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

/** The version a new fold gets: the old one when nothing material changed. */
export function nextVersion(previous, folded) {
  if (!previous) return 1;
  return previous.material_hash === folded.material_hash ? previous.version : previous.version + 1;
}
