import { isVipRfmGroup } from '../../../scripts/lib/customer-segments.mjs';

import { TOOL_NAMES } from './investigation-rules.mjs';

// What answering a ticket REQUIRES, and whether the investigation got it.
//
// The gap this closes: `requiredEvidence` states a per-subject habit list in the
// prompt and is then never referenced again, so nothing in the system can tell
// "there was nothing to find" from "the agent did not look". Both produce a case
// file that reads as complete.
//
// A CLOSED VOCABULARY, BECAUSE THE CHECK HAS TO BE MECHANICAL. If the model
// wrote free-text needs ("confirmer si le sérum convient pendant la grossesse"),
// deciding whether the ledger satisfied one would take a second model call —
// a judge marking its own homework, and no number worth trusting at the end. So
// the model picks WHICH needs a ticket has, from this enum; code owns what
// satisfies each. Same split as `MISSING_FIELDS`, where the model picks the key
// and this codebase owns the sentence.
//
// NEEDS ARE FACTS, NOT TOOL CALLS. `product_identity` is "we know which product
// this is about", not "lookupProduct ran". That distinction is the whole point:
// a tool that ran and found nothing leaves the need unmet, and the report says
// so.

/**
 * The facts a reply might have to rest on.
 *
 * `satisfiedBy` — ledger outcomes that establish this need. `asksCustomer` — the
 * `MISSING_FIELDS` key that would unblock it when no tool can, reusing the enum
 * whose wording is already owned by `case-file.mjs`.
 */
