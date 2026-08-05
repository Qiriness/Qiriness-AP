// The investigation guidelines — what a well-investigated ticket of each shape
// contains, which tools may be used to get there, and what escalates.
//
// Pure policy, no I/O, in the same spirit as `retrieval-rules.mjs` (which
// categories to search) and `forward-rules.mjs` (who qualifies): the decisions
// live in a module that can be reasoned about and tested on its own, and the
// runner is left with orchestration.
//
// GUARDRAILS VERSUS GUIDELINES, since this file holds one and not the other.
// `allowedTools()` here is a GUARDRAIL: it decides what exists for a ticket, and
// the model is never shown anything outside it. The rest — the evidence
// checklist, the opening moves — are GUIDELINES: the prompt states them, and the
// runner checks the result against them afterwards. Neither is trusted alone.
//
// Why a code module rather than a table the team edits: these are behavioural
// rules with test coverage, and the taxonomy they key on (`support-taxonomy.mjs`)
// is already code. A DB-backed override can be added later if the team
// demonstrably wants to tune one without a deploy; until then a second source of
// truth would only be able to disagree with this one.

import { TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

/**
 * The tools an investigation can be given. Names are the contract with
 * `tool-registry.mjs`, which supplies the implementations — the policy of which
 * subject may use what lives here, so the list exists once.
 */
export const TOOL_NAMES = {
  SEARCH_KNOWLEDGE: 'searchKnowledge',
  LOOKUP_CUSTOMER: 'lookupCustomer',
  LOOKUP_PRODUCT: 'lookupProduct',
  LOOKUP_STOCK: 'lookupStock',
  EXTRACT_PROMOTION_CODES: 'extractPromotionCodes',
  LOOKUP_PROMOTION: 'lookupPromotion',
  LIST_ACTIVE_PROMOTIONS: 'listActivePromotions',
  GET_ORDER_CONTEXT: 'getOrderContext'
};

const T = TOOL_NAMES;

/**
 * Subjects the agent actually investigates today.
 *
 * The order family is deliberately absent, and not because it does not matter —
 * it is 52% of the corpus. Supabase holds the dev store (12 orders, #1001-#1012)
 * while the mail quotes #4854 and #6216, so an investigation of a delivery
 * ticket could only ever conclude "no such order". Its rules and its tools are
 * defined below and tested; enabling them is one edit to this array once real
 * orders are synced.
 */
export const ENABLED_SUBJECTS = ['product', 'product_stock', 'promotions', 'account', 'other'];

/**
 * Which tools each subject may use.
 *
 * THE EMPTY SETS ARE THE INTERESTING ONES, and each is empty for its own reason:
 *
 * - `cosmetovigilance` — a reported adverse reaction is the one subject where
 *   assembling a confident-looking answer is worse than assembling nothing. It
 *   goes to a person untouched. The categoriser already floors it at 2 and the
 *   prompt makes it beat every other subject; this keeps the machinery away from
 *   it entirely.
 * - `legal_privacy` — an RGPD or legal request is answered by a human, and an
 *   agent reading customer records to prepare one is exactly the access this
 *   codebase minimises.
 * - `b2b`, `partner_collaboration`, `careers` — forwarded to a colleague by the
 *   routing pass. Nobody is waiting on a support answer, so there is nothing to
 *   investigate.
 */
const TOOLS_BY_SUBJECT = {
  product: [T.SEARCH_KNOWLEDGE, T.LOOKUP_PRODUCT, T.LOOKUP_STOCK],
  product_stock: [T.LOOKUP_STOCK, T.LOOKUP_PRODUCT],
  promotions: [
    T.EXTRACT_PROMOTION_CODES,
    T.LOOKUP_PROMOTION,
    T.LIST_ACTIVE_PROMOTIONS,
    T.LOOKUP_CUSTOMER,
    T.SEARCH_KNOWLEDGE
  ],
  account: [T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],
  other: [T.SEARCH_KNOWLEDGE],

  // Defined and tested, dormant until ENABLED_SUBJECTS includes them.
  order: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],
  delivery: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],
  payment: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],
  return_exchange: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],

  cosmetovigilance: [],
  legal_privacy: [],
  b2b: [],
  partner_collaboration: [],
  careers: []
};

