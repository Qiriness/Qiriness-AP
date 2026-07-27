// The single support taxonomy, shared by the knowledge library and the ticket
// categoriser. Two consumers, one vocabulary — that shared vocabulary is the whole
// point: a ticket categorised `delivery` filters straight into the `delivery`
// knowledge chunks with no mapping table or string surgery in between.
//
// Two axes, deliberately separate:
//   SUBJECTS      — what the email/article is about. Used by BOTH sides.
//   REQUEST_KINDS — what the sender wants. Tickets only; an article is reference
//                   material, neither a question nor a problem.
//
// So "order_problem" is not a stored value: it is (subject: order, kind: problem).
// Keeping them apart is what lets knowledge stay at 16 categories while tickets
// express every question/problem/contact variant.

/** What the email or article is about. Shared by tickets and knowledge. */
export const SUBJECTS = [
  'order',
  'delivery',
  'return_exchange',
  'product',
  'product_stock',
  'payment',
  'account',
  'promotions',
  'cosmetovigilance',
  'legal_privacy',
  'b2b',
  'partner_collaboration',
  'careers',
  'other'
];

/**
 * Subjects that only ever describe knowledge articles, never an inbound email.
 * Nobody emails support "an FAQ", and brand story is drafting context rather than
 * a request — so these are valid article categories but not ticket subjects.
 */
export const KNOWLEDGE_ONLY_SUBJECTS = ['faq', 'brand_story'];

/** Article categories: every subject, plus the two knowledge-only shapes. */
export const KNOWLEDGE_CATEGORIES = [...SUBJECTS, ...KNOWLEDGE_ONLY_SUBJECTS];

/** Ticket subjects: the shared subjects only. */
export const TICKET_SUBJECTS = SUBJECTS;

/**
 * What the sender wants. Composes with a subject, so a delivery complaint is
 * (delivery, complaint) rather than a separate catch-all "complaints" bucket —
 * which would otherwise overlap every `problem` value and hurt classifier accuracy.
 */
export const REQUEST_KINDS = ['question', 'problem', 'complaint', 'contact'];

/** `contact` only makes sense for the inbound-relationship subjects. */
export const CONTACT_ONLY_SUBJECTS = ['b2b', 'partner_collaboration', 'careers'];

// --- Per-ticket signals -----------------------------------------------------
// Three more things the categoriser reads off the same email, in the same call.
// They are NOT part of the subject/kind taxonomy — they qualify a ticket rather
// than classify it — but they live here because they are enums shared by the
// model schema, the database check constraints and the dashboard, and one list
// per vocabulary is the whole point of this module.

/**
 * How sure the categoriser is of the (subject, kind) pair it just produced.
 * Measured agreement with human labelling on real mail sits near 77% on the
 * subject, so a stored label is not self-evidently right and nothing else in the
 * row says which ones to distrust. Phase 5 gates auto-drafting on `high`.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

/**
 * The language to REPLY in, not a full language-detection vocabulary: the list
 * is what the support desk can actually write back in. Anything else is `other`,
 * which is a routing signal (a human picks it up) rather than a label — silently
 * answering in French because the enum had no better value would be worse than
 * saying "I could not place this one".
 */
export const REPLY_LANGUAGES = ['fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other'];

/**
 * How the customer feels, 1 (happy) to 4 (really unhappy) — same direction as
 * `level`, where 1 is benign and 4 is the one you want to see.
 *
 * Deliberately independent of `level`: level is what WORK the ticket needs, and
 * The level-4 rule exists precisely because conflating "this topic sounds bad" with "this
 * situation is serious" filled the manager queue with routine mail. An angry
 * customer with a simple tracking question is happiness 4, level 2 — both true,
 * neither derived from the other. Consumed by the drafting agent for tone.
 */
export const HAPPINESS_SCORES = [1, 2, 3, 4];

// --- Level derivation -------------------------------------------------------
// Level (1-4) is DERIVED from (subject, kind) rather than guessed independently.
// Two LLM-assigned fields encoding the same "does this need action" axis could
// contradict each other (`order` + `question` + level 3 is incoherent); deriving
// it removes that failure mode and gives the categoriser less to get wrong.
// The model may only escalate above the default — never below (see clampLevel).
//
// LEVEL 4 IS A SEVERITY JUDGEMENT, NOT A SUBJECT. No (subject, kind) pair derives
// it: it is reserved for an explicit threat of legal action or public exposure,
// hospitalisation, or grave injury/danger — so it can only arrive as a model
// escalation, read from what the email actually says, and should be rare. A
// subject-implied 4 would have made "level 4" mean "this topic" instead of "this
// is serious", and drowned the manager queue in routine mail.

