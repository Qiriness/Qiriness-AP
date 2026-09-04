import { needsNamedBy, nextNeed } from './answer-selection.mjs';
import { needRequires, toolsForNeed } from './evidence-rules.mjs';
import { TOOL_NAMES } from './investigation-rules.mjs';

// Which fact to go and collect next, and the call that would establish it.
//
// Pure: answers in, resolved needs in, a proposal out. No database, no model, no
// clock — the same contract `answer-selection.mjs` keeps, and for the same
// reason: what to collect must be decidable mechanically or the layer is just a
// second model with extra steps.
//
// ADDITIVE ONLY. A proposal adds a call to a run; nothing here can remove one,
// end the loop, or change a verdict. Suppression is a later step gated on a
// replay that does not exist yet.
//
// WHY THIS IS NOT A TWO-LINE WRAPPER AROUND `nextNeed`. The plan said the one
// missing piece was turning a need into a callable tool. It was not — measured
// against P-18's own rules, `nextNeed` proposes `promotion_identity` on an empty
// findings map and NOTHING on the map a real run produces. The cause is below.

/**
 * `unknown` MEANS TWO THINGS AND THE PLANNER MUST NOT CONFLATE THEM.
 *
 * Every `derive` in the vocabulary returns `'unknown'` when its tool has not
 * run, so `findingsOf` hands back a value for every need a rule names — and
 * `nextNeed`'s candidate filter is `findings[need] === undefined`. Fed the flat
 * map, it therefore sees every need as already settled and proposes nothing,
 * ever.
 *
 * The distinction that is missing from the map is present in `resolveNeeds`:
 * `state`. `not_attempted` is "no tool in this ticket's registry has run for
 * it", which is precisely "not collected yet". Anything else — `satisfied`,
 * `attempted`, `unavailable` — means a tool spoke, and then `unknown` is a real
 * finding a rule is entitled to branch on.
 *
 * SO THE PLANNER READS STATE AND THE RULES READ FINDINGS, and neither has to
 * change to accommodate the other. This function is that translation and it is
 * the reason this module exists.
 */
export function collectedFindings(resolved = []) {
  const findings = {};
  for (const item of resolved) {
    if (!item || item.state === 'not_attempted') continue;
    if (item.finding == null) continue;
    findings[item.need] = item.finding;
  }
  return findings;
}

/**
 * The arguments each tool needs, assembled from the run rather than guessed.
 *
 * Returns `null` when they cannot be assembled, which is a real answer and not a
 * failure: `lookupPromotion` without an extracted code is the live case, and it
 * is exactly the position P-18 sits in on every ticket in the corpus. A planner
 * that guessed a code there would be inventing evidence.
 *
 * `identifyReactionProduct` IS ABSENT ON PURPOSE. Its arguments are the model's
 * reading of the email — which product the customer blames, and for what — so
 * there is nothing for code to assemble. It is excluded from opening moves for
 * the identical reason, and its absence here is what makes cosmetovigilance
 * never rule-directed. That costs nothing: the subject is routed to a person
 * whatever the evidence says.
 */
export function argsFor(tool, { ticket = {}, ledger = [] } = {}) {
  const text = String(ticket?.text ?? '').trim();

  switch (tool) {
    case TOOL_NAMES.SEARCH_KNOWLEDGE:
    case TOOL_NAMES.LOOKUP_CUSTOMER:
    case TOOL_NAMES.LIST_ACTIVE_PROMOTIONS:
    case TOOL_NAMES.GET_ORDER_CONTEXT:
    case TOOL_NAMES.VERIFY_PURCHASE:
    case TOOL_NAMES.CHECK_PHOTO_EVIDENCE:
      return {};

    // The semantic matchers read the customer's wording. No text, nothing to
    // match — the same reason `openingMoves` passes the whole email.
    case TOOL_NAMES.LOOKUP_PRODUCT:
    case TOOL_NAMES.LOOKUP_STOCK:
      return text ? { question: text } : null;

    // The literal matcher gets the RAW text: a code stops being present the
    // moment the wording is paraphrased.
    case TOOL_NAMES.EXTRACT_PROMOTION_CODES:
      return text ? { text } : null;

    // CHAINED, and the chain is why `DEPENDENCIES` puts `promotion_identity`
    // ahead of `promotion_validity`: the code has to be extracted before the
    // promotion can be looked up.
    case TOOL_NAMES.LOOKUP_PROMOTION: {
      const code = firstExtractedCode(ledger);
      return code ? { code } : null;
    }

    // `null` is a MEANINGFUL argument here, not a missing one: the tool reads
    // the skin type and concerns out of the message itself, and `product` is
    // only what the customer says they already use. Code cannot know that, and
    // the tool is built for not knowing it.
    case TOOL_NAMES.RECOMMEND_PRODUCTS:
      return { product: null };

    default:
      return null;
  }
}

