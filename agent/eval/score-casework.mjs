// Scoring for the multi-turn labelled set: what a label says against what
// today's pipeline decides at the same point in the thread.
//
// PURE. The runner reads threads and calls models; this file only compares.
//
// THREE OUTCOMES PER FIELD, NOT TWO. `agree` and `disagree` where the pipeline
// has a value that could match, and `inexpressible` where the label names
// something the pipeline has no word for — a chase it reads as continuation is
// fine, but « internal note » or « no reply, a person acts » it cannot say at
// all. Folding those into `disagree` would make the spec look like a model
// failing; they are work not yet built, and the report keeps them apart.

/**
 * Whether a person actually labelled this cut.
 *
 * The page creates an entry for every cut it renders, pre-filled with the Case
 * Manager's suggestion, so an exported entry is not evidence of a decision. A
 * suggestion left alone with nothing else set is the page's opinion, not the
 * labeller's, and scoring the pipeline against its own suggestion is circular.
 */
export function isTouched(label) {
  if (!label) return false;
  if (label.caseState || label.nextAction || (label.note && label.note.trim())) return true;
  for (const field of ['answered', 'waitingCustomer', 'waitingInternal']) {
    if (Array.isArray(label[field]) && label[field].length > 0) return true;
  }
  return Boolean(label.effect) && !label.fromPrefill;
}

/**
 * The label's effect, in the Case Manager's vocabulary — or null when the
 * pipeline has no value that could match it.
 */
const EFFECT_AS_PIPELINE = {
  continuation: 'continuation',
  chase: 'continuation',
  new_information: 'new_information',
  new_issue: 'new_issue'
};

export function expectedRelationship(effect) {
  return EFFECT_AS_PIPELINE[effect] ?? null;
}

/** The next actions today's pipeline can produce on an inbound message. */
export const PIPELINE_NEXT_ACTIONS = ['full_reply', 'closing_reply', 'no_reply'];

/**
 * What today's pipeline does once an inbound message lands.
 *
 * Mirrors `draftDecision` and the closure step. `gateOpen` is
 * `closureAllowed` on the case file as it stood at that message; where none
 * existed yet — most cuts on this imported corpus — the runner passes `null`
 * and the gate is TAKEN AS OPEN, which is the pipeline's best case. The first
 * run assumed it everywhere and invented a closure on `ea701240`, whose real
 * case file was `needs_customer_input`; so the real one wins where it exists.
 *
 * `sender_label` is the THREAD's opener, not this message's sender — so a
 * colleague writing on a customer's thread is drafted a customer reply. That is
 * what the pipeline does, and scoring it as such is the point.
 */
export function pipelineNextAction({ ticket = {}, closes = false, gateOpen = null } = {}) {
  if (ticket.duplicate_of_ticket_id) return { action: 'no_reply', why: 'doublon lié' };
  if (ticket.sender_label) return { action: 'no_reply', why: 'fil ouvert en interne' };
  if (ticket.level === 4) return { action: 'no_reply', why: 'niveau 4' };
  if (closes && gateOpen !== false) {
    return { action: 'closing_reply', why: gateOpen === null ? 'clôture, porte supposée ouverte' : 'clôture' };
  }
  return { action: 'full_reply', why: closes ? 'clôture lue, porte fermée par le dossier' : null };
}

/** One field's outcome. `expected` null means the label did not set it. */
export function compare(expected, actual, { expressible = true } = {}) {
  if (expected === null || expected === undefined) return 'unlabelled';
  if (!expressible) return 'inexpressible';
  return sameValue(expected, actual) ? 'agree' : 'disagree';
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = [...new Set(a ?? [])].sort();
    const right = [...new Set(b ?? [])].sort();
    return left.length === right.length && left.every((value, i) => value === right[i]);
  }
  return a === b;
}

/** Totals per field over a list of `{ field: outcome }` rows. */
export function tally(rows) {
  const totals = {};
  for (const row of rows) {
    for (const [field, outcome] of Object.entries(row)) {
      totals[field] ??= { agree: 0, disagree: 0, inexpressible: 0, unlabelled: 0 };
      totals[field][outcome] += 1;
    }
  }
  return totals;
}
