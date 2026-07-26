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

// --- Level derivation -------------------------------------------------------
// Level (1-4) is DERIVED from (subject, kind) rather than guessed independently.
// Two LLM-assigned fields encoding the same "does this need action" axis could
// contradict each other (`order` + `question` + level 3 is incoherent); deriving
// it removes that failure mode and gives the categoriser less to get wrong.
// The model may only escalate above the default — never below (see clampLevel).

const BASE_LEVEL_BY_KIND = {
  question: 1, // answerable from knowledge alone
  problem: 3, // usually needs a state-changing action
  complaint: 3, // dissatisfaction: never auto-handled
  contact: 2 // forward to the responsible team
};

/** Questions about these need a data lookup before they can be answered → level 2. */
const LOOKUP_SUBJECTS = new Set(['order', 'delivery', 'payment', 'account', 'product_stock']);

/** Adverse-reaction reports are always level 4, whatever the kind. Non-negotiable. */
const ALWAYS_SENSITIVE = new Set(['cosmetovigilance']);

export function defaultLevel(subject, kind) {
  if (ALWAYS_SENSITIVE.has(subject)) {
    return 4;
  }
  // A privacy/legal *action* (erasure, data access) is sensitive; asking how the
  // policy works is not.
  if (subject === 'legal_privacy' && (kind === 'problem' || kind === 'complaint')) {
    return 4;
  }
  const base = BASE_LEVEL_BY_KIND[kind] ?? 1;
  if (kind === 'question' && LOOKUP_SUBJECTS.has(subject)) {
    return 2;
  }
  return base;
}

/** The categoriser may raise the derived level but never lower it. */
export function clampLevel(subject, kind, proposedLevel) {
  const floor = defaultLevel(subject, kind);
  const proposed = Number.isInteger(proposedLevel) ? proposedLevel : floor;
  return Math.min(4, Math.max(floor, proposed));
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

/** Display label for a ticket's (subject, kind) pair, e.g. "Delivery — problem". */
export function describeTicketCategory(subject, kind) {
  const subjectLabel = String(subject || 'other')
    .split('_')
    .join(' ');
  const label = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);
  return kind ? `${label} — ${kind}` : label;
}