/**
 * The guardrail: what this ticket's agent is allowed to call.
 *
 * Two overrides sit above the per-subject table, and both close a whole class of
 * mistake rather than a case:
 *
 * - **Level 4 gets nothing.** It means a legal threat, a hospitalisation or
 *   grave danger. There is no lookup that improves that ticket and no reply the
 *   agent should be preparing for it.
 * - **`contact` gets nothing.** The taxonomy restricts that kind to b2b,
 *   partner_collaboration and careers, all of which are forwarded. An
 *   investigation would spend model calls on mail that leaves the desk.
 */
export function allowedTools(category, requestKind, level) {
  if (level >= 4 || requestKind === 'contact') {
    return [];
  }
  return TOOLS_BY_SUBJECT[category] ? [...TOOLS_BY_SUBJECT[category]] : [];
}

/** Whether this ticket is in scope at all — checked before a single tool is bound. */
export function isInvestigable(ticket = {}) {
  if (!ENABLED_SUBJECTS.includes(ticket.category)) {
    return false;
  }
  return allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1).length > 0;
}

/**
 * The checklist a complete case file satisfies, per subject.
 *
 * CHECKED AFTER THE RUN, not merely stated in the prompt. An investigation that
 * did not establish the product it is about is not "mostly done" — it produces a
 * case file that names that gap, which is what turns a vague answer into a
 * specific question for the customer.
 *
 * Keys are code; labels are French, because they are rendered into the prompt
 * and read by French-speaking staff — the same split the categoriser uses.
 */
const EVIDENCE_BY_SUBJECT = {
  product: [
    { key: 'product_identified', label: 'le produit concerné est identifié' },
    { key: 'product_answer', label: 'la fiche produit ou un article approuvé répond à la question' }
  ],
  product_stock: [
    { key: 'product_identified', label: 'le produit concerné est identifié' },
    { key: 'stock_known', label: 'la disponibilité du produit est établie' }
  ],
  promotions: [
    { key: 'code_identified', label: 'le code promotionnel en question est identifié' },
    { key: 'promotion_status', label: 'le statut du code et ses conditions sont établis' }
  ],
  account: [{ key: 'customer_identified', label: 'la fiche client correspondant à l’expéditeur est trouvée' }],
  other: [{ key: 'knowledge_searched', label: 'la base de connaissances approuvée a été consultée' }],

  order: [
    { key: 'order_identified', label: 'la commande concernée est identifiée et rattachée au client' },
    { key: 'order_state', label: 'l’état de la commande est établi' }
  ],
  delivery: [
    { key: 'order_identified', label: 'la commande concernée est identifiée et rattachée au client' },
    { key: 'delivery_state', label: 'l’état de la livraison est établi' }
  ],
  payment: [
    { key: 'order_identified', label: 'la commande concernée est identifiée et rattachée au client' },
    { key: 'payment_state', label: 'l’état du paiement est établi' }
  ],
  return_exchange: [
    { key: 'order_identified', label: 'la commande concernée est identifiée et rattachée au client' },
    { key: 'return_state', label: 'l’état du retour ou du remboursement est établi' }
  ]
};

export function requiredEvidence(category) {
  return EVIDENCE_BY_SUBJECT[category] ? [...EVIDENCE_BY_SUBJECT[category]] : [];
}

/**
 * Tool calls the runner makes BEFORE the model's first turn.
 *
 * The point is not to save a round trip for its own sake. For most subjects here
 * the whole evidence set is deterministic — a product question always needs the
 * product matched against the question text, a promotions ticket always needs
 * the codes extracted from it — so having a model ask for those is paying a
 * model call to reach a foregone conclusion, and giving it the chance to ask for
 * something else instead. It arrives with the evidence in hand and its job is
 * reduced to reading it.
 *
 * Only tools the subject is allowed are ever returned, so this can never widen
 * the guardrail above.
 */
