import { MISSING_FIELDS } from '../src/investigation/case-file.mjs';
import { NEED_KEYS } from '../src/investigation/evidence-rules.mjs';

// The closed vocabulary the multi-turn labelled set is written in.
//
// ONE FILE, THREE READERS: the page a person labels on, the builder that
// pre-fills it, and the eval that will score the pipeline against it. A value
// the page offers that the eval does not know would be a label nothing can
// score, so the lists live here and nowhere else.
//
// DECISIONS, NEVER WORDING. Every field is picked from a list. How a reply is
// phrased stays with `draft-checks`; what this set pins is what the pipeline
// should DECIDE at each point in a thread.
//
// SOME VALUES DESCRIBE BEHAVIOUR THAT DOES NOT EXIST YET — checks owed by a
// colleague or a partner, a case closed from our own inbox. That is deliberate:
// the set is the specification, each field is scored separately, and the new
// ones start failing and turn green as they are built.

/** What a message RECEIVED on the thread did to the case. */
export const INBOUND_EFFECTS = {
  continuation: 'Même demande, qui avance',
  // A CHASE IS ITS OWN VALUE because the labeller kept needing it: four notes in
  // the first batch say « relance », filed as continuation twice and as new
  // information twice. It is what the delay apology keys on, and the pipeline
  // reads it as `continuation`.
  chase: 'Relance (même demande, rien de nouveau)',
  new_information: "Apporte un élément (réponse, preuve, correction)",
  new_issue: 'Nouvelle demande dans le même fil',
  closes_case: 'Clôt la demande (merci, reçu, plus besoin)',
  internal_note: 'Échange interne / prestataire, sans le client',
  noise: 'Rien (accusé automatique, doublon, hors sujet)'
};

/** What a message WE SENT did to the case. */
export const OUTBOUND_EFFECTS = {
  answers: 'Répond à la demande',
  asks_customer: 'Demande quelque chose au client',
  holding: 'Fait patienter (vérification en cours)',
  closes_case: 'Clôt le dossier',
  internal_request: 'Demande à un collègue ou à un prestataire'
};

/** What the customer still owes us: the case file's own question keys. */
export const CUSTOMER_QUESTIONS = Object.fromEntries(
  Object.entries(MISSING_FIELDS).map(([key, field]) => [key, field.label])
);

/**
 * What WE, a colleague or a partner still owe the case: the evidence needs.
 *
 * The needs vocabulary rather than a new list, because an internal check that
 * cannot be named as a need is one the investigation could never have asked for
 * — and the need is what the eval will compare against.
 */
export const INTERNAL_CHECKS = Object.fromEntries(NEED_KEYS.map((key) => [key, key]));

/**
 * The checks a colleague or a partner actually answers, shown first.
 *
 * The first batch used two of the twenty-eight needs and left the field empty
 * almost everywhere else; a wall of chips is a field nobody fills. The rest stay
 * one click away rather than removed, so no need becomes unlabellable.
 */
export const COMMON_INTERNAL_CHECKS = [
  'order_state', 'dispatch_state', 'delivery_state', 'refund_state', 'return_eligibility', 'payment_state', 'other_fact'
].filter((key) => Object.hasOwn(INTERNAL_CHECKS, key));

/**
 * Which fields a cut is labelled on, by direction.
 *
 * AN OUTBOUND CUT HAS NO NEXT ACTION AND ANSWERS NOTHING. The first batch showed
 * why: « Réponse complète » under one of our replies was read as describing that
 * reply, three times. After we write, the case state and what we are waiting
 * for say everything the pipeline needs.
 */
export const FIELDS_BY_DIRECTION = {
  inbound: ['effect', 'answered', 'waitingCustomer', 'waitingInternal', 'caseState', 'nextAction'],
  outbound: ['effect', 'waitingCustomer', 'waitingInternal', 'caseState']
};

/** The fields without which a cut does not count as labelled. */
export const REQUIRED_BY_DIRECTION = {
  inbound: ['effect', 'caseState', 'nextAction'],
  outbound: ['effect', 'caseState']
};

export const CASE_STATES = {
  open: 'Ouvert',
  closed_by_customer: 'Clos par le client',
  closed_by_us: 'Clos par nous'
};

/** What the pipeline should do once this message is on the thread. */
export const NEXT_ACTIONS = {
  full_reply: 'Réponse complète',
  closing_reply: 'Courte réponse de clôture',
  no_reply: 'Aucune réponse',
  no_reply_person_acts: "Aucune réponse : une personne doit agir d'abord"
};

/**
 * The shape of one label, with every field present.
 *
 * `answered` mixes the two key spaces on purpose: a message answers whatever it
 * answers, and who was entitled to answer it is the rule the eval checks.
 */
export function emptyLabel() {
  return {
    effect: null,
    answered: [],
    waitingCustomer: [],
    waitingInternal: [],
    caseState: null,
    nextAction: null,
    note: ''
  };
}

/**
 * Keeps only values the vocabulary knows.
 *
 * An exported label is read back from a file a person's browser wrote, so it is
 * checked rather than trusted. A field that does not apply to the direction is
 * emptied and named in `notApplicable`, not reported as an unknown value; an
 * unknown key is dropped and reported, never carried into the checked-in set
 * where nothing could score it.
 */
export function validateLabel(label, { direction }) {
  const effects = direction === 'outbound' ? OUTBOUND_EFFECTS : INBOUND_EFFECTS;
  const answerable = { ...CUSTOMER_QUESTIONS, ...INTERNAL_CHECKS };
  const dropped = [];
  const pick = (value, allowed, field) => {
    if (value === null || value === undefined || value === '') return null;
    if (Object.hasOwn(allowed, value)) return value;
    dropped.push(`${field}=${value}`);
    return null;
  };
  const pickAll = (values, allowed, field) =>
    (Array.isArray(values) ? values : []).filter((value) => {
      if (Object.hasOwn(allowed, value)) return true;
      dropped.push(`${field}=${value}`);
      return false;
    });

  const applies = new Set(FIELDS_BY_DIRECTION[direction === 'outbound' ? 'outbound' : 'inbound']);
  const notApplicable = ['answered', 'nextAction'].filter((field) => {
    const value = label?.[field];
    return !applies.has(field) && (Array.isArray(value) ? value.length > 0 : Boolean(value));
  });

  return {
    notApplicable,
    label: {
      effect: pick(label?.effect, effects, 'effect'),
      answered: applies.has('answered') ? pickAll(label?.answered, answerable, 'answered') : [],
      waitingCustomer: pickAll(label?.waitingCustomer, CUSTOMER_QUESTIONS, 'waitingCustomer'),
      waitingInternal: pickAll(label?.waitingInternal, INTERNAL_CHECKS, 'waitingInternal'),
      caseState: pick(label?.caseState, CASE_STATES, 'caseState'),
      nextAction: applies.has('nextAction') ? pick(label?.nextAction, NEXT_ACTIONS, 'nextAction') : null,
      note: typeof label?.note === 'string' ? label.note.trim() : ''
    },
    dropped
  };
}
