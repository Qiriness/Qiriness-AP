import { createHash } from 'node:crypto';

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
 * @param messages  the ticket's messages: { id, direction, actor?, received_at|sent_at }
 * @param readings  ticket_case_state rows: { trigger_message_id, pending_customer_inputs, commitments, contradictions }
 * @param caseFiles ticket_investigations rows: { trigger_message_id, verdict, missing }
 * @param actorFor  message → actor; defaults to the stored actor
 */
export function foldCase({ messages = [], readings = [], caseFiles = [], actorFor = defaultActorFor } = {}) {
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

  const next = nextActorFor({ lastActor, pending });
  const state = {
    as_of_message_id: last?.id ?? null,
    as_of_at: last ? last.received_at ?? last.sent_at ?? null : null,
    last_actor: lastActor,
    pending_customer_inputs: pending,
    commitments: unique(reads.flatMap((row) => row.commitments ?? [])),
    contradictions: unique(reads.flatMap((row) => row.contradictions ?? [])),
    obligations: [],
    next_actor: next,
    resolved: next === 'nobody'
  };
  return { ...state, material_hash: materialHash(state) };
}

/**
 * The hash the version turns on. Only what changes what somebody must do:
 * pending inputs, commitments, contradictions, obligations, the next actor and
 * whether it is resolved. Never timestamps or ids, so a thank-you that changes
 * nothing leaves the version, and any draft written against it, alone.
 */
export function materialHash(state) {
  const material = {
    pending: [...(state.pending_customer_inputs ?? [])].map(String).sort(),
    commitments: (state.commitments ?? []).map((c) => JSON.stringify(c)).sort(),
    contradictions: (state.contradictions ?? []).map((c) => JSON.stringify(c)).sort(),
    obligations: (state.obligations ?? []).map((o) => JSON.stringify(o)).sort(),
    next: state.next_actor ?? null,
    resolved: Boolean(state.resolved)
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

/** The version a new fold gets: the old one when nothing material changed. */
export function nextVersion(previous, folded) {
  if (!previous) return 1;
  return previous.material_hash === folded.material_hash ? previous.version : previous.version + 1;
}