const NEEDS = {
  // --- product ---------------------------------------------------------------
  product_identity: {
    label: 'quel produit est concerné',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_PRODUCT, outcomes: ['found'] }],
    // `ambiguous` deliberately does NOT satisfy: a tie between two products is
    // precisely the case where the reply must ask rather than pick.
    asksCustomer: 'product_name'
  },
  product_property: {
    label: 'une caractéristique du produit (ingrédients, usage, texture, prix, convenance)',
    satisfiedBy: [
      { tool: TOOL_NAMES.LOOKUP_PRODUCT, outcomes: ['found'] },
      { tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcomes: ['answerable'] }
    ],
    asksCustomer: null
  },
  product_availability: {
    label: 'la disponibilité du produit',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_STOCK, outcomes: ['found'] }],
    asksCustomer: 'product_name'
  },

  // --- order family (dormant until ENABLED_SUBJECTS includes it) --------------
  order_identity: {
    label: 'de quelle commande il s’agit',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  order_state: {
    label: 'l’état de la commande',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  delivery_state: {
    label: 'où en est la livraison',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  payment_state: {
    label: 'l’état du paiement',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'order_date_or_amount'
  },
  refund_state: {
    label: 'l’état du remboursement',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  return_eligibility: {
    label: 'si un retour ou un échange est encore possible',
    satisfiedBy: [
      { tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] },
      { tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcomes: ['answerable'] }
    ],
    asksCustomer: 'shopify_order_number'
  },

  // --- promotions ------------------------------------------------------------
  promotion_identity: {
    label: 'de quel code promotionnel il s’agit',
    satisfiedBy: [{ tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcomes: ['found'] }],
    asksCustomer: 'promotion_code'
  },
  promotion_validity: {
    label: 'si le code existe et est actif',
    // Any outcome where the promotion was FOUND settles existence and dates,
    // including `undetermined` — that verdict is about eligibility, not validity.
    satisfiedBy: [
      { tool: TOOL_NAMES.LOOKUP_PROMOTION, outcomes: ['eligible', 'blocked', 'undetermined'] },
      { tool: TOOL_NAMES.LIST_ACTIVE_PROMOTIONS, outcomes: ['found'] }
    ],
    asksCustomer: 'promotion_code'
  },
  promotion_eligibility: {
    label: 'si ce client peut utiliser ce code',
    // `undetermined` is NOT satisfaction — it is the tool saying it could not
    // decide, usually because the basket is invisible. Recording it as satisfied
    // would launder the one gap the promotion tool exists to be honest about.
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_PROMOTION, outcomes: ['eligible', 'blocked'] }],
    asksCustomer: null
  },

  // --- customer --------------------------------------------------------------
  customer_identity: {
    label: 'qui est le client qui écrit',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcomes: ['found'] }],
    asksCustomer: 'purchase_email'
  },
  customer_account_state: {
    label: 'l’état du compte client (compte, newsletter)',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcomes: ['found'] }],
    asksCustomer: 'purchase_email'
  },
  customer_history: {
    label: 'l’historique du client (commandes, fidélité)',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcomes: ['found'] }],
    asksCustomer: 'purchase_email'
  },

  // --- purchase and evidence -------------------------------------------------
  purchase_verified: {
    label: 'si l’achat a bien été effectué en ligne chez nous',
    // ONLY `known_buyer` SATISFIES THIS. `known_no_orders` is a real customer
    // row with no order behind it — a newsletter signup, or an address given at
    // a till — and treating it as a verified purchase is precisely the false
    // green this need exists to prevent. An unsatisfied one is not a claim that
    // the person never bought anything: a shop sale never reaches Shopify, so
    // the question goes to the customer rather than to a conclusion.
    satisfiedBy: [{ tool: TOOL_NAMES.VERIFY_PURCHASE, outcomes: ['known_buyer'] }],
    asksCustomer: 'purchase_channel'
  },
  photo_evidence: {
    label: 'une photo du produit cassé, abîmé ou défectueux',
    // `mentioned_not_attached` deliberately does NOT satisfy: the customer
    // saying a photo is attached is not a photo. `attachment_type_unknown`
    // does not either — it is the honest gap for mail ingested before the
    // metadata fetch existed, and closing a need on "something was attached"
    // would let a CV settle a damage claim.
    satisfiedBy: [{ tool: TOOL_NAMES.CHECK_PHOTO_EVIDENCE, outcomes: ['attached'] }],
    asksCustomer: 'photo'
  },

  // --- knowledge -------------------------------------------------------------
  policy_answer: {
    label: 'ce que dit une politique approuvée (retours, livraison, CGV)',
    satisfiedBy: [{ tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcomes: ['answerable'] }],
    asksCustomer: null
  },
  brand_answer: {
    label: 'ce que dit la marque (philosophie, hanbang, sourcing)',
    satisfiedBy: [{ tool: TOOL_NAMES.SEARCH_KNOWLEDGE, outcomes: ['answerable'] }],
    asksCustomer: null
  },

  // --- known to matter, deliberately unwired ---------------------------------
  checkout_state: {
    label: 'ce que contenait le panier abandonné',
    // NO TOOL, ON PURPOSE. `abandoned-checkout.mjs` exists and is validated, but
    // it is not in the investigation registry, so this need can never be
    // satisfied today and always resolves `unavailable`. That is the point of
    // listing it: « mon code n'a pas été appliqué au checkout » is one of the
    // commonest promotions cases, and a report that counts how often it is
    // needed is the argument for wiring the tool — or for not bothering.
    satisfiedBy: [],
    asksCustomer: null
  },

  // --- the escape hatch ------------------------------------------------------
  other_fact: {
    label: 'un élément que cette liste ne sait pas nommer',
    // Never auto-satisfiable, by design. A closed vocabulary's real danger is a
    // FALSE GREEN: a ticket whose actual requirement is not in the list declares
    // two easy needs, satisfies both, and reads as complete. This lets the model
    // say "there is something else here", and because nothing can close it, the
    // ticket cannot report as fully evidenced. It fails towards a person, like
    // every other fallback in this pipeline.
    satisfiedBy: [],
    asksCustomer: null
  }
};

export const NEED_KEYS = Object.keys(NEEDS);

export function needLabel(key) {
  return NEEDS[key]?.label || null;
}