export function openingMoves(ticket = {}) {
  const allowed = new Set(allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1));
  const text = String(ticket.text || '').trim();
  const moves = [];

  const add = (tool, args = {}) => {
    if (allowed.has(tool)) {
      moves.push({ tool, args });
    }
  };

  switch (ticket.category) {
    case 'product':
      add(T.LOOKUP_PRODUCT, { question: text });
      add(T.SEARCH_KNOWLEDGE, {});
      break;
    case 'product_stock':
      add(T.LOOKUP_STOCK, { question: text });
      break;
    case 'promotions':
      add(T.EXTRACT_PROMOTION_CODES, { text });
      // The newsletter welcome code is the single biggest cluster in the inbox
      // and its commonest cause is the customer not actually being subscribed —
      // a check that needs the customer row and nothing else.
      add(T.LOOKUP_CUSTOMER, {});
      break;
    case 'account':
      add(T.LOOKUP_CUSTOMER, {});
      add(T.SEARCH_KNOWLEDGE, {});
      break;
    case 'other':
      add(T.SEARCH_KNOWLEDGE, {});
      break;
    case 'order':
    case 'delivery':
    case 'payment':
    case 'return_exchange':
      add(T.GET_ORDER_CONTEXT, {});
      break;
    default:
      break;
  }

  return moves;
}

/**
 * How long a parcel may sit without a carrier scan before it stops being
 * "in transit" and starts being "stuck".
 *
 * From the review set: 4 of the 7 level disagreements were human
 * `delivery/problem` L3 against agent L2, and the human note each time was some
 * version of "requires someone to intervene". The agent read "look up the
 * tracking and reply"; the reviewer knew the parcel had not moved. This is the
 * arithmetic that settles it without a model judgement.
 */
export const STALE_TRANSIT_DAYS = 10;

/**
 * Level escalations that follow from the evidence, computed rather than judged.
 *
 * Returns the level this ticket should now carry and why. The runner applies it
 * through `ratchetLevel`, so a level can rise and never fall — the un-ratcheted
 * value is kept as `proposed_level`, exactly as the categoriser keeps its own.
 *
 * Dormant while the order family is disabled, and tested anyway: these are the
 * rules the whole delivery scope turns on, and they cost nothing to hold ready.
 */
export function escalationTriggers({ ticket = {}, orderContext = null, now = new Date() } = {}) {
  const current = ticket.level ?? 1;
  const reasons = [];
  let level = current;

  const delivery = orderContext?.order?.delivery || null;
  if (delivery) {
    if (delivery.state === 'in_transit' && daysSince(delivery.lastScanAt || delivery.dispatchedAt, now) >= STALE_TRANSIT_DAYS) {
      reasons.push(`colis sans mouvement depuis ${STALE_TRANSIT_DAYS} jours ou plus`);
      level = Math.max(level, 3);
    }
    // "Never arrived" against a carrier that says delivered is an investigation
    // and possibly a resend — never something to answer with a tracking link.
    if (delivery.state === 'delivered' && ticket.category === 'delivery' && ticket.request_kind === 'problem') {
      reasons.push('le transporteur déclare le colis livré alors que le client signale le contraire');
      level = Math.max(level, 3);
    }
  }

  return { level, reasons };
}

function daysSince(timestamp, now) {
  if (!timestamp) {
    return 0;
  }
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) {
    return 0;
  }
  return (now.getTime() - then) / 86_400_000;
}

/** Every subject has an explicit policy — no subject falls through to a default. */
export function subjectsWithoutPolicy() {
  return TICKET_SUBJECTS.filter((subject) => !Object.hasOwn(TOOLS_BY_SUBJECT, subject));
}