/** The first code `extractPromotionCodes` actually found in the message. */
function firstExtractedCode(ledger = []) {
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const entry = ledger[i];
    if (entry?.tool !== TOOL_NAMES.EXTRACT_PROMOTION_CODES) continue;
    const codes = entry.data?.codes;
    if (Array.isArray(codes) && codes.length > 0) {
      return String(codes[0]);
    }
  }
  return null;
}

/**
 * The needs the rules name, plus everything those depend on.
 *
 * THE PREREQUISITES HAVE TO BE IN THE SET OR THE WALK CANNOT REACH THEM.
 * `firstUnmetPrerequisite` skips any prerequisite outside `available`, and P-18
 * is the case that proves it matters: its four rules branch on
 * `promotion_validity` alone, so the named set is one need, and the code that
 * has to be extracted first appears in no rule at all. Without this expansion
 * the planner proposes a lookup it can never supply an argument for; with it,
 * the first proposal on an untouched ticket is `extractPromotionCodes` — which
 * is the behaviour the plan describes and the reason `DEPENDENCIES` exists.
 */
export function collectableNeeds(answers = []) {
  const out = [];
  const seen = new Set();
  const visit = (need) => {
    if (seen.has(need)) return;
    seen.add(need);
    // Prerequisites first, so the list reads in collection order.
    for (const prerequisite of needRequires(need)) visit(prerequisite);
    out.push(need);
  };
  for (const need of needsNamedBy(answers)) visit(need);
  return out;
}

/**
 * The next call worth making, or null when the rules have nothing left to ask
 * for.
 *
 * `available` IS THE NEEDS THE RULES NAME, not the ones the ticket declared, and
 * the difference is the whole yield. The plan specified the declared set;
 * measured over 90 stored runs that proposes nothing at all, because the
 * decomposer declares what a good ANSWER rests on while the rules branch on what
 * separates one answer from another. With the rules' own needs, 31 of those runs
 * get a proposal.
 *
 * A need whose call cannot be assembled is SKIPPED rather than guessed, and the
 * search continues with the next-best need — otherwise one unreachable need at
 * the top of the ranking would silence the planner for the whole run.
 */
export function proposeCollection(
  answers = [],
  resolved = [],
  { situationKey = null, ticket = {}, ledger = [], allowedTools = [] } = {}
) {
  const named = collectableNeeds(answers);
  if (named.length === 0) {
    return null;
  }

  const findings = collectedFindings(resolved);
  const allowed = new Set(allowedTools);
  const skipped = new Set();

  // Bounded by the candidate set: every pass either returns or removes one need.
  for (let guard = 0; guard <= named.length; guard += 1) {
    const available = named.filter((need) => !skipped.has(need));
    const need = nextNeed(answers, findings, available, { situationKey });
    if (!need) {
      return null;
    }

    for (const tool of toolsForNeed(need)) {
      if (!allowed.has(tool)) continue;
      const args = argsFor(tool, { ticket, ledger });
      if (!args) continue;
      return {
        need,
        tool,
        args,
        // Read by a person in a transcript, never by a model.
        reason: `règle : ${need} sépare encore les réponses possibles`
      };
    }

    skipped.add(need);
  }

  return null;
}