// --- findings: not whether we established it, but WHAT IT TURNED OUT TO BE ----
//
// `satisfiedBy` answers "did a tool settle this?". That is enough to report a
// gap and not enough to choose an answer: « ton code a expiré » and « ton code
// est réservé aux nouveaux clients » are both `promotion_validity` satisfied.
// A finding is the value the need took.
//
// THE SAME SPLIT, ONE NOTCH FURTHER. The model picks WHICH needs a ticket has;
// code owns WHAT SATISFIES them; and code owns WHAT VALUE THEY TOOK. A finding
// is never model-authored, so nothing downstream branches on a model's wording.
//
// DERIVED FROM STRUCTURE, NEVER FROM PROSE. Each deriver reads a ledger entry's
// `data` — outcomes, verdicts, check reasons. It never matches on `promptText`,
// which is French written for a human and free to be reworded.
//
// `unknown` is a member of EVERY enum and is the answer whenever the evidence
// does not pin a value — including when the need is `satisfied` but by a tool
// too coarse to name it (listing active promotions establishes that a code
// exists without settling which state a specific code is in). That makes every
// finding total: there is no world in which a condition has nothing to compare
// against.
//
// ONLY THE NEEDS THAT ARE BRANCHED ON GET ONE. Inventing an enum for all 19
// would be guessing at distinctions no answer depends on. A need with no entry
// here resolves `finding: null`, which reads as "nobody needed to know".

/** The last entry for a tool — later calls supersede earlier ones. */
function lastByTool(entries, tool) {
  let found = null;
  for (const entry of entries) {
    if (entry?.tool === tool) found = entry;
  }
  return found;
}

/** Knowledge retrieval reports the same three bands wherever it is used. */
const KNOWLEDGE_FINDINGS = ['answered', 'weak', 'none', 'unknown'];

function deriveKnowledge(entries) {
  const entry = lastByTool(entries, TOOL_NAMES.SEARCH_KNOWLEDGE);
  if (!entry) return 'unknown';
  if (entry.outcome === 'answerable') return 'answered';
  if (entry.outcome === 'weak') return 'weak';
  if (entry.outcome === 'none') return 'none';
  return 'unknown';
}

