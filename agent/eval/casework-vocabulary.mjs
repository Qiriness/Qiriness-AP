import { MISSING_FIELDS } from '../src/investigation/case-file.mjs';
import { NEED_KEYS } from '../src/investigation/evidence-rules.mjs';
import { NEXT_ACTORS as NEXT_ACTOR_KEYS } from '../src/casework/actors.mjs';

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

// The effects live with the Case Manager, which now reads into them too.
export { INBOUND_EFFECTS, OUTBOUND_EFFECTS } from '../src/casework/effects.mjs';
import { INBOUND_EFFECTS, OUTBOUND_EFFECTS } from '../src/casework/effects.mjs';

/**
 * The label schema a page exports under (`labelSchemaVersion`). The export
 * envelope itself stays `version: 1`.
 * - 3 (2026-09-26): obligations with owners, nextActor, and five more customer
 *   questions (postal_address, preferred_remedy, receipt_confirmation,
 *   skin_type, skin_concern).
 * - 4 (2026-09-26): the `holding_reply` next action.
 */
export const LABEL_SCHEMA_VERSION = 4;

/**
 * How a question reads to a LABELLER, where it must say more than the agent's
 * own label. `photo` covers the product OR the relevant area (the eye area in
 * a product-advice thread); the agent's sentence to a customer is unchanged.
 */
const LABELLER_WORDING = {
  photo: 'la photo demandée (produit ou zone concernée)'
};

/** What the customer still owes us: the case file's own question keys. */
export const CUSTOMER_QUESTIONS = Object.fromEntries(
  Object.entries(MISSING_FIELDS).map(([key, field]) => [key, LABELLER_WORDING[key] ?? field.label])
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
 * Who owes an internal check (codex_plans/Case_State_Plan.md, stage 3). The
 * customer's side is `waitingCustomer`; these are ours and our partners'.
 * The words are generic on purpose: which company is a « partner » is the
 * sender directory's business, never this file's.
 */
export const OBLIGATION_OWNERS = {
  support: 'Nous (support)',
  colleague: 'Un collègue',
  // « opérationnel » because sender_directory also has a `partner` label, and
  // there it means a COMMERCIAL partner (a collaboration, a distributor). The
  // key stays `partner` so every stored label keeps working.
  partner: 'Un partenaire opérationnel (3PL, transporteur)'
};

/**
 * Who owes the next step once this message is on the thread. Asked on EVERY
 * cut, outbound included: after we write, somebody still owes something, and
 * « nobody » is the only honest definition of a finished case.
 */
export const NEXT_ACTORS = Object.fromEntries(
  NEXT_ACTOR_KEYS.map((key) => [key, {
    customer: 'Le client',
    support: 'Nous (support)',
    colleague: 'Un collègue',
    partner: 'Un partenaire opérationnel',
    nobody: 'Personne : dossier terminé'
  }[key]])
);

/**
 * Which fields a cut is labelled on, by direction.
 *
 * AN OUTBOUND CUT HAS NO NEXT ACTION AND ANSWERS NOTHING. The first batch showed
 * why: « Réponse complète » under one of our replies was read as describing that
 * reply, three times. After we write, the case state and what we are waiting
 * for say everything the pipeline needs.
 *
 * `obligations` replaced `waitingInternal` on 2026-09-26: the same checks,
 * each with the side that owes it.
 */
export const FIELDS_BY_DIRECTION = {
  inbound: ['effect', 'answered', 'waitingCustomer', 'obligations', 'caseState', 'nextActor', 'nextAction'],
  outbound: ['effect', 'waitingCustomer', 'obligations', 'caseState', 'nextActor']
};

/** The fields without which a cut does not count as labelled. */
export const REQUIRED_BY_DIRECTION = {
  inbound: ['effect', 'caseState', 'nextActor', 'nextAction'],
  outbound: ['effect', 'caseState', 'nextActor']
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
  no_reply_person_acts: "Aucune réponse : une personne doit agir d'abord",
  // Not an answer: « nous avons bien reçu votre message, quelqu'un vérifie et
  // revient vers vous ». Until schema 4 it had to be labelled as one of the two
  // above, and 17 misses in the stage 3 baseline sat in that grey area. When
  // one is due is a rule (codex_plans/Case_State_Plan.md, stage 5), not a
  // labeller's mood.
  holding_reply: "Réponse d'attente : quelqu'un s'en occupe et revient vers le client"
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
    obligations: [],
    caseState: null,
    nextActor: null,
    nextAction: null,
    note: ''
  };
}

/**
 * A label's obligations, reading the pre-2026-09-26 `waitingInternal` list as
 * obligations whose owner nobody has said yet (`owner: null`). Kept so older
 * exports and the checked-in set stay importable; the eval reports the missing
 * owners instead of guessing them.
 */
export function obligationsOf(label) {
  const current = Array.isArray(label?.obligations) ? label.obligations : [];
  const legacy = (Array.isArray(label?.waitingInternal) ? label.waitingInternal : []).map((need) => ({ owner: null, need }));
  return [...current, ...legacy];
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
function pickObligations(obligations, dropped) {
  const seen = new Set();
  const kept = [];
  for (const item of obligations) {
    const need = item?.need;
    const owner = item?.owner ?? null;
    if (!Object.hasOwn(INTERNAL_CHECKS, need)) { dropped.push(`obligations.need=${need}`); continue; }
    if (owner !== null && !Object.hasOwn(OBLIGATION_OWNERS, owner)) { dropped.push(`obligations.owner=${owner}`); continue; }
    const key = `${owner}|${need}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ owner, need });
  }
  return kept;
}

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
      obligations: pickObligations(obligationsOf(label), dropped),
      caseState: pick(label?.caseState, CASE_STATES, 'caseState'),
      nextActor: pick(label?.nextActor, NEXT_ACTORS, 'nextActor'),
      nextAction: applies.has('nextAction') ? pick(label?.nextAction, NEXT_ACTIONS, 'nextAction') : null,
      note: typeof label?.note === 'string' ? label.note.trim() : ''
    },
    dropped
  };
}
