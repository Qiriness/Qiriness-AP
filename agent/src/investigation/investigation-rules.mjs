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
  GET_ORDER_CONTEXT: 'getOrderContext',
  VERIFY_PURCHASE: 'verifyPurchase',
  CHECK_PHOTO_EVIDENCE: 'checkPhotoEvidence'
};

const T = TOOL_NAMES;

/**
 * Subjects the agent actually investigates today.
 *
 * THE ORDER FAMILY WAS ENABLED 2026-08-13, and both reasons it was held back are
 * now spent. The gate began as environmental — Supabase held a dev-store fixture
 * (12 orders, #1001-#1012) while the mail quotes #4854 and #6216, so an
 * investigation could only ever conclude "no such order". The project points at
 * the live store now: 2052 orders spanning #4716-#6770, which contains every
 * order number the corpus quotes. Then it was a pass that had not run;
 * `orders:resolve` and `context:build` have since run, and 50 of 214 tickets
 * carry a confirmed number.
 *
 * IT WAS ENABLED WITH 15 KNOWN MISMATCHES OUTSTANDING, deliberately, and that is
 * safe for a reason worth stating rather than trusting. A mismatch is an order
 * number that parsed correctly against a real order and was refused because the
 * requester's email hash does not own it. `isSafeToWrite()` gates the column, so
 * a refused resolution leaves `shopify_order_number` NULL — the agent cannot
 * answer about the wrong order, because it never learns which order that was.
 *
 * What it costs instead is a worse experience on those tickets: `getOrderContext`
 * reports `not_resolved`, the `order_identity` need goes unsatisfied, and the
 * agent asks for an order number the customer already gave us. Annoying, never
 * wrong. The merchant call is that the check is probably too strict — a gift, a
 * partner, a second mailbox — and that this is the cheaper error while it is
 * measured. Tracked in `VALIDATION_LOG.md` item 6.
 *
 * The four still absent are absent on their own merits, not for want of data:
 * `legal_privacy`, `b2b`, `partner_collaboration` and `careers` all have empty
 * tool sets, so `isInvestigable` would refuse them anyway. Listing them here
 * would state an intention the tool table contradicts.
 */
export const ENABLED_SUBJECTS = [
  'product',
  'product_stock',
  'promotions',
  'account',
  'other',
  // The order family: tools written and tested long before this, dormant until
  // there was real order data behind them.
  'order',
  'delivery',
  'payment',
  'return_exchange',
  // Added 2026-08-30 with a tool set of exactly one lookup. It is in scope to
  // GATHER, not to answer — see the tool table and the rule that pins every one
  // of these tickets to a person.
  'cosmetovigilance'
];

/**
 * Which tools each subject may use.
 *
 * THE EMPTY SETS ARE THE INTERESTING ONES, and each is empty for its own reason:
 *
 * - `legal_privacy` — an RGPD or legal request is answered by a human, and an
 *   agent reading customer records to prepare one is exactly the access this
 *   codebase minimises.
 * - `b2b`, `partner_collaboration`, `careers` — forwarded to a colleague by the
 *   routing pass. Nobody is waiting on a support answer, so there is nothing to
 *   investigate.
 */
const TOOLS_BY_SUBJECT = {
  // `verifyPurchase` and `checkPhotoEvidence` are added to the subjects where a
  // product came back or went wrong. Both stay out of `cosmetovigilance` with
  // everything else: an adverse reaction is the case where a confident-looking
  // assembly is worse than none, and "we cannot find your order" is a
  // particularly bad thing to put in front of someone reporting a reaction.
  product: [T.SEARCH_KNOWLEDGE, T.LOOKUP_PRODUCT, T.LOOKUP_STOCK, T.VERIFY_PURCHASE, T.CHECK_PHOTO_EVIDENCE],
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
  order: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE, T.VERIFY_PURCHASE],
  delivery: [
    T.GET_ORDER_CONTEXT,
    T.LOOKUP_CUSTOMER,
    T.SEARCH_KNOWLEDGE,
    T.VERIFY_PURCHASE,
    // A parcel that arrived smashed is a photo case as much as a broken bottle is.
    T.CHECK_PHOTO_EVIDENCE
  ],
  payment: [T.GET_ORDER_CONTEXT, T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE, T.VERIFY_PURCHASE],
  return_exchange: [
    T.GET_ORDER_CONTEXT,
    T.LOOKUP_CUSTOMER,
    T.SEARCH_KNOWLEDGE,
    T.VERIFY_PURCHASE,
    T.CHECK_PHOTO_EVIDENCE
  ],

  // CONTEXT FOR A PERSON, NEVER AN ANSWER. This set was empty until 2026-08-30,
  // on the reasoning that a confident-looking case file about a reported skin
  // reaction is worse than none — and that reasoning was about ANSWERING, which
  // these two do not do.
  //
  // `lookupCustomer` says who wrote in. The customer's most recent order rides
  // along with it: `lastOrderLookup` is not in this table at all, runs outside
  // the model's loop, and reaches `candidateOrder` — read by the human brief and
  // never by the drafting prompt. So the person picking the ticket up opens it
  // with the customer and their last order already on screen, which is what they
  // would otherwise go to Shopify for.
  //
  // WHAT IS STILL DELIBERATELY ABSENT is the whole order family and
  // `verifyPurchase`, for the reason that has not changed: « nous ne trouvons
  // aucune commande à votre nom » is a particularly bad sentence to put in front
  // of somebody reporting a reaction, and those are the tools that produce it.
  //
  // `searchKnowledge` ADDED 2026-08-30, and the article it reaches today is a
  // PROTOCOL rather than a fact — a numbered list of what to recommend. That is
  // an instruction retrieved by similarity, which is the non-determinism the
  // rules layer exists to remove, so it is a temporary shape: the protocol
  // belongs in a rule's skeleton and the article should keep only the reference
  // half (formulation, why a reaction can happen at all). Until it is split, the
  // same guidance can arrive twice — once retrieved, once from a rule — and the
  // two can drift.
  //
  // AND THE RULE IS THE SECOND HALF. Giving a subject tools makes it
  // investigable, and an investigable ticket is a draftable one — so the
  // `cosmetovigilance` answer set carries one rule that routes every ticket to a
  // person whatever the evidence says. Tools gather; the rule refuses to answer.
  cosmetovigilance: [T.LOOKUP_CUSTOMER, T.SEARCH_KNOWLEDGE],
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