const FINDINGS = {
  product_identity: {
    values: ['resolved', 'ambiguous', 'none', 'unknown'],
    // `ambiguous` is a value in its own right, not a failure: a tie between two
    // products is the case where the reply must ask, and an answer variant
    // wants to branch on exactly that.
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'resolved';
      if (entry.outcome === 'ambiguous') return 'ambiguous';
      if (entry.outcome === 'no_match') return 'none';
      return 'unknown';
    }
  },

  product_property: { values: KNOWLEDGE_FINDINGS, derive: deriveKnowledge },
  policy_answer: { values: KNOWLEDGE_FINDINGS, derive: deriveKnowledge },
  brand_answer: { values: KNOWLEDGE_FINDINGS, derive: deriveKnowledge },

  promotion_identity: {
    values: ['resolved', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.EXTRACT_PROMOTION_CODES);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'resolved';
      if (entry.outcome === 'none') return 'none';
      return 'unknown';
    }
  },

  promotion_validity: {
    values: ['active', 'expired', 'not_yet_started', 'inactive', 'not_found', 'unknown'],
    // Reads the check REASONS added in promotion-rules.mjs. Expiry and a future
    // start date are both FAIL on the same check, so the status alone cannot
    // tell them apart — and they are precisely the two branches an answer needs.
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PROMOTION);
      if (!entry) return 'unknown';
      if (entry.outcome === 'not_found' || entry.data?.found === false) return 'not_found';

      const checks = entry.data?.checks || [];
      const window = checks.find((c) => c.id === 'window')?.reason ?? null;
      const status = checks.find((c) => c.id === 'status')?.reason ?? null;

      if (window === 'expired') return 'expired';
      if (window === 'not_yet_started') return 'not_yet_started';
      if (status === 'inactive') return 'inactive';
      if (window === 'open' && status === 'active') return 'active';
      return 'unknown';
    }
  },

  promotion_eligibility: {
    values: ['eligible', 'blocked', 'undetermined', 'not_found', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PROMOTION);
      if (!entry) return 'unknown';
      const verdict = entry.data?.verdict ?? null;
      return FINDINGS.promotion_eligibility.values.includes(verdict) ? verdict : 'unknown';
    }
  },

  customer_identity: {
    values: ['resolved', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_CUSTOMER);
      if (!entry) return 'unknown';
      return entry.outcome === 'found' ? 'resolved' : 'none';
    }
  },

  customer_account_state: {
    values: ['resolved', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_CUSTOMER);
      if (!entry) return 'unknown';
      return entry.outcome === 'found' ? 'resolved' : 'none';
    }
  },

  product_availability: {
    values: ['in_stock', 'out_of_stock', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_STOCK);
      if (!entry || entry.outcome !== 'found') return 'unknown';
      const products = entry.data?.products || [];
      if (products.length === 0) return 'unknown';
      return products.some((p) => p.purchasable) ? 'in_stock' : 'out_of_stock';
    }
  },

  // --- the order family ------------------------------------------------------
  //
  // READ OFF `data.states`, WHICH `order-context.mjs` DERIVED. Every other entry
  // in this table reads a tool's own result; these read a projection the module
  // that owns the order bundle already made, for the reason that module exists —
  // `fulfillment_status = FULFILLED` with `delivered_at = null` is a reading, and
  // a second reading of it here would be free to disagree with the one the model
  // was shown.
  //
  // ALL THREE COLLAPSE TO `unknown` WITHOUT A CONFIRMED ORDER, which is the
  // common case rather than a failure: 138 of 214 tickets carry no confirmed
  // order. `order_identity` is the need that reports that gap, and the reply asks
  // for the number — these say nothing about it.

  order_state: {
    values: ['not_dispatched', 'dispatched', 'delivered', 'cancelled', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'order_state')
  },

  delivery_state: {
    // `dispatched_no_scan` is its own value and not a flavour of `in_transit` —
    // see `deliveryState` in order-context.mjs. It is the shape of the largest
    // delivery cluster in the corpus, and the one place a reply must not claim
    // the parcel is moving.
    values: [
      'not_dispatched',
      'dispatched_no_scan',
      'in_transit',
      'stale_in_transit',
      'delivered',
      'unknown'
    ],
    derive: (entries) => stateFromOrderContext(entries, 'delivery_state')
  },

  payment_state: {
    values: ['paid', 'unpaid', 'partially_refunded', 'refunded', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'payment_state')
  },

  return_eligibility: {
    // THREE VALUES, AND `unknown` IS THE COMMON ONE UNTIL A NUMBER IS SET. This
    // is the only state that depends on a merchant decision rather than on the
    // order: the returns window is a parameter, and while it is undecided every
    // ticket resolves `unknown` and routes to a person. That is the correct
    // behaviour for a shop that has not written its window down, and it is
    // visible rather than silent — the rule editor says the parameter is unset.
    values: ['possible', 'out_of_window', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'return_eligibility')
  },

  // --- evidence about the customer's own claim -------------------------------

  purchase_verified: {
    // THE TOOL'S OUTCOME IS ALREADY THE STATE, all three of them, and
    // tool-registry says why it kept them apart: a known customer with no orders
    // is not a stranger, and the reply differs.
    values: ['known_buyer', 'known_no_orders', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.VERIFY_PURCHASE);
      if (!entry) return 'unknown';
      return FINDINGS.purchase_verified.values.includes(entry.outcome) ? entry.outcome : 'unknown';
    }
  },

  photo_evidence: {
    // FOUR STATES AND THREE OF THEM ARE NOT "no photo". « J'ai joint la photo »
    // with nothing attached is a customer who believes they sent one, and the
    // metadata never having been fetched is our gap rather than theirs. Asking
    // all three to resend reads as not having looked.
    values: ['attached', 'mentioned_not_attached', 'attachment_type_unknown', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.CHECK_PHOTO_EVIDENCE);
      if (!entry) return 'unknown';
      const outcome = entry.data?.outcome ?? entry.outcome;
      return FINDINGS.photo_evidence.values.includes(outcome) ? outcome : 'unknown';
    }
  },

  // No tool, by design — so this can only ever be `unknown`, and listing it says
  // so explicitly rather than leaving a reader to infer it from an empty
  // `satisfiedBy`. Same argument as the need itself.
  checkout_state: {
    values: ['unknown'],
    derive: () => 'unknown'
  }
};