const BASE_LEVEL_BY_KIND = {
  question: 1, // answerable from knowledge alone
  problem: 3, // usually needs a state-changing action
  complaint: 3, // dissatisfaction: never auto-handled
  contact: 2 // forward to the responsible team
};

/**
 * Subjects whose answers live in the database rather than the knowledge base.
 * Both questions AND problems about them floor at 2, not 3: measured against
 * human labelling on real mail, most "problems" here ("where is my tracking
 * number?", "my promo code was refused") are answered by looking something up
 * and replying — nothing is changed. Flooring them at 3 made a third of the
 * review set impossible for the categoriser to agree with, because clampLevel
 * cannot go below the floor. The model escalates to 3 itself when the reply
 * requires actually changing something (refund, resend, cancellation, address
 * change), which is the distinction level 3 is defined by.
 */
const LOOKUP_SUBJECTS = new Set([
  'order',
  'delivery',
  'payment',
  'account',
  'product_stock',
  'promotions'
]);

/**
 * The only place a subject changes the floor the kind would give. Keep it small:
 * every entry is a claim that this topic behaves differently from its kind.
 */
const LEVEL_OVERRIDES = {
  // The formulations are natural, so a reported reaction is in practice a mild
  // allergy or irritation — answerable with advice rather than a manager matter.
  // A question is already 1 and a complaint 3 under the generic rules; only the
  // "I reacted to this product" problem is pulled down, from 3 to 2. Genuine
  // severity (hospitalisation, grave injury) reaches 4 through escalation, which
  // is the judgement the email itself supports.
  cosmetovigilance: { problem: 2 }
};

export function defaultLevel(subject, kind) {
  const override = LEVEL_OVERRIDES[subject]?.[kind];
  if (override) {
    return override;
  }
  if (LOOKUP_SUBJECTS.has(subject) && (kind === 'question' || kind === 'problem')) {
    return 2;
  }
  return BASE_LEVEL_BY_KIND[kind] ?? 1;
}

/** The categoriser may raise the derived level but never lower it. */
export function clampLevel(subject, kind, proposedLevel) {
  const floor = defaultLevel(subject, kind);
  const proposed = Number.isInteger(proposedLevel) ? proposedLevel : floor;
  return Math.min(4, Math.max(floor, proposed));
}

/**
 * The same never-lower rule applied over a ticket's LIFE rather than within one
 * call. A thread is re-categorised whenever the customer replies, and the new
 * labels are produced blind — the model does not see the old ones — so without a
 * ratchet a ticket that reached level 3 could silently drop back to 2 on a
 * follow-up that reads calmer ("merci, du coup où en est le remboursement ?").
 *
 * That downgrade is the dangerous direction: the work the ticket earned at 3
 * (a refund, a resend) does not stop being owed because the next email is
 * polite. Levels therefore only ever climb, and a human closing the ticket is
 * what ends it. Escalation still works normally — that is the point of
 * re-categorising at all.
 */
export function ratchetLevel(previousLevel, nextLevel) {
  const previous = Number.isInteger(previousLevel) ? previousLevel : 0;
  const next = Number.isInteger(nextLevel) ? nextLevel : previous;
  return Math.min(4, Math.max(previous, next));
}

// --- Team routing (Phase 5) -------------------------------------------------

const TEAM_BY_SUBJECT = {
  order: 'logistics',
  delivery: 'logistics',
  return_exchange: 'logistics',
  product_stock: 'logistics',
  payment: 'finance',
  b2b: 'finance',
  promotions: 'marketing',
  partner_collaboration: 'marketing',
  careers: 'contact',
  product: 'contact',
  account: 'contact',
  cosmetovigilance: 'contact',
  legal_privacy: 'contact',
  other: 'contact'
};

export function defaultTeam(subject) {
  return TEAM_BY_SUBJECT[subject] || 'contact';
}

// --- Validation -------------------------------------------------------------

export function isSubject(value) {
  return SUBJECTS.includes(value);
}

export function isKnowledgeCategory(value) {
  return KNOWLEDGE_CATEGORIES.includes(value);
}

export function isRequestKind(value) {
  return REQUEST_KINDS.includes(value);
}

export function isConfidence(value) {
  return CONFIDENCE_LEVELS.includes(value);
}

export function isReplyLanguage(value) {
  return REPLY_LANGUAGES.includes(value);
}

export function isHappiness(value) {
  return HAPPINESS_SCORES.includes(value);
}

/** Display label for a ticket's (subject, kind) pair, e.g. "Delivery — problem". */
export function describeTicketCategory(subject, kind) {
  const subjectLabel = String(subject || 'other')
    .split('_')
    .join(' ');
  const label = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);
  return kind ? `${label} — ${kind}` : label;
}