/**
 * Which family of policy rules a subject draws on, when no exemplar named one.
 *
 * THE FALLBACK IS THE POINT, not a convenience. `support_exemplars.answer_set`
 * is the primary route and it only exists on a ticket whose situation was
 * matched — and matching is an embedding at 0.65, which is deliberately strict.
 * Without this, every rule in the system would be unreachable on any ticket the
 * matcher missed, and the policy layer's coverage would be capped by retrieval
 * recall rather than by what has been written.
 *
 * A set reached this way can still only fire its situation-less rules: a rule
 * naming `situation_key` needs a matched exemplar to name, and `selectAnswer`
 * refuses to fire one against an unknown situation. So the fallback widens which
 * tickets see the SHARED state rules and never puts words in the mouth of a
 * situation nobody identified.
 *
 * NAMED IN ENGLISH, like every other identifier in this codebase. They were
 * French — `commande`, `retour`, `promo`, `produit` — which put two languages in
 * one namespace: the French is for what a customer reads, and a key a developer
 * types is code. Renamed 2026-08-30, in the table and the mapping together.
 *
 * `orders` COVERS ORDER AND DELIVERY, and `products` covers product and
 * product_stock, which is the whole reason a set is not just a category: « pas
 * encore expédiée » answers a delivery question and an order question, and
 * keying rules to categories would mean writing it twice and keeping the copies
 * in step for ever.
 *
 * The five with no entry — `legal_privacy`, `b2b`, `partner_collaboration`,
 * `careers`, `other` — have no tools either. They reach a person untouched, and
 * a policy family for them would be a family nothing could ever populate.
 */
const ANSWER_SET_BY_SUBJECT = {
  order: 'orders',
  delivery: 'orders',
  return_exchange: 'returns',
  promotions: 'promotions',
  product: 'products',
  product_stock: 'products',
  payment: 'payments',
  account: 'accounts',
  cosmetovigilance: 'cosmetovigilance'
};

export function answerSetFor(category) {
  return ANSWER_SET_BY_SUBJECT[category] ?? null;
}

/** Whether this ticket is in scope at all — checked before a single tool is bound. */
export function isInvestigable(ticket = {}) {
  // A LINKED DUPLICATE IS THE SAME CONVERSATION, and investigating it a second
  // time buys nothing: the tools would query the same order for the same
  // customer and reach the same case file, at full model cost. It matches
  // `draftDecision`, which already refuses to draft here — a ticket nobody will
  // reply on does not need evidence gathered for the reply.
  if (ticket.duplicate_of_ticket_id) {
    return false;
  }
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
  // ONE ITEM, AND IT IS NOT ABOUT THE REACTION. Nothing here asks what caused
  // it, whether the product is implicated, or whether a refund is owed — those
  // are the judgements a person makes, and a checklist naming them would invite
  // the case file to answer them. Knowing who wrote in is the whole job.
  cosmetovigilance: [
    { key: 'customer_identified', label: 'la fiche client correspondant à l’expéditeur est trouvée' },
    { key: 'knowledge_searched', label: 'la base de connaissances approuvée a été consultée' }
  ],
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
    // Deterministic, and the only move this subject has: there is exactly one
    // tool and exactly one thing worth knowing, so making the model ask for it
    // would be a turn spent reaching a foregone conclusion.
    case 'cosmetovigilance':
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
