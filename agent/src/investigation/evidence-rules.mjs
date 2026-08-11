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

  // No tool, by design — so this can only ever be `unknown`, and listing it says
  // so explicitly rather than leaving a reader to infer it from an empty
  // `satisfiedBy`. Same argument as the need itself.
  checkout_state: {
    values: ['unknown'],
    derive: () => 'unknown'
  }
};

export const FINDING_KEYS = Object.keys(FINDINGS);

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