/**
 * One state off the order tool's ledger entry.
 *
 * `not_resolved` and a missing entry are both `unknown`: no order was confirmed,
 * so nothing is known about its state. That is deliberately indistinguishable
 * here — the difference between "no order number" and "a number we could not tie
 * to the sender" is `order_identity`'s to report, not this one's.
 */
function stateFromOrderContext(entries, key) {
  const entry = lastByTool(entries, TOOL_NAMES.GET_ORDER_CONTEXT);
  const value = entry?.data?.states?.[key] ?? null;
  return value && FINDINGS[key].values.includes(value) ? value : 'unknown';
}

export const FINDING_KEYS = Object.keys(FINDINGS);

// --- details: WHICH thing the finding is about -------------------------------
//
// A finding says what state a need resolved to; it never says what it resolved
// to it ABOUT. `promotion_validity: expired` does not name the code, and
// `product_identity: ambiguous` does not name the products it could not choose
// between. Those specifics sit in each tool's `data`, get read once to derive
// the finding, and were then discarded — so the dashboard could show order facts
// (which a separate pass persists) and nothing else. A person answering a
// promotions ticket still had to open Shopify.
//
// FOR THE PERSON, NOT THE MODEL, and that asymmetry is the point. The drafting
// prompt is deliberately narrower than the human brief — it already omits the
// handoff — so a detail may carry an identifier a reply must never quote. Which
// is exactly why each is declared here by name rather than passing `data`
// through: naming the fields is the decision that `JSON.stringify` skipped.
//
// EVERY EXTRACTOR RETURNS null WHEN IT HAS NOTHING, never an empty shell. The
// panel drops absent fields, and `{}` would render a heading over nothing.
const DETAILS = {
  product_identity: (entries) => {
    const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT);
    if (!entry) return null;
    const titles = entry.data?.titles || [];
    const candidates = entry.data?.candidates || [];
    // Named even when the match failed: "these were close" is what tells a
    // reviewer the catalogue is thin rather than the matcher broken.
    if (titles.length === 0 && candidates.length === 0) return null;
    return {
      products: titles.length > 0 ? titles : candidates,
      matched: titles.length > 0,
      ambiguous: Boolean(entry.data?.ambiguous)
    };
  },

  product_availability: (entries) => {
    const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_STOCK);
    const products = entry?.data?.products || [];
    if (products.length === 0) return null;
    // `purchasable`, never the raw count. One real row sits at -1 because
    // Shopify allows overselling, and "-1 en stock" is a true value and a wrong
    // answer — the same rule `buildStock` already applies.
    return {
      products: products.map((p) => ({ title: p.title, inStock: Boolean(p.purchasable) }))
    };
  },

  // The library's own answer, and the ONE detail that is a to-do rather than a
  // fact. A knowledge need resolving `weak` or `none` means no approved article
  // covers this question — which is only actionable if somebody sees it, and
  // until now it lived in a stored column nothing rendered. A merchant who has
  // the answer on file and simply has not uploaded it is the common case; the
  // agent will keep failing the same question until they do.
  //
  // `weak` and `none` are kept apart because they call for different work:
  // `weak` means an article exists and did not match well enough (rewrite or
  // retitle it), `none` means the library holds nothing on the subject at all.
  product_property: (entries) => detailsFromKnowledge(entries),
  policy_answer: (entries) => detailsFromKnowledge(entries),
  brand_answer: (entries) => detailsFromKnowledge(entries),

  promotion_identity: (entries) => {
    const entry = lastByTool(entries, TOOL_NAMES.EXTRACT_PROMOTION_CODES);
    const codes = entry?.data?.codes || [];
    return codes.length > 0 ? { codes } : null;
  },

  promotion_validity: (entries) => detailsFromPromotion(entries),
  promotion_eligibility: (entries) => detailsFromPromotion(entries),

  customer_identity: (entries) => detailsFromCustomer(entries),
  customer_account_state: (entries) => detailsFromCustomer(entries)

  // NO ORDER NEEDS HERE, deliberately. Order facts are AMBIENT: the resolution
  // pass writes them to `tickets.resolved_context` and the panel reads them
  // directly, so they exist for tickets the agent never investigated. Declaring
  // them here too would put the order name in two places with two lifecycles —
  // one that survives without an investigation and one that does not — and the
  // first question anyone asked would be which is authoritative.
};

