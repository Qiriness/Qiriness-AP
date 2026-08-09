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
      evidenceIds,
      // What to ask the customer if this stays open — a key, never a sentence.
      asksCustomer: need.asksCustomer
    };
  });
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
