
import { TOOL_NAMES } from './investigation-rules.mjs';
import { productFromKnowledge } from '../retrieval/product-from-knowledge.mjs';

/**
 * Which product a retrieved ARTICLE says the question was about.
 *
 * THE ONE PLACE THIS IS DECIDED, read by both `product_identity`'s `satisfiedBy`
 * and its `derive`. Those two answering differently is precisely the defect
 * `product_property` carried until 2026-08-31 — a need reported unmet while the
 * finding said it was answered — so they share a function rather than a rule.
 *
 * The precedence and confidence gates live in `productFromKnowledge`; this only
 * assembles the two ledger entries it reads.
 */
function productFromArticles(entries) {
  const lookup = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT);
  const match = lookup
    ? {
        match: lookup.outcome === 'found' || null,
        ambiguous: lookup.outcome === 'ambiguous',
        // A range IS a resolution — the question was about a family — so it
        // stands, and an article tag must not narrow it back to one product.
        range: lookup.data?.reason === 'range' || null
      }
    : null;

  return productFromKnowledge(match, lastByTool(entries, TOOL_NAMES.SEARCH_KNOWLEDGE)?.data?.chunks || []);
}

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
    satisfiedBy: [
      { tool: TOOL_NAMES.LOOKUP_PRODUCT, outcomes: ['found'] },
      // THE ARTICLE CAN NAME THE PRODUCT THE TITLE MATCHER COULD NOT. « la
      // batterie de mon masque ne tient pas » matches no title, because no title
      // contains « batterie » — but the article answering it is tagged to the
      // mask. Conditional, and deliberately so: an answerable knowledge result
      // about anything else satisfies nothing here.
      {
        tool: TOOL_NAMES.SEARCH_KNOWLEDGE,
        outcomes: ['answerable'],
        satisfies: (_entry, entries) => productFromArticles(entries)?.ambiguous === false
      }
    ],
    // `ambiguous` deliberately does NOT satisfy: a tie between two products is
    // precisely the case where the reply must ask rather than pick. That holds
    // for two articles disagreeing exactly as it does for two titles.
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
  // WHAT WE HAVE TO PUT FORWARD, which is not `product_identity`. That one asks
  // which product the message is about; this asks which products we can offer
  // somebody who has not named one — the two are opposite ends of the same
  // subject, and a rule for « lequel me conseillez-vous » needs the second.
  product_recommendation: {
    label: 'ce que la boutique recommande à ce client',
    // `by_collection` and `relaxed` joined the satisfying outcomes on
    // 2026-09-16, and `by_concern` left the same day. Both of the new ones put
    // real products forward, and `relaxed` is a narrower answer rather than a
    // failed one — the tool reports which requirement it gave up so a rule can
    // say so out loud. `by_concern` went because a concern IS a collection now:
    // five hand-written cue lists were a second way of answering the same
    // question, against the twenty-six collections the shop actually curates.
    satisfiedBy: [
      {
        tool: TOOL_NAMES.RECOMMEND_PRODUCTS,
        outcomes: ['cross_sell', 'by_collection', 'relaxed']
      }
    ],
    asksCustomer: null
  },
  // WHETHER AN OFFER COVERS THIS PRODUCT, and how narrowly.
  //
  // SEPARATE FROM `promotion_validity`, which asks whether a code the CUSTOMER
  // named is usable. This asks the opposite direction: the customer named a
  // product and no code, and wants to know if one exists. Nothing in the
  // vocabulary answered that until now, which is why P-21 had no evidence to
  // branch on.
  product_offer: {
    label: 'si une offre proposable couvre ce produit',
    // EVERY CONCLUSIVE OUTCOME SATISFIES, including `none`: "there is no offer
    // for this product" is a fact the shop established, not a gap. Only
    // `no_match` leaves it open, and that is a product problem rather than an
    // offer one.
    satisfiedBy: [
      { tool: TOOL_NAMES.LOOKUP_PRODUCT_OFFER, outcomes: ['found', 'general', 'none'] }
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
  // WHETHER THE PROMOTION LANDED, which `payment_state` and `order_state` both
  // leave unanswered: an order can be paid, dispatched and still be missing the
  // gift the customer was promised (#6913), or carry it without anyone being
  // able to say so (#6827).
  order_promotion: {
    label: 'si une promotion ou un cadeau a été appliqué à la commande',
    satisfiedBy: [{ tool: TOOL_NAMES.CHECK_ORDER_PROMOTION, outcomes: ['applied', 'none'] }],
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
  // WHETHER THE SHOP'S OWN DISPATCH WINDOW HAS RUN OUT, which is not what
  // `order_state: not_dispatched` says. That one says the parcel has not left;
  // this says whether it is LATE in leaving, and the two want opposite replies.
  // Quoting the window at somebody already past it reads as a brush-off, and a
  // customer asking whether their order has shipped has by definition waited
  // long enough to wonder.
  dispatch_state: {
    label: 'si le délai d’expédition annoncé est dépassé',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  // THE SAME QUESTION ABOUT THE OTHER LEG, and `delivery_state` cannot answer
  // it. That one says the parcel left and nothing has scanned it since — true
  // of 99% of shipped orders, and just as true on day two as on day twenty.
  // This says whether the wait has run past what delivery usually takes, which
  // is the difference between a reassurance and a brush-off.
  delivery_delay_state: {
    label: 'si le délai de livraison habituel est dépassé',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'shopify_order_number'
  },
  payment_state: {
    label: 'l’état du paiement',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found'] }],
    asksCustomer: 'order_date_or_amount'
  },
  // WHO IS WRITING, which is not the same question as what they want. A
  // pharmacy asking for an invoice duplicate asks a payment question; the
  // subject is right and only the sender is unusual. Four such tickets sit in
  // `payment` and `promotions` today, and recategorising them to `b2b` would
  // file them beside supplier dunning and lose what they were about.
  buyer_type: {
    label: 'si l’expéditeur est un client professionnel ou un particulier',
    satisfiedBy: [{ tool: TOOL_NAMES.GET_ORDER_CONTEXT, outcomes: ['found', 'not_resolved'] }],
    asksCustomer: null
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
      // THE LISTING ONLY SETTLES ANYTHING ONCE A CODE HAS BEEN IDENTIFIED, and
      // until 2026-09-01 it settled this need unconditionally.
      //
      // The reasoning it was added under still holds where it applies: listing
      // the active promotions establishes that the customer's code exists
      // without saying which state that ONE code is in, so `satisfied` with a
      // finding of `unknown` is the honest pair. What it missed is that
      // `outcome: 'found'` here means THE SHOP has at least one active
      // promotion — a fact about the shop, true on essentially every ticket,
      // and independent of the email being read.
      //
      // MEASURED on the first promotions ticket a rule ever fired on
      // (2026-09-01): `extractPromotionCodes` found nothing, so no code existed
      // to be valid, and `promotion_validity` was still recorded `satisfied`.
      // Nothing branched on it, because rules read findings rather than states —
      // but the completeness gate in `codex_plans/Rule_Guided_Investigation_Plan.md`
      // reads states, and would have counted the need as established while it
      // held nothing.
      {
        tool: TOOL_NAMES.LIST_ACTIVE_PROMOTIONS,
        outcomes: ['found'],
        satisfies: (_entry, entries) => promotionIdentified(entries)
      }
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
    label: 'si le client a un compte, et s’il est utilisable',
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_CUSTOMER, outcomes: ['found'] }],
    // NOT `purchase_email`, which the other two customer needs use. This need is
    // about the ACCOUNT, and on an account ticket the two addresses are exactly
    // what the customer is confused about — asking which one the order was
    // placed with reliably gets the wrong one.
    asksCustomer: 'account_email'
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
  // WHAT THE CUSTOMER BLAMES, NOT WHAT THE MESSAGE MENTIONS, and it is a
  // separate need from `product_identity` for that reason alone — a reaction
  // email naming three products has one product_identity and one very different
  // reaction_product. Satisfied only by `identified`: `ambiguous` and
  // `not_in_catalogue` are real findings a rule branches on, but neither is a
  // product we can name back to the customer with a straight face.
  reaction_product: {
    label: 'le produit que le client met en cause dans sa réaction',
    satisfiedBy: [{ tool: TOOL_NAMES.IDENTIFY_REACTION_PRODUCT, outcomes: ['identified'] }],
    asksCustomer: 'reaction_product_name'
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

  // --- the basket ------------------------------------------------------------
  checkout_state: {
    label: 'ce que contenait le panier abandonné',
    // WIRED 2026-09-16, and it was unwired on purpose until then. The reasoning
    // recorded here was that `abandoned-checkout.mjs` existed and was validated
    // but sat outside the registry, so the need always resolved `unavailable` —
    // and that counting how often it was wanted was the argument for wiring it
    // or for dropping it. P-17 (« le masque offert ne s'ajoute pas à mon
    // panier ») is a situation whose whole answer turns on it, so it was wired.
    //
    // ONLY `found` SATISFIES. `no_match` and `none_in_window` are real answers —
    // the shop recorded no basket for this customer — but they are the ABSENCE
    // of the fact, not the fact. Recording them as satisfaction would let a case
    // file read complete on a need nothing ever established, which is the
    // laundering `promotion_eligibility: undetermined` is refused for.
    satisfiedBy: [{ tool: TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT, outcomes: ['found'] }],
    // The lookup resolves the sender itself, from the customer row the ticket's
    // hash points at — so there is nothing to ask a customer for here. Asking
    // « quelle adresse avez-vous utilisée » is `customer_identity`'s question,
    // and this need declares it as a prerequisite instead.
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

/**
 * The needs an ARTICLE answers, derived rather than listed.
 *
 * DERIVED FROM `satisfiedBy`, so it cannot drift. A hardcoded list would be a
 * second statement of which needs read the library, and the day somebody adds a
 * fourth the gap report would quietly stop counting it — which is the one thing
 * a report about missing knowledge must not do.
 *
 * WHAT IT IS FOR: telling "we looked in the library and it had nothing" apart
 * from "no tool could have answered this". Only the first is an article somebody
 * could write, and it is the whole input to deciding what to write next.
 *
 * SUBJECT-AGNOSTIC BY CONSTRUCTION. Nothing here knows about products; a report
 * built on it works for any answer set without change.
 *
 * UNCONDITIONAL SOURCES ONLY. `product_identity` reads the library too, but only
 * to learn which product a tagged article was about — an article that answers a
 * question without naming a product settles nothing there. Counting it would
 * make the gap report claim the library is missing an article whenever the title
 * matcher missed, which is a different problem with a different fix, and would
 * bury the real gaps under it.
 */
export const KNOWLEDGE_NEEDS = NEED_KEYS.filter((key) =>
  (NEEDS[key].satisfiedBy || []).some((rule) => rule.tool === TOOL_NAMES.SEARCH_KNOWLEDGE && !rule.satisfies)
);

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
  buyer_type: {
    values: ['trade', 'consumer', 'unknown'],
    // MEASURED, not guessed: 6 of 574 inbound messages name a sum above the
    // ceiling and all six are trade — a pharmacy, a company, an invoice
    // reminder, a partner chasing late orders, and a €1,901.93 « facture
    // définitive » against an order Shopify has never held. No consumer
    // ticket trips it.
    //
    // A MISSING ORDER IS DELIBERATELY NOT A TRADE SIGNAL. It is why PA-30
    // asks for a number, but a mistyped reference or a guest checkout
    // produces one too — see `deriveBuyerType`.
    derive(entries) {
      return lastByTool(entries, TOOL_NAMES.GET_ORDER_CONTEXT)?.data?.buyerType ?? 'unknown';
    }
  },

  product_identity: {
    values: ['resolved', 'ambiguous', 'none', 'unknown'],
    // `ambiguous` is a value in its own right, not a failure: a tie between two
    // products is the case where the reply must ask, and an answer variant
    // wants to branch on exactly that.
    derive(entries) {
      // The article route runs FIRST and yields on its own: `productFromKnowledge`
      // returns null whenever the matcher resolved anything, so a product the
      // customer named can never be overwritten by one an article inferred.
      const fromArticle = productFromArticles(entries);
      if (fromArticle) return fromArticle.ambiguous ? 'ambiguous' : 'resolved';

      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'resolved';
      if (entry.outcome === 'ambiguous') return 'ambiguous';
      if (entry.outcome === 'no_match') return 'none';
      return 'unknown';
    }
  },

  // THE PRODUCT SHEET COUNTS, AND UNTIL 2026-08-31 IT DID NOT. This need is
  // `satisfiedBy` either `lookupProduct` or `searchKnowledge`, and the finding
  // read only the second — so a run that pulled the whole sheet and answered the
  // question from it scored `product_property: none`, meaning "the library had
  // nothing", which was true and beside the point.
  //
  // MEASURED: of 13 product investigations reported as unanswered, 8 were
  // `state: satisfied` with `finding: none` — the tool had answered and the
  // finding said otherwise. The consequence is worse than a wrong report: a rule
  // branching on `product_property: answered` could never fire for a question
  // answered from the catalogue, which is where 89 of 98 active products keep
  // their usage instructions and 82 their ingredient lists.
  //
  // THE SHEET WINS WHEN BOTH SPOKE, because it is the more specific source for a
  // characteristic OF A PRODUCT — the library answers about the shop.
  // `ambiguous` deliberately does not count, matching `satisfiedBy`: two possible
  // products means two possible ingredient lists, and neither is an answer.
  product_property: {
    values: KNOWLEDGE_FINDINGS,
    derive(entries) {
      const sheet = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT);
      if (sheet?.outcome === 'found') return 'answered';
      return deriveKnowledge(entries);
    }
  },
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

  // FOUR STATES, AND THE SPLIT THAT MATTERS IS NOT THE OBVIOUS ONE.
  //
  // It used to be `resolved / none / unknown`, which recorded only whether the
  // LOOKUP worked — so no rule could tell a customer with a working account from
  // one who has never had one, and both got whatever the model improvised.
  //
  // `known_no_account` vs `unknown_sender` IS THE PAIR THIS EXISTS FOR, and they
  // are the two biggest buckets in the corpus: 156 tickets whose sender matches
  // no customer row at all, and 97 whose sender matches a row that has no
  // account behind it. They need opposite replies — the first has to ASK which
  // address the account is under, the second must not ask anything, because we
  // already know exactly who they are and can say so.
  //
  // `known_no_account` IS NOT "DEACTIVATED", and the naming is deliberate.
  // Shopify stores `DISABLED` for any customer with no account, which on this
  // shop is 57,140 of 58,201 — `customerAccounts: OPTIONAL`, so every guest
  // checkout and every newsletter signup lands there. Reading it as "we turned
  // their account off" would tell 97 of the people who have written in that
  // something was done to them that never happened.
  //
  // `never_activated` is 2 tickets and earns its place anyway: it is the one
  // that looks EXACTLY like a forgotten password and is not. « Impossible de
  // réinitialiser le mot de passe. Je commande régulièrement chez vous » is an
  // INVITED customer in this corpus, and a reset link would have done nothing
  // for her because there is no password to reset.
  customer_account_state: {
    values: ['enabled', 'never_activated', 'known_no_account', 'unknown_sender', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_CUSTOMER);
      if (!entry) return 'unknown';
      // READ FROM `data`, NOT FROM THE OUTCOME, which stays `found` / `no_match`.
      // Widening the outcome would have rewritten the ledger vocabulary for all
      // six subjects that call this tool, and unlike the reaction report nothing
      // is lost by leaving it in `data`: `customers.state` is still a column, so
      // a stored run can be re-read through `ticket_investigations.customer_id`.
      const account = entry.data?.account;
      // The lookup ran and matched nobody — or had no address to match on, which
      // reaches the same reply. The outcome keeps the two apart for a reader.
      if (!account) return 'unknown_sender';
      if (account.neverActivated) return 'never_activated';
      if (account.canSignIn) return 'enabled';
      // DECLINED lands here with DISABLED, and belongs here: an invitation that
      // was refused leaves exactly as much account behind as one never sent.
      if (account.disabled) return 'known_no_account';
      // A row whose `state` Shopify never set. Rare, and not worth guessing at.
      return 'unknown';
    }
  },

  // FOUR OUTCOMES AND TWO OF THEM ARE "NOTHING TO SUGGEST" FOR DIFFERENT REASONS.
  // `not_curated` is a skin type we read and have no answer for — the shop has
  // not decided, and a reply should say a colleague will advise. `nothing_to_go_on`
  // is a message with no product and no readable skin type, where asking the
  // customer is the move. Collapsing them would send the wrong one of those two
  // replies about half the time.
  product_recommendation: {
    values: ['cross_sell', 'by_collection', 'relaxed', 'not_curated', 'nothing_to_go_on', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.RECOMMEND_PRODUCTS);
      if (!entry) return 'unknown';
      return FINDINGS.product_recommendation.values.includes(entry.outcome) ? entry.outcome : 'unknown';
    }
  },

  product_offer: {
    values: ['specific', 'general_only', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_PRODUCT_OFFER);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'specific';
      if (entry.outcome === 'general') return 'general_only';
      if (entry.outcome === 'none') return 'none';
      return 'unknown';
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

  // WHICH ORDER, AS A VALUE — added 2026-09-01, and its absence was a live trap.
  //
  // `order_state: unknown` means two different things, because
  // `stateFromOrderContext` returns it both when no order was confirmed (there
  // are no states to read) and when an order WAS confirmed whose delivery state
  // is unrecognised. A rule keyed on that pair asks the customer for a number we
  // are already holding — the exact failure the "never ask for what is known"
  // rule exists to stop.
  //
  // Derived from the tool's own outcome, which already draws the line: `found`
  // against `not_resolved`. Same shape as `promotion_identity`, for the same
  // reason — an identity is a value an answer branches on, not just a gap.
  order_identity: {
    values: ['resolved', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.GET_ORDER_CONTEXT);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'resolved';
      if (entry.outcome === 'not_resolved') return 'none';
      return 'unknown';
    }
  },

  // `gift` and `discount` are separate values because the replies differ: one
  // names a product the customer was given, the other an amount taken off. A
  // sample is never either — see `buildPromotions` in order-context.mjs.
  order_promotion: {
    values: ['gift', 'discount', 'both', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.CHECK_ORDER_PROMOTION);
      if (!entry) return 'unknown';
      if (entry.outcome === 'none') return 'none';
      if (entry.outcome !== 'applied') return 'unknown';
      const gifts = Number(entry.data?.gifts || 0);
      const reductions = Number(entry.data?.reductions || 0);
      if (gifts > 0 && reductions > 0) return 'both';
      if (gifts > 0) return 'gift';
      if (reductions > 0) return 'discount';
      // An order-wide promotion with no line of its own is still a discount.
      return 'discount';
    }
  },

  order_state: {
    values: ['not_dispatched', 'dispatched', 'delivered', 'cancelled', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'order_state')
  },

  // `unknown` CARRIES REAL WEIGHT HERE: it is what a shop that has not set
  // `dispatch_days` resolves to, and a rule branching on `within_window` must
  // therefore never fire on a guess. See `dispatchState` in order-context.mjs.
  dispatch_state: {
    values: ['within_window', 'overdue', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'dispatch_state')
  },

  // `unknown` IS THE FALL-THROUGH AND IT IS LOAD-BEARING: an unset
  // `france_delivery_days` or `abroad_delivery_days`, an order with no shipping
  // country, a parcel not yet dispatched or already delivered all resolve here,
  // and each one leaves the ticket to `expediee_sans_scan`. See
  // `deliveryDelayState` in order-context.mjs.
  delivery_delay_state: {
    values: ['within_window', 'overdue', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'delivery_delay_state')
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

  // DECLARED AS A NEED SINCE THE VOCABULARY EXISTED, AND UNDERIVABLE UNTIL NOW.
  // R-23 (« sous quel délai suis-je remboursé ? ») has named it all along, so
  // every run of that situation scored it `unknown` and no rule could branch on
  // it — the same shape `customer_account_state` was in before 2026-08-30.
  //
  // IT IS NOT `payment_state` UNDER ANOTHER NAME. That one asks whether we are
  // holding the customer's money; this asks where their REQUEST has got to, and
  // the two part company exactly where the question is asked — a return opened
  // and not yet settled is `paid` to the first and `return_open` to the second.
  refund_state: {
    values: ['none', 'return_open', 'refunded_partial', 'refunded_full', 'unknown'],
    derive: (entries) => stateFromOrderContext(entries, 'refund_state')
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

  reaction_product: {
    // `not_attributed` IS A FINDING, NOT AN ABSENCE. The customer described a
    // reaction and named no product — established by the model reading the
    // email and saying so, which is a different claim from the tool never
    // having run. `unknown` is that second thing, and the two must not collapse:
    // the rule that asks « de quel produit s'agit-il » is correct on the first
    // and asks a customer a question we never looked into on the second.
    values: ['identified', 'ambiguous', 'not_in_catalogue', 'not_attributed', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.IDENTIFY_REACTION_PRODUCT);
      if (!entry) return 'unknown';
      return FINDINGS.reaction_product.values.includes(entry.outcome) ? entry.outcome : 'unknown';
    }
  },

  photo_evidence: {
    // FOUR STATES AND THREE OF THEM ARE NOT "no photo". « J'ai joint la photo »
    // with nothing attached is a customer who believes they sent one, and the
    // metadata never having been fetched is our gap rather than theirs. Asking
    // all three to resend reads as not having looked.
    values: ['attached', 'mentioned_not_attached', 'attachment_type_unknown', 'not_checked', 'none', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.CHECK_PHOTO_EVIDENCE);
      if (!entry) return 'unknown';
      const outcome = entry.data?.outcome ?? entry.outcome;
      return FINDINGS.photo_evidence.values.includes(outcome) ? outcome : 'unknown';
    }
  },

  // THREE VALUES, AND THE MIDDLE ONE CARRIES THE WEIGHT. `retrieved` means we
  // are holding a real basket; `unavailable` means we looked and the shop has
  // none for this customer — which is a fact a reply may state, and NOT the same
  // as `unknown`, where nothing looked at all (no tool for this subject, or the
  // customer was never identified).
  //
  // A dated snapshot, never the current cart: Shopify mutates one record per
  // checkout session, so `retrieved` licenses « le panier que vous aviez laissé
  // le 12 septembre » and never « votre panier contient ». The tool keeps the
  // `basket_unseeable` caveat on for exactly that reason.
  checkout_state: {
    values: ['retrieved', 'unavailable', 'unknown'],
    derive(entries) {
      const entry = lastByTool(entries, TOOL_NAMES.LOOKUP_ABANDONED_CHECKOUT);
      if (!entry) return 'unknown';
      if (entry.outcome === 'found') return 'retrieved';
      // The customer was never identified, so nothing was actually searched —
      // reporting `unavailable` would claim the shop holds no basket for a
      // person we never resolved.
      if (entry.outcome === 'no_customer') return 'unknown';
      return 'unavailable';
    }
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
 * one. VIP is the shop's rule, answered by the customer lookup through the same
 * SQL function the dashboard uses, and carried here as the lookup reported it.
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
    // As the lookup answered it (vip-rule.mjs), not re-derived here: a second
    // derivation is how the case file and the queue badge would disagree.
    isVip: typeof account.isVip === 'boolean' ? account.isVip : null,
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
/**
 * The reaction record, lifted out of the ledger before the ledger loses it.
 *
 * WHY THIS IS NOT A FINDING. `reaction_product` already reads the same entry
 * and reduces it to one word, which is all a rule can branch on. But the words
 * — which product, which symptoms — are what a person opening the ticket needs,
 * and `buildCaseFile` keeps only `{id, tool, argsHash, outcome}` from every
 * ledger entry. One word survives the run; the record has to be taken out here
 * or it does not survive at all.
 *
 * NULL WHEN THE TOOL NEVER RAN, and that is not the same as a reaction with no
 * product. `not_attributed` is a customer who described a reaction and named
 * nothing; null is a ticket where nobody asked. Storing `{}` for both would
 * merge them, and the first is the case a rule acts on.
 *
 * @returns {{outcome: string, product: string|null, claimed: string|null,
 *            reaction: string|null, alternatives: string[]}|null}
 */
export function reactionReportFrom(ledger = []) {
  const entry = lastByTool(ledger, TOOL_NAMES.IDENTIFY_REACTION_PRODUCT);
  if (!entry) {
    return null;
  }
  const data = entry.data || {};
  const titles = Array.isArray(data.titles) ? data.titles.filter(Boolean) : [];
  return {
    outcome: FINDINGS.reaction_product.values.includes(entry.outcome) ? entry.outcome : 'unknown',
    // NAMED ONLY WHEN ONE PRODUCT RESOLVED. An `ambiguous` match has three
    // titles and no answer, and writing the first of them here would turn a
    // reported ambiguity into a recorded product — the exact false confidence
    // this whole subject is careful about.
    product: entry.outcome === 'identified' ? (titles[0] ?? null) : null,
    // The customer's own words, kept whatever the outcome: they are the only
    // thing on this record that is not a match, an inference or a guess.
    claimed: data.claimed ?? null,
    reaction: data.reaction ?? null,
    // What `ambiguous` actually means, for the person who has to resolve it.
    alternatives: entry.outcome === 'ambiguous' ? titles : []
  };
}

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

/**
 * Did any tool actually pin down WHICH code the customer means?
 *
 * `extractPromotionCodes` is crude on purpose and then filtered against the real
 * promotions table, so a `found` outcome means the code exists — which is
 * exactly the premise the active-listing leans on when it claims to settle
 * validity. Shared rather than inlined, on the same principle as
 * `productFromArticles`: a source's condition and the finding it feeds must read
 * the same thing or they drift apart.
 */
function promotionIdentified(entries = []) {
  return entries.some(
    (entry) => entry?.tool === TOOL_NAMES.EXTRACT_PROMOTION_CODES && entry.outcome === 'found'
  );
}

const DEPENDENCIES = {
  // --- product ---------------------------------------------------------------
  //
  // FILLED IN 2026-09-03. Fifteen of twenty-five needs had no prerequisite and
  // the whole product family was among them, so a planner walking this graph
  // would have proposed a stock check before knowing which product.
  //
  // `product_availability` REQUIRES IDENTITY AND `product_property` DOES NOT,
  // which looks inconsistent and is the point. Stock is a fact about one
  // variant, so without a product there is nothing to look up. A characteristic
  // can also be settled by the library — « vos produits sont-ils testés sur les
  // animaux ? » is answered without naming a product at all — and declaring a
  // prerequisite there would order a collection that does not need one.
  //
  // `product_recommendation` HAS NONE, deliberately: it asks what we can put
  // forward to somebody who has named nothing, which is the opposite end of the
  // same subject. Requiring identity would make it uncollectable exactly when it
  // is the need that matters.
  product_availability: { requires: ['product_identity'] },
  // An offer is scoped to a product, so there is nothing to look up until one
  // is named.
  product_offer: { requires: ['product_identity'] },
  // The reaction tool takes the model's reading of the email, so nothing has to
  // be established first — but a photo is evidence ABOUT a product, and chasing
  // one before knowing which product is a question nobody can act on.
  photo_evidence: { requires: ['product_identity'] },

  // --- customer --------------------------------------------------------------
  //
  // `verifyPurchase` answers "is this person a customer who bought online", and
  // it resolves the sender itself — but the order of collection still matters:
  // knowing who they are first is what makes an unverified purchase mean « nous
  // ne trouvons pas d'achat » rather than « nous ne vous trouvons pas ».
  purchase_verified: { requires: ['customer_identity'] },

  // The lookup matches on the customer's address, which lives on the customer
  // row rather than on the ticket — so resolving who wrote in is genuinely the
  // step before, not a preference about ordering.
  checkout_state: { requires: ['customer_identity'] },

  promotion_validity: { requires: ['promotion_identity'] },
  promotion_eligibility: {
    requires: ['promotion_validity'],
    moot: { promotion_validity: ['expired', 'not_yet_started', 'inactive', 'not_found'] }
  },

  customer_account_state: { requires: ['customer_identity'] },
  order_promotion: { requires: ['order_identity'] },
  customer_history: { requires: ['customer_identity'] },

  // Dormant with the order family, and correct for when it wakes up.
  order_state: { requires: ['order_identity'] },
  dispatch_state: { requires: ['order_identity'] },
  delivery_state: { requires: ['order_identity'] },
  delivery_delay_state: { requires: ['order_identity'] },
  payment_state: { requires: ['order_identity'] },
  refund_state: { requires: ['order_identity'] },
  return_eligibility: { requires: ['order_identity'] }
};

/**
 * Which askable facts we are ALREADY HOLDING, given what the run established.
 *
 * A need declares `asksCustomer` — the `MISSING_FIELDS` key to ask for when it
 * stays open. This is the mirror: the findings under which that question has
 * already been answered by our own tools and must not be put to the customer.
 *
 * ONLY THE IDENTITY NEEDS APPEAR, and that is the whole subtlety. `asksCustomer`
 * is many-to-one — five needs name `shopify_order_number` — but knowing an
 * order's STATE does not mean we hold its number; knowing its IDENTITY does. A
 * need that merely depends on the fact cannot vouch for it.
 *
 * `customer_account_state` is the one that is not an identity and belongs
 * anyway: every value except `unknown_sender` means we found the account, so
 * asking « sous quelle adresse votre compte est-il enregistré » is asking for
 * something already in the dossier.
 */
const ASK_ANSWERED_BY = {
  order_identity: ['resolved'],
  promotion_identity: ['resolved'],
  product_identity: ['resolved'],
  customer_identity: ['resolved'],
  customer_account_state: ['enabled', 'never_activated', 'known_no_account'],
  // Both mean something arrived. `attachment_type_unknown` is an attachment we
  // could not identify, which is still not a customer who sent nothing.
  //
  // `not_checked` IS DELIBERATELY ABSENT. It means we never asked the mailbox,
  // so it is not evidence that anything arrived and must not silence the ask.
  // After the attachment backfill it survives only where the mail has left the
  // mailbox altogether — and a photo we can no longer see is better answered by
  // asking for it again than by a ticket that stalls.
  photo_evidence: ['attached', 'attachment_type_unknown'],
  reaction_product: ['identified']
};

/**
 * The `MISSING_FIELDS` keys the dossier already answers.
 *
 * Read by `buildCaseFile` before a rule's `ask` reaches `missing`: a rule may
 * name a question, and the case file decides whether it is still worth asking.
 *
 * WHY IT LIVES HERE rather than beside the rule. The rule knows what it wants;
 * only the evidence vocabulary knows what has been found, and it already owns
 * both halves — `asksCustomer` on the way out and the findings on the way back.
 */
export function fieldsAlreadyAnswered(findings = {}) {
  const answered = new Set();
  for (const [need, values] of Object.entries(ASK_ANSWERED_BY)) {
    const field = NEEDS[need]?.asksCustomer;
    if (field && values.includes(findings[need])) {
      answered.add(field);
    }
  }
  return answered;
}

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

/**
 * `<need>:<finding>` pairs where a need that was NOT satisfied is nevertheless
 * entitled to a positive finding, because the finding says WHY it could not be
 * settled rather than claiming it was.
 *
 * "ONLY A SATISFIED NEED MAY MAKE A POSITIVE CLAIM" IS TOO STRONG A RULE, and
 * these four are why. Each says so in its own declaration above:
 *
 *   photo_evidence:mentioned_not_attached  — "the customer saying a photo is
 *     attached is not a photo", and the drafting prize besides: 36 of 203
 *     tickets, where « vous mentionnez une photo mais rien n'est joint » is a
 *     different reply from « merci de nous envoyer une photo ».
 *   product_identity:ambiguous  — a tie between two products is precisely the
 *     case where the reply must ask rather than pick.
 *   reaction_product:not_in_catalogue  — a real finding a rule branches on, and
 *     not a product we can name back to somebody reporting a reaction.
 *   product_property:weak  — the library answered below the band that answers.
 *
 * IT LIVES HERE RATHER THAN IN THE REPORT THAT FIRST NEEDED IT, because whether
 * a finding is a legitimate statement about a failure is a property of the
 * vocabulary, and two readers now ask: the vocabulary audit, and the
 * completeness gate through `gapClosability`.
 */
const DESIGNED_GAP = new Set([
  'photo_evidence:mentioned_not_attached',
  'product_identity:ambiguous',
  'reaction_product:not_in_catalogue',
  'product_property:weak'
]);

/**
 * Is this non-satisfying finding a statement the need is entitled to make?
 *
 * TRUE ONLY UNDER `attempted`, and the narrowing carries the argument: the same
 * pair under `satisfied` is still a contradiction — a tie cannot also be
 * resolved — and so is the same pair under `unavailable` or `not_attempted`,
 * because a tool that never ran cannot have found a tie. Only where the tool
 * actually ran is the value a finding rather than a fabrication.
 */
export function isDesignedGap(need, finding, state = 'attempted') {
  return state === 'attempted' && DESIGNED_GAP.has(`${need}:${finding}`);
}

/**
 * Findings that mean NO FURTHER COLLECTION CAN HELP — not by us, not by asking.
 *
 * Distinct from `DESIGNED_GAP` and the distinction is the point: both describe a
 * legitimate open need, but `photo_evidence: mentioned_not_attached` is one the
 * customer closes by attaching the photo, while this one nobody closes at all.
 *
 * `promotion_eligibility: undetermined` is the whole set today. The tool could
 * not decide because the basket is invisible to us, and it is excluded from
 * `satisfiedBy` deliberately so the gap is not laundered — asking the customer
 * what is in their basket does not make it checkable.
 */
const NOTHING_CAN_CLOSE = new Set(['promotion_eligibility:undetermined']);

/**
 * Who, if anyone, could still close this gap.
 *
 * WHY A GATE NEEDS THIS AND NOT JUST THE STATE. A completeness gate refuses an
 * `answerable` verdict while a declared need is open, which assumes somebody can
 * close it. Measured over the fresh corpus: of the 12 `answerable` runs a naive
 * gate would downgrade, FOUR have nothing open but gaps nobody can ever close,
 * and four more are part-way there. Downgrading those sends a ticket to a person
 * who can do no more about it than the agent could.
 *
 * ORDER MATTERS, and it is not the order of the states:
 *
 *   `other_fact` first, because it is unsatisfiable by design — the escape hatch
 *   that exists so a ticket whose real requirement is unnameable cannot report
 *   as complete. It fails towards a person on purpose, and that is not a gap to
 *   be closed.
 *
 *   `NOTHING_CAN_CLOSE` next, before the state is read at all: the finding is a
 *   stronger statement than the state here.
 *
 *   `not_attempted` before `asksCustomer`, because a tool was ALLOWED and the
 *   budget was there and nothing called it. That is our miss, and putting the
 *   question to a customer we never looked for the answer to is the one outcome
 *   this whole layer exists to prevent.
 *
 *   `asksCustomer` before `unavailable` ONLY WHERE THE QUESTION NAMES THE FACT
 *   ITSELF, which is the subtle half and neither ordering gets right on its own.
 *   `unavailable` means no tool in this ticket's registry can settle the need —
 *   on a cosmetovigilance ticket that is every tool, by design — and the
 *   customer can still be asked which product they used, which is exactly what
 *   CV-01 does. But `asksCustomer` is many-to-one, and on half the needs that
 *   carry one the question names a PREREQUISITE rather than the answer:
 *   `product_availability` asks for `product_name`, and being told the name does
 *   not tell us the stock — only `lookupStock` does, and `unavailable` is
 *   precisely the statement that it cannot run. Asking there costs the customer
 *   a reply and closes nothing.
 *
 *   `ASK_ANSWERED_BY` ALREADY DRAWS THAT LINE and is reused rather than
 *   restated: it is the table of needs whose own satisfaction answers their
 *   question, written for `fieldsAlreadyAnswered` with the same observation —
 *   knowing an order's STATE does not mean holding its number; knowing its
 *   IDENTITY does. Read forwards it says "stop asking, we have it"; read
 *   backwards it says "asking would actually get it".
 *
 * `unclear` is the honest remainder: attempted, found nothing, and no question
 * to put to anybody. It is a real class and deliberately not folded into
 * `never` — a knowledge gap somebody could write an article for is not the same
 * as a fact that does not exist.
 */
export function gapClosability(gap = {}) {
  const { need, finding = null, state = null, asksCustomer = null } = gap;
  if (need === 'other_fact') return 'never';
  if (NOTHING_CAN_CLOSE.has(`${need}:${finding}`)) return 'never';
  if (state === 'not_attempted') return 'now';
  // Where a tool COULD still run, the question is worth putting even when it
  // only supplies a key: the tool is there to use the answer. Where no tool can
  // run, only a question that names the fact itself closes anything.
  if (asksCustomer && (state !== 'unavailable' || need in ASK_ANSWERED_BY)) return 'customer';
  if (state === 'unavailable') return 'never';
  return 'unclear';
}

/**
 * Which needs a tool can establish — the `satisfiedBy` table, read backwards.
 *
 * A failing tool is only worth reporting against the needs it could have
 * settled: `lookupStock` erroring on a delivery ticket that declared no
 * availability need is noise, and the same error on a stock question is the
 * reason the answer is thin.
 */
/**
 * Which tools could establish this need, in the vocabulary's own order.
 *
 * ORDERED, AND THE ORDER IS THE PREFERENCE. `product_identity` lists
 * `lookupProduct` before `searchKnowledge` because the title matcher is the
 * direct answer and the article is the fallback that catches what no title
 * contains. A planner picking a tool for a need walks this list and takes the
 * first one the ticket is allowed and can supply arguments for.
 */
export function toolsForNeed(need) {
  return (NEEDS[need]?.satisfiedBy ?? []).map((source) => source.tool);
}

/**
 * What a COMPLETE REPLY on this subject rests on, per subject.
 *
 * The other half of the two stopping conditions. `nextNeed` returning null
 * means THE RULE IS DECIDED, not that the investigation is done: a rule
 * branches only on what changes the routing, and a reply needs facts that
 * change nothing about which answer is selected. Measured on the corpus — on
 * 58 of 90 runs the rule was already decided, and 50 of those still produced
 * established facts, 115 claims in all. Stopping on the rule alone would have
 * dropped the collection that produced them.
 *
 * TRANSLATED FROM `requiredEvidence`, NOT PROMOTED FROM IT. That list is prompt
 * text in its own key vocabulary (`product_identified`, `stock_known`), and the
 * mapping is mostly obvious — except for one entry that has no need at all.
 *
 * `knowledge_searched` IS DELIBERATELY ABSENT. « la base de connaissances a été
 * consultée » names a TOOL CALL, and a need is a FACT: `product_identity` is
 * "we know which product this is", never "lookupProduct ran". Admitting it here
 * would put the one shape this vocabulary refuses into the list that decides
 * when collection may stop. Nothing is lost by dropping it — `searchKnowledge`
 * is already an opening move on every subject that listed it.
 *
 * `return_state` MAPS TO `refund_state`, NOT `return_eligibility`. The label is
 * « l’état du retour ou du remboursement », which is what `refund_state`
 * reports; `return_eligibility` answers whether a return is still POSSIBLE and
 * resolves `unknown` on every ticket until the returns window is set, so a
 * floor built on it could never be met.
 */
const RESPONSE_NEEDS_BY_SUBJECT = {
  product: ['product_identity', 'product_property'],
  product_stock: ['product_identity', 'product_availability'],
  promotions: ['promotion_identity', 'promotion_validity'],
  account: ['customer_identity'],
  // The subject with no tools by design. Listed for completeness; it is never
  // rule-directed, so nothing here can end its loop early.
  cosmetovigilance: ['customer_identity', 'reaction_product'],
  other: [],
  // `customer_identity` ON ALL FOUR, added 2026-09-04 after the replay showed
  // the floor was lying about when a reply is ready: 24 established claims across
  // these subjects rest on `lookupCustomer`, and the floor named it nowhere. It
  // costs nothing to require now that the same commit made it an opening move.
  order: ['order_identity', 'customer_identity', 'order_state'],
  delivery: ['order_identity', 'customer_identity', 'delivery_state'],
  payment: ['order_identity', 'customer_identity', 'payment_state'],
  return_exchange: ['order_identity', 'customer_identity', 'refund_state']
};

/** The subject floor, plus whatever a rule added. Rules may ADD, never shrink. */
export function responseNeeds(subject, added = []) {
  const floor = RESPONSE_NEEDS_BY_SUBJECT[subject] ?? [];
  return normaliseNeeds([...floor, ...(Array.isArray(added) ? added : [])]);
}

/**
 * Has the run established everything a reply on this subject rests on?
 *
 * SATISFIED, MOOT, OR UNCLOSABLE. The first two are obvious. The third reuses
 * step 6’s `gapClosability`: a need nothing can ever close is not a reason to
 * keep collecting, and treating it as one would mean the loop never ends on any
 * subject carrying a need with no tool wired — which is most of them.
 *
 * A SUBJECT WITH NO FLOOR IS NOT COMPLETE, IT IS UNGOVERNED. `other` declares
 * nothing, so this returns false there rather than true: an empty list is the
 * absence of a rule about when to stop, not a licence to stop immediately.
 */
export function responseComplete(subject, resolved = [], added = []) {
  const wanted = responseNeeds(subject, added);
  if (wanted.length === 0) return false;

  const byNeed = new Map(resolved.map((item) => [item?.need, item]));
  const findings = {};
  for (const item of resolved) if (item?.finding != null) findings[item.need] = item.finding;

  return wanted.every((need) => {
    const item = byNeed.get(need);
    if (!item) return false;
    if (item.state === 'satisfied') return true;
    if (isMoot(need, findings)) return true;
    return gapClosability(item) === 'never';
  });
}

export function needsSatisfiedBy(tool) {
  return NEED_KEYS.filter((key) => NEEDS[key].satisfiedBy.some((source) => source.tool === tool));
}

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
        // `satisfies` is the optional narrower half of a source: tool + outcome
        // is coarse, and some evidence only counts conditionally. An answerable
        // knowledge result satisfies `product_identity` ONLY when the article it
        // found was tagged with a product — without this the need and its
        // finding drift apart, which is exactly the bug `product_property` had.
        // It reads the whole ledger, so a source can depend on what another tool
        // returned.
        if (source.outcomes.includes(entry.outcome) && (!source.satisfies || source.satisfies(entry, entries))) {
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
  // of the run: the subject is not allowed that tool — or, for `other_fact`,
  // nothing is wired for it at all and nothing ever will be.
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