/**
 * Whether the library answered, and how close it came when it did not.
 *
 * Only reported when it FAILED: an article that answered is already in
 * `established` as a claim, and repeating it as a detail would say the same
 * thing twice. The gap is the part nobody can see.
 *
 * `bestSimilarity` is what separates "we nearly have this" from "we have
 * nothing on it" — 0.49 against a 0.55 floor is a retitle, 0.20 is a missing
 * article — so it travels rounded rather than being reduced to a verdict.
 */
function detailsFromKnowledge(entries) {
  const entry = lastByTool(entries, TOOL_NAMES.SEARCH_KNOWLEDGE);
  if (!entry) return null;
  const verdict = entry.data?.verdict ?? entry.outcome ?? null;
  if (verdict !== 'weak' && verdict !== 'none') {
    return null;
  }
  const best = entry.data?.bestSimilarity;
  return {
    libraryAnswered: false,
    closest: Number.isFinite(best) ? Math.round(best * 100) / 100 : null
  };
}

/**
 * The code and why it was refused, shared by validity and eligibility.
 *
 * `checks` already travels as `{id, status, reason}` triples rather than the
 * French `detail` sentences — the reasons are machine values, which is what
 * makes "minimum non atteint" renderable by the panel in its own words rather
 * than by quoting the model.
 */
function detailsFromPromotion(entries) {
  const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PROMOTION);
  if (!entry) return null;
  const failed = (entry.data?.checks || [])
    .filter((c) => c.status === 'FAIL')
    .map((c) => ({ check: c.id, reason: c.reason ?? null }));
  const code = entry.data?.code ?? null;
  if (!code && failed.length === 0) return null;
  return { code, found: Boolean(entry.data?.found), failedChecks: failed };
}

/**
 * Who the customer is, if the sender matched one.
 *
 * CROSS-FAMILY BY NATURE: this hangs off the ticket's customer link rather than
 * off the subject, so it renders on a promotions ticket exactly as on an order
 * one. VIP is derived at read time from `rfm_group` and never stored, so it is
 * carried here as the account reports it rather than recomputed.
 */
function detailsFromCustomer(entries) {
  const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_CUSTOMER);
  // `account` is the account STATE; the identity lives beside it in `profile`.
  // Reading the wrong one produced `{name: null, isVip: null, ordersCount: null}`
  // on a real run — an object that passes an existence check and says nothing.
  const account = entry?.data?.profile;
  if (!account) return null;
  return {
    name: account.name ?? null,
    // Derived through the SAME rule the dashboard badge uses, not stored and not
    // reimplemented — `rfm_group` is the only source and VIP is a read-time
    // question about it.
    isVip: account.rfmGroup ? isVipRfmGroup(account.rfmGroup) : null,
    ordersCount: account.ordersCount ?? null
  };
}

/** Exported for the tests that assert every declared need can be rendered. */
export const DETAIL_KEYS = Object.keys(DETAILS);

/**
 * `{ details }` when there is something, `{}` when there is not.
 *
 * An object whose every value is null counts as nothing. A real run stored
 * `{name: null, isVip: null, ordersCount: null}` — it satisfied every existence
 * check on the way through and told a reader precisely as much as an absent
 * field, while looking like an answer. Absent beats empty beats null-filled.
 */
function nonEmpty(key, value) {
  if (!value || typeof value !== 'object') return {};
  const entries = Object.entries(value);
  if (entries.length === 0) return {};
  if (entries.every(([, v]) => v === null || v === undefined)) return {};
  return { [key]: value };
}

/** The values a need can take, for the condition builder and its validation. */
export function findingValues(need) {
  return FINDINGS[need] ? [...FINDINGS[need].values] : null;
}

// --- dependencies: which facts have to be established before which -----------
//
// UNIVERSAL, NOT PER-SITUATION. Eligibility requires identity for every ticket
// on earth, so it belongs here beside `satisfiedBy` rather than being restated
// in every exemplar that happens to need both. An exemplar names the SET of
// needs; this derives the order.
//
// `moot` is the half that saves calls: a prerequisite finding that makes the
// dependent need pointless. There is nothing to be eligible FOR once a code has
// expired, so collecting eligibility after that is spending a tool call to
// learn nothing.
//
// Only genuine universals are listed. `product_property` deliberately has no
// prerequisite: « vos produits sont-ils vegan » is answerable from the library
// without identifying any single product, and asserting a dependency there
// would force a lookup that the question does not need.

const DEPENDENCIES = {
  promotion_validity: { requires: ['promotion_identity'] },
  promotion_eligibility: {
    requires: ['promotion_validity'],
    moot: { promotion_validity: ['expired', 'not_yet_started', 'inactive', 'not_found'] }
  },

  customer_account_state: { requires: ['customer_identity'] },
  customer_history: { requires: ['customer_identity'] },

  // Dormant with the order family, and correct for when it wakes up.
  order_state: { requires: ['order_identity'] },
  delivery_state: { requires: ['order_identity'] },
  payment_state: { requires: ['order_identity'] },
  refund_state: { requires: ['order_identity'] },
  return_eligibility: { requires: ['order_identity'] }
};

export function needRequires(key) {
  return [...(DEPENDENCIES[key]?.requires || [])];
}

/**
 * Is this need pointless given what earlier needs turned out to be?
 *
 * @param key       the need being considered
 * @param findings  { needKey: finding } established so far
 */
export function isMoot(key, findings = {}) {
  const moot = DEPENDENCIES[key]?.moot;
  if (!moot) return false;
  return Object.entries(moot).some(([prerequisite, values]) =>
    values.includes(findings[prerequisite])
  );
}

/**
 * The declared needs in dependency order — prerequisites first.
 *
 * A stable topological sort: ties keep vocabulary order, so the same set always
 * produces the same sequence and a test can assert it. A need whose prerequisite
 * was not declared is not blocked by it — the exemplar is allowed to want
 * eligibility without wanting identity, and the sort simply has nothing to
 * order it against.
 */
export function orderNeeds(needs = []) {
  const declared = normaliseNeeds(needs);
  const remaining = new Set(declared);
  const ordered = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) =>
      needRequires(key).every((prerequisite) => !remaining.has(prerequisite))
    );
    // A cycle would empty this. There is none today and a test asserts it, but
    // falling back to declaration order keeps a future bad edge from hanging the
    // investigation rather than merely mis-ordering it.
    const batch = ready.length > 0 ? ready : [...remaining];
    for (const key of batch) {
      ordered.push(key);
      remaining.delete(key);
    }
  }

  return ordered;
}

/**
 * Resolution states, in the order of how much they should worry you.
 *
 * `not_attempted` is the one that does not exist today and is the reason for
 * this module: a tool was available, the budget allowed it, and nothing called
 * it. Everything else is the world being uncooperative; that one is the agent.
 */
export const NEED_STATES = ['satisfied', 'attempted', 'unavailable', 'not_attempted'];

/** Keeps only needs this vocabulary knows, deduped. Order follows the vocabulary. */
export function normaliseNeeds(raw) {
  const declared = new Set((Array.isArray(raw) ? raw : []).map((value) => String(value ?? '').trim()));
  return NEED_KEYS.filter((key) => declared.has(key));
}

/**
 * Scores each declared need against what actually ran.
 *
 * @param needs      the declared need keys
 * @param ledger     this run's tool entries ({ id, tool, outcome })
 * @param toolNames  the tools this ticket's agent was allowed at all
 */
export function resolveNeeds(needs = [], ledger = [], toolNames = []) {
  const allowed = new Set(toolNames);
  const entries = Array.isArray(ledger) ? ledger : [];

  return normaliseNeeds(needs).map((key) => {
    const need = NEEDS[key];
    const evidenceIds = [];
    let attempted = false;

    for (const source of need.satisfiedBy) {
      for (const entry of entries) {
        if (entry?.tool !== source.tool) continue;
        attempted = true;
        if (source.outcomes.includes(entry.outcome)) {
          evidenceIds.push(entry.id);
        }
      }
    }

    return {
      need: key,
      label: need.label,
      state: resolveState({ need, allowed, attempted, satisfied: evidenceIds.length > 0 }),
      // WHAT it turned out to be, where anything branches on it. `null` means
      // no answer depends on the value — not that the value is unknown, which
      // is `'unknown'` and a different statement.
      finding: FINDINGS[key] ? FINDINGS[key].derive(entries) : null,
      // WHICH thing the finding is about. Absent rather than empty when there is
      // nothing to say, so the panel can drop the field instead of rendering a
      // heading over nothing. Read by people, never by the drafting model.
      ...(DETAILS[key] ? nonEmpty('details', DETAILS[key](entries)) : {}),
      evidenceIds,
      // What to ask the customer if this stays open — a key, never a sentence.
      asksCustomer: need.asksCustomer
    };
  });
}

/** The resolved needs as a `{ need: finding }` map — what conditions read. */
export function findingsOf(resolved = []) {
  const findings = {};
  for (const item of resolved) {
    if (item?.finding != null) {
      findings[item.need] = item.finding;
    }
  }
  return findings;
}

function resolveState({ need, allowed, attempted, satisfied }) {
  if (satisfied) {
    return 'satisfied';
  }
  if (attempted) {
    return 'attempted';
  }
  // No tool in this ticket's registry could ever have settled it. Not a failure
  // of the run: either the subject is not allowed that tool, or (checkout_state)
  // nothing is wired for it at all.
  const reachable = need.satisfiedBy.some((source) => allowed.has(source.tool));
  return reachable ? 'not_attempted' : 'unavailable';
}

/**
 * The one-line summary the runner logs and the dashboards will count.
 *
 * `complete` means every declared need was satisfied. It is REPORTED, not acted
 * on — the verdict is untouched by this module. Acting on it is the next step,
 * and it should not happen until these counts have been read against real mail:
 * a vocabulary that over-declares would otherwise downgrade good case files for
 * reasons that are about this list rather than about the ticket.
 */
export function summariseNeeds(resolved = []) {
  const counts = Object.fromEntries(NEED_STATES.map((state) => [state, 0]));
  for (const item of resolved) {
    if (counts[item.state] !== undefined) {
      counts[item.state] += 1;
    }
  }
  return {
    declared: resolved.length,
    ...counts,
    complete: resolved.length > 0 && counts.satisfied === resolved.length
  };
}
