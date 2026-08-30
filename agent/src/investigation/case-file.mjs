// The case file — what the investigation agent hands to the drafting agent.
//
// This module is the CONTRACT, and it is pure: a model answer plus a ledger of
// what actually ran go in, a verified case file and its two renderings come out.
// No I/O, no clock beyond what the caller passes.
//
// WHY A SEPARATE OBJECT AT ALL. Same argument as `tickets.resolved_context`: a
// drafting model that has to assemble context field by field will assemble it
// differently every time. It reads one bundle, and the bundle is reviewable
// afterwards — you can see exactly what the reply was told.
//
// THE FOUR SECTIONS ARE NEVER MERGED. `established` (facts), `unverified`
// (doubts), `missing` (what to ask for) and `doNotClaim` (what must not be
// asserted) render as four headed blocks. This is not formatting: the promotion
// tool already learned it the hard way. Merged into one list, a model treats a
// doubt as a fact and writes « votre code est valide, réessayez » to someone
// whose basket is under a minimum nobody can see.
//
// THREE THINGS THE MODEL DOES NOT GET TO DECIDE, each for the reason the derived
// `level` exists — two model-set fields must never be able to contradict each
// other about the same thing:
//   1. `replyIntent` is derived from the verdict.
//   2. `doNotClaim` is derived from the caveats the tools reported.
//   3. The wording of a question to the customer is looked up from `field`,
//      not composed. The model picks WHICH fact is missing, from an enum; the
//      sentence that asks for it is ours.
//
// There is deliberately no confidence field. It was asked for once and came back
// `high` on 171 of 171 live tickets. The verdict plus a non-empty `unverified`
// list carry that information honestly.

/** The three outcomes. Three-valued, like every other verdict in this codebase. */
export const VERDICTS = ['answerable', 'needs_customer_input', 'needs_human'];

/**
 * What the reply has to DO, derived from the verdict.
 *
 * `acknowledge` does not mean "send an acknowledgement" — Phase 5 decides that
 * under DRAFT_ONLY. It means the reply cannot resolve anything, so a human owns
 * the next move.
 */
const REPLY_INTENTS = {
  answerable: 'answer',
  needs_customer_input: 'ask',
  needs_human: 'acknowledge'
};

/**
 * Where the verdict leaves the ticket in the queue.
 *
 * Until now the verdict lived only in `metadata.verdict` and the investigation
 * row, so `status` could not tell a ticket waiting on a customer from one nobody
 * had opened — measured, all 214 tickets read `open`. The queue was built on a
 * column carrying no information.
 *
 * `answerable` STAYS OPEN, deliberately. It means a reply could be written, not
 * that one was sent, and nothing sends yet: drafting is Phase 5. Moving it out of
 * the queue now would mark work as handled that no customer has received. When
 * drafting lands, the sent reply is what advances it — not this verdict.
 */
export const TICKET_STATUS_BY_VERDICT = {
  answerable: null,
  needs_customer_input: 'awaiting_customer',
  needs_human: 'awaiting_human'
};

/**
 * The facts a customer can be asked for, and the sentence that asks.
 *
 * The model chooses the key; this table writes the question. A model composing
 * its own « pourriez-vous… » is prose heading for a customer, drafted by the
 * stage whose whole point is that it never talks to one — and it would reword
 * the same question differently on every ticket.
 */
// Labels carry their article, and the prohibition template below avoids any
// agreement with them ("cette information", not a pronoun): French renders
// "il doit être demandé" wrong for "la photo" and right for "le numéro", and a
// template that has to agree with its slot will eventually be given a slot it
// disagrees with.
export const MISSING_FIELDS = {
  shopify_order_number: {
    label: 'le numéro de commande',
    ask:
      'Pourriez-vous nous communiquer le numéro de commande (au format #XXXX) ' +
      'qui figure dans votre e-mail de confirmation ?'
  },
  purchase_email: {
    label: 'l’adresse e-mail de la commande',
    ask: 'Avec quelle adresse e-mail la commande a-t-elle été passée ?'
  },
  // SEPARATE FROM `purchase_email`, WHICH ASKS ABOUT AN ORDER. On an account
  // ticket the order is not the subject and may not exist at all — the customer
  // in the corpus writing « je pense que j'ai 2 adresses mail pour mon compte »
  // has ordered under one and is trying to sign in under the other. Asking which
  // address the ORDER was placed with gets the wrong one of the two.
  account_email: {
    label: 'l’adresse e-mail du compte',
    ask:
      'Sous quelle adresse e-mail votre compte est-il enregistré ? ' +
      'Si vous en utilisez plusieurs, indiquez-les toutes : nous vérifierons laquelle ' +
      'porte le compte.'
  },
  product_name: {
    label: 'le produit concerné',
    ask: 'De quel produit s’agit-il exactement ?'
  },
  purchase_channel: {
    label: 'où l’achat a été effectué',
    // The question a retail purchase forces, and the reason the three-state
    // verification exists: nothing in Shopify records a sale made at a till, so
    // an address we cannot place is a question and not a verdict.
    ask:
      'Avez-vous acheté ce produit sur notre site, ou en boutique ? ' +
      'Si c’est en boutique, pourriez-vous nous indiquer laquelle ?'
  },
  photo: {
    label: 'une photo du produit concerné',
    ask:
      'Pourriez-vous nous envoyer une photo du produit et de son emballage ? ' +
      'Cela nous permettra de traiter votre demande plus rapidement.'
  },
  promotion_code: {
    label: 'le code promotionnel',
    ask: 'Pouvez-vous nous indiquer le code promotionnel que vous avez utilisé ?'
  },
  order_date_or_amount: {
    label: 'la date ou le montant de la commande',
    ask: 'Pouvez-vous nous préciser la date et le montant de la commande ?'
  },
  // SEPARATE FROM `product_name`, WHICH ASKS THE SAME THING BADLY. « De quel
  // produit s'agit-il exactement ? » is a fine question about an order and the
  // wrong one here: a reaction email has usually already named several products,
  // so asking which one it "is about" reads as not having read the message. This
  // asks the only question that actually separates them.
  reaction_product_name: {
    label: 'le produit utilisé au moment de la réaction',
    ask:
      'Pourriez-vous nous indiquer quel produit vous utilisiez lorsque cette réaction ' +
      'est apparue ? Si vous en appliquiez plusieurs, n’hésitez pas à tous nous les citer.'
  },
  // ASKED FOR THE PRODUCT, NOT FROM THE CUSTOMER'S MEMORY. The lot number is
  // printed on the packaging, and saying where it is turns an impossible
  // question into a thirty-second one — which is the difference between a reply
  // that gets answered and one that ends the thread.
  lot_number: {
    label: 'le numéro de lot du produit',
    ask:
      'Pourriez-vous nous communiquer le numéro de lot du produit ? Il est imprimé ' +
      'sur l’emballage ou sous le contenant, et commence généralement par « L ». ' +
      'Il nous permet de remonter jusqu’au lot de fabrication concerné.'
  }
  // `photo` WAS DECLARED TWICE IN THIS OBJECT, here and above. The later one won
  // silently — that is what a duplicate key does — so the live sentence asked
  // only for « une photo du produit concerné » and the one above it, asking for
  // the product AND ITS PACKAGING, was unreachable for as long as both existed.
  //
  // The packaging is not decoration. On « il manque un article dans le colis »
  // there is no product to photograph; the box is the evidence, because whether
  // there was room for the missing item is visible in it. The surviving sentence
  // asked for the one thing that case does not have.
};

/**
 * Caveats a tool call can raise, and the prohibition each one produces.
 *
 * The vocabulary is the seam between the tools and this module: the registry
 * translates each tool's own result shape into these codes, so nothing here has
 * to know what `evaluateEligibility` returns or how `matchProduct` reports a
 * tie. Adding a tool means adding a caveat, not editing this table's consumers.
 *
 * Every line is a *negative*. A prohibition is worth more than an instruction
 * here because the failure mode is a model filling a gap with something
 * plausible, and « ne pas affirmer X » is checkable by a human reading the reply.
 */
export const CAVEATS = {
  basket_unseeable:
    'Ne jamais affirmer ce que contient le panier actuel du client : ' +
    'la boutique ne l’expose pas.',
  eligibility_undetermined:
    'Ne pas affirmer que le code fonctionnera ni qu’il est refusé à tort : ' +
    'l’éligibilité n’a pas pu être vérifiée entièrement.',
  order_unconfirmed:
    'Ne pas présenter les informations de commande comme étant celles de ce client : ' +
    'le rattachement de la commande n’est pas confirmé.',
  product_ambiguous:
    'Ne pas choisir un produit parmi ceux proposés : la demande peut correspondre ' +
    'à plusieurs produits, il faut faire préciser.',
  // Weak chunks are not attached to the case file at all (see tool-registry):
  // showing text a model is told not to use is a temptation with no upside. The
  // line exists so the gap is stated rather than silently absent.
  knowledge_weak:
    'Aucun article approuvé ne répond de façon fiable à cette question — les articles ' +
    'les plus proches ont été écartés : ne rien affirmer sur ce point.',
  knowledge_none:
    'Aucun article approuvé ne répond à cette question : ne rien inventer sur ce point.',
  customer_unknown:
    'Ne pas supposer que le client a un compte ou un historique : aucune fiche client ' +
    'ne correspond à cette adresse.',
  stock_unknown:
    'Ne pas annoncer de disponibilité ni de date de réassort : le stock n’a pas pu être établi.',
  // THE PROHIBITION IS AGAINST THE DENIAL, not against the doubt. A sale made in
  // a physical shop never reaches Shopify, so "aucune commande trouvée" is a
  // statement about our records and not about the customer — and telling someone
  // holding the product that they never bought it is the worst reply this whole
  // check exists to prevent.
  purchase_unverified:
    'Ne pas affirmer que cette personne n’a rien acheté ni qu’elle n’est pas cliente : ' +
    'l’achat n’a pas pu être vérifié, et un achat en boutique physique n’apparaît jamais ' +
    'dans nos données. Demander où l’achat a été effectué.',
  // WHAT WE CANNOT SEE, PHRASED SO IT CANNOT BE REPEATED. The reason is
  // deliberately absent: saying "no carrier scan is available" in a prohibition
  // is saying it to the model, and the model paraphrased exactly that to 8
  // customers before this existed. It states what may not be claimed and stops.
  delivery_unscanned:
    'Ne pas décrire où se trouve le colis, ni son avancement, ni annoncer une date ' +
    'de livraison : rien n’est établi au-delà de l’expédition. Ne rien dire non plus ' +
    'du suivi transporteur lui-même.',
  attachments_unrecorded:
    'Ne pas affirmer qu’aucune photo n’a été envoyée : les pièces jointes de ce message ' +
    'n’ont pas été enregistrées, leur contenu est inconnu.',
  // RAISED ON EVERY OUTCOME OF `identifyReactionProduct`, INCLUDING SUCCESS —
  // which is the opposite of every other caveat here. The others fire when
  // something could not be established; this one fires hardest when something
  // WAS. Naming the product a customer blames is the moment a reply is most
  // tempted to agree that it is to blame, and agreeing is a claim about a
  // cosmetic product's safety that nobody at this desk is in a position to make.
  //
  // It forbids the denial too. « Ce produit ne peut pas causer cela » is the
  // same unfounded claim with the sign flipped, and it is the one a reply
  // defending the brand reaches for.
  reaction_cause_unestablished:
    'Ne jamais affirmer, ni suggérer, que ce produit est à l’origine de la réaction — ' +
    'ni l’inverse. Le lien de cause à effet n’est pas établi et ne peut pas l’être ici. ' +
    'Ne proposer aucun diagnostic, aucune explication par les ingrédients et aucun ' +
    'traitement : reprendre ce que le client décrit, sans le commenter.'
};

export const CAVEAT_CODES = Object.keys(CAVEATS);

/**
 * The model's half of the case file, as a Structured Outputs schema.
 *
 * Note what is NOT here: `do_not_claim`, `knowledge`, `tool_calls`,
 * `context_ref`, `proposed_level`. Those are produced by code — by this module,
 * by the registry, and by `investigation-rules.mjs` — precisely so the model
 * cannot assert them.
 *
 * Strict mode requires every property in `required` and forbids numeric bounds,
 * so "absent" is expressed as null and enums do the constraining.
 */
export const CASE_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    established: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          // The ledger ids this claim rests on. A claim with an id we never
          // issued is dropped — see verifyFindings.
          evidence_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['claim', 'evidence_ids']
      }
    },
    unverified: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          why: { type: 'string' }
        },
        required: ['claim', 'why']
      }
    },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', enum: Object.keys(MISSING_FIELDS) }
        },
        required: ['field']
      }
    },
    handoff: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        action: { type: 'string' },
        why: { type: 'string' }
      },
      required: ['action', 'why']
    }
  },
  required: ['verdict', 'established', 'unverified', 'missing', 'handoff']
};

/**
 * Drops every claim that does not rest on a tool call this run actually made.
 *
 * THE GUARDRAIL THAT MATTERS MOST. A wrong case file does not merely produce a
 * wrong reply — it becomes the drafting agent's ground truth, and every check
 * downstream is applied to prose written from it. A model that has read a
 * customer saying "j'ai bien été livré" can restate that as an established fact
 * without any tool ever having said so; requiring an id from the ledger is what
 * separates "a tool reported this" from "the email asserted this".
 *
 * A dropped claim is not lost information: the same content, if it came from the
 * customer, belongs in `unverified`, which is exactly where the prompt tells the
 * model to put it.
 */
export function verifyFindings(established, ledger = []) {
  const issued = new Set(ledger.map((entry) => entry.id));
  const kept = [];
  const dropped = [];

  for (const finding of Array.isArray(established) ? established : []) {
    const claim = typeof finding?.claim === 'string' ? finding.claim.trim() : '';
    const ids = Array.isArray(finding?.evidence_ids)
      ? finding.evidence_ids.filter((id) => issued.has(id))
      : [];
    if (!claim) {
      continue;
    }
    if (ids.length === 0) {
      dropped.push(claim);
      continue;
    }
    kept.push({ claim, evidence_ids: [...new Set(ids)] });
  }

  return { established: kept, dropped };
}

/**
 * Builds the prohibitions from what the tools reported and what is missing.
 *
 * Mechanical on purpose. Asked for them, a model produces the caveats it happens
 * to remember — and it is least likely to remember the one covering the gap it
 * has just filled in.
 */
export function deriveDoNotClaim({ caveats = [], missing = [] } = {}) {
  const lines = [];
  for (const code of [...new Set(caveats)]) {
    if (CAVEATS[code]) {
      lines.push(CAVEATS[code]);
    }
  }
  for (const entry of missing) {
    const field = MISSING_FIELDS[entry?.field];
    if (field) {
      lines.push(`Ne pas supposer ${field.label} : cette information doit être demandée au client.`);
    }
  }
  return [...new Set(lines)];
}

/**
 * Assembles the stored case file from the model's answer and everything code
 * knows independently of it.
 *
 * The verdict can be overridden downwards here — never upwards. If verification
 * left no established fact, the ticket goes to a human whatever the model
 * concluded, because a verdict of `answerable` resting on nothing is the single
 * most expensive output this stage could produce.
 */
export function buildCaseFile({
  answer = {},
  ledger = [],
  caveats = [],
  knowledge = [],
  contextRef = null,
  proposedLevel = null,
  escalationReasons = [],
  evidenceGaps = [],
  // Who declared the needs behind `evidenceGaps`: `model` when the decomposer
  // read the ticket, `exemplar` when it failed and a matched situation's
  // declared needs stood in, `none` when neither produced anything.
  needsSource = 'none',
  // Which policy rule this evidence selected, and what it does.
  //
  // NO LONGER A SHADOW. This comment said "RECORDED, NOT APPLIED" until the
  // route went live below — `applyPolicyRoute` reads `policy.route` and can
  // tighten the verdict with it — and a comment claiming the opposite of the
  // code twenty lines under it is worse than no comment.
  //
  // TIGHTEN ONLY, which is what made wiring it in safe: the schema forbids a
  // rule routing to `answerable`, and the rank check below refuses a rule that
  // would step DOWN from what the investigation concluded. A rule that fires on
  // the wrong ticket can send it to a person; it can never clear one.
  policy = null,
  // The customer's most recent order, when none was confirmed. Passed in rather
  // than derived here: it must not depend on whether the model happened to call
  // an order tool, and on a `product` ticket there is no order tool to call.
  candidateOrder = null,
  // What the customer blames for their reaction, and the symptoms they describe.
  // Passed in for the same reason `candidateOrder` is — this module never reads
  // a ledger entry's `data` — and null on every ticket where no reaction tool
  // ran, which is every subject but one.
  reactionReport = null,
  model = null,
  now = new Date()
} = {}) {
  const { established, dropped } = verifyFindings(answer.established, ledger);
  const unverified = normaliseUnverified(answer.unverified);
  const missing = normaliseMissing(answer.missing);

  let verdict = VERDICTS.includes(answer.verdict) ? answer.verdict : 'needs_human';
  // Nothing survived verification: whatever was concluded, it was not concluded
  // from evidence.
  if (established.length === 0 && verdict === 'answerable') {
    verdict = 'needs_human';
  }

  // --- the policy rule, applied ---------------------------------------------
  //
  // TIGHTEN ONLY, AND BY RANK RATHER THAN BY TRUST. The schema already forbids
  // a rule routing to `answerable`, so a rule can never say "this is safe". This
  // is the other half: a rule may not step DOWN either. If the investigation
  // concluded a person is needed and a rule says to ask the customer, the rule
  // loses — a written policy is a floor under the verdict, never a ceiling on
  // it, because the investigation saw this ticket and the rule saw a category.
  //
  // The rank is the only ordering in this file, and it is deliberately shallow:
  // "we can answer" < "the customer must answer" < "one of us must act".
  const verdictBeforePolicy = verdict;
  verdict = applyPolicyRoute(verdict, policy).verdict;

  // THE RULE'S QUESTIONS TRAVEL WHENEVER ASKING IS PERMITTED — not only when the
  // ROUTE was what permitted it, which is what this used to say and it dropped
  // them on exactly the tickets the rule agreed with.
  //
  // MEASURED, on the live reaction ticket that prompted the list: the model had
  // already concluded `needs_customer_input` by itself, so the route changed
  // nothing, so `applyPolicyRoute` reported no ask, so the rule's « quel produit
  // utilisiez-vous » and « quel est le numéro de lot » never reached `missing`.
  // The reply asked whatever the model had thought of instead — which is the
  // non-determinism this whole layer exists to remove, arriving through the one
  // branch where the rule and the investigation AGREED.
  //
  // GATED ON THE FINAL VERDICT, so nothing is loosened. A rule asking for the
  // batch number against an investigation that concluded a person is needed
  // still loses: the route could not tighten `needs_human` down to
  // `needs_customer_input`, the verdict stays where it was, and this branch does
  // not run. The questions only ever join a reply that was already going to ask.
  if (verdict === 'needs_customer_input') {
    for (const field of policyAsks(policy)) {
      if (!missing.some((entry) => entry.field === field)) {
        missing.push({ field });
      }
    }
  }

  // A verdict of "ask the customer" that names nothing to ask for is not
  // actionable by the drafting stage — it would have to invent the question.
  if (verdict === 'needs_customer_input' && missing.length === 0) {
    verdict = 'needs_human';
  }

  return {
    verdict,
    replyIntent: REPLY_INTENTS[verdict],
    established,
    unverified,
    missing,
    doNotClaim: deriveDoNotClaim({ caveats, missing }),
    // The order a human should check first when none was confirmed. Supplied by
    // the runner, OUTSIDE the model's tool loop, and never shown to the drafting
    // stage -- see the runner's `lastOrderLookup`.
    candidateOrder: candidateOrder || {},
    // NULL RATHER THAN `{}`, unlike `candidateOrder` directly above it. An empty
    // candidate order means "we looked and there was none"; an empty reaction
    // report would have to mean both "no reaction was reported" and "one was,
    // with nothing identified", and those need different replies. Null is the
    // first; `outcome: 'not_attributed'` is the second.
    reactionReport: reactionReport || null,
    knowledge: Array.isArray(knowledge) ? knowledge : [],
    // A POINTER, not a copy. The order/customer bundle already lives in
    // tickets.resolved_context: copying it here would duplicate personal data
    // across every investigation row and freeze a snapshot of a snapshot.
    contextRef,
    handoff: normaliseHandoff(answer.handoff),
    toolCalls: ledger.map(({ id, tool, argsHash, outcome }) => ({ id, tool, argsHash, outcome })),
    // What answering this ticket required, and what the run actually got: one
    // entry per declared need, each `satisfied` / `attempted` / `unavailable` /
    // `not_attempted`. DIAGNOSTIC, NOT A VERDICT INPUT — it is read by people and
    // counted in reports, and deliberately does not move the verdict yet. See
    // `evidence-rules.mjs` for why acting on it is a separate step.
    evidenceGaps: Array.isArray(evidenceGaps) ? evidenceGaps : [],
    // WHICH SOURCE DECLARED THEM, and it has to be recorded rather than inferred:
    // the whole value of comparing an exemplar's declared needs against the run's
    // own is that the two are independent, and a row where the exemplar supplied
    // them is not evidence of agreement. Reports must exclude `exemplar` rows.
    needsSource,
    // The rule the evidence selected, and what it did.
    //
    // `applied` REPLACED `would_change_verdict` WHEN THE ROUTE WENT LIVE, and
    // the rename matters: with the route applied, `route !== verdict` is false
    // precisely when the rule worked, so the old field would have reported
    // "changed nothing" on every ticket it moved. The verdict the investigation
    // reached on its own is kept beside it, because that comparison is the only
    // way to audit the layer once it stops being a shadow.
    policy: policy
      ? {
          ...policy,
          verdict_before_policy: verdictBeforePolicy,
          applied: verdict !== verdictBeforePolicy
        }
      : null,
    proposedLevel,
    // Why the level moved, in the human's words rather than a number changing on
    // its own. Computed by investigation-rules, never by the model.
    escalationReasons: Array.isArray(escalationReasons) ? escalationReasons : [],
    droppedClaims: dropped,
    model,
    investigatedAt: now.toISOString()
  };
}

/**
 * What the drafting agent reads.
 *
 * `handoff` and the tool ledger are ABSENT, not merely discouraged. Internal
 * notes ("rembourser et relancer le transporteur") reaching a customer reply is
 * the failure this split exists to make impossible, and a second renderer is a
 * cheaper guarantee than a sentence in a prompt asking the model not to repeat
 * what it was shown.
 */
export function toDraftingPrompt(caseFile) {
  const parts = [`# Dossier — ${describeVerdict(caseFile.verdict)}`, describeIntent(caseFile)];

  parts.push(
    `## Établi\n${
      caseFile.established.length > 0
        ? caseFile.established.map((f) => `- ${f.claim}`).join('\n')
        : '- Aucun fait n’a pu être établi.'
    }`
  );

  if (caseFile.unverified.length > 0) {
    parts.push(
      '## Non vérifié (ne pas présenter comme un fait)\n' +
        caseFile.unverified.map((u) => `- ${u.claim} — ${u.why}`).join('\n')
    );
  }

  if (caseFile.missing.length > 0) {
    parts.push(
      '## À demander au client\n' +
        caseFile.missing.map((m) => `- ${MISSING_FIELDS[m.field].ask}`).join('\n')
    );
  }

  if (caseFile.doNotClaim.length > 0) {
    parts.push('## Ne pas affirmer\n' + caseFile.doNotClaim.map((l) => `- ${l}`).join('\n'));
  }

  if (caseFile.knowledge.length > 0) {
    parts.push(
      '## Base de connaissances approuvée\n' +
        caseFile.knowledge
          .map((chunk) => `### ${chunk.title || 'Article'}\n${chunk.text || ''}`)
          .join('\n\n')
    );
  }

  return parts.join('\n\n');
}

/**
 * What a human sees in the queue. Everything above, plus the two things a
 * customer must never receive: what somebody has to go and do, and what the
 * agent actually ran to reach this.
 */
export function toHumanBrief(caseFile) {
  const parts = [toDraftingPrompt(caseFile)];

  // Before the handoff: it is the first thing a person would otherwise go and
  // look up, and the whole reason for keeping it is to save them that step.
  const candidate = caseFile.candidateOrder?.order;
  if (candidate?.name) {
    const items = (candidate.items || []).map((item) => item.title).filter(Boolean);
    const tracking = (candidate.delivery?.tracking || []).map((t) => t.number).filter(Boolean);
    const lines = [`- Commande : ${candidate.name}`];
    lines.push(
      `- Statut : ${candidate.status?.fulfillment || 'inconnu'}` +
        (candidate.status?.payment ? ` · paiement ${candidate.status.payment}` : '')
    );
    if (items.length > 0) lines.push(`- Articles : ${items.join(', ')}`);
    if (tracking.length > 0) lines.push(`- Suivi : ${tracking.join(', ')}`);
    lines.push('- Le client n’a donné aucun numéro : à vérifier avant toute réponse.');
    parts.push(
      '## Dernière commande de ce client (interne — piste, non confirmée)\n' +
        lines.join('\n')
    );
  }

  if (caseFile.handoff) {
    parts.push(`## Action requise (interne)\n- ${caseFile.handoff.action}\n- Motif : ${caseFile.handoff.why}`);
  }
  if (caseFile.escalationReasons.length > 0) {
    parts.push(
      `## Escalade automatique vers le niveau ${caseFile.proposedLevel}\n` +
        caseFile.escalationReasons.map((reason) => `- ${reason}`).join('\n')
    );
  }
  if (caseFile.droppedClaims.length > 0) {
    // Surfaced rather than silently discarded: a run that keeps producing
    // unsourced claims is a prompt problem worth seeing.
    parts.push(
      '## Affirmations écartées (sans source)\n' +
        caseFile.droppedClaims.map((claim) => `- ${claim}`).join('\n')
    );
  }
  // Only the OPEN needs. A satisfied one is already visible as an established
  // fact, and listing it again would bury the two lines a reviewer needs.
  const open = (caseFile.evidenceGaps || []).filter((gap) => gap.state !== 'satisfied');
  if (open.length > 0) {
    parts.push(
      '## Éléments attendus et non obtenus (interne)\n' +
        open.map((gap) => `- ${gap.label} — ${GAP_STATES[gap.state] || gap.state}`).join('\n')
    );
  }

  if (caseFile.toolCalls.length > 0) {
    parts.push(
      '## Outils appelés (interne)\n' +
        caseFile.toolCalls.map((c) => `- ${c.id} · ${c.tool} → ${c.outcome}`).join('\n')
    );
  }

  return parts.join('\n\n');
}

/**
 * Why a need is still open, in a reviewer's terms.
 *
 * `not_attempted` reads as an accusation on purpose: the other three are the
 * world being uncooperative, and that one is the agent having had the tool, the
 * budget and the permission, and not using them.
 */
const GAP_STATES = {
  attempted: 'cherché, rien trouvé',
  unavailable: 'aucun outil ne peut le fournir ici',
  not_attempted: 'AUCUNE RECHERCHE FAITE alors qu’un outil était disponible'
};

function describeVerdict(verdict) {
  switch (verdict) {
    case 'answerable':
      return 'de quoi répondre au client';
    case 'needs_customer_input':
      return 'une information manque côté client';
    default:
      return 'traitement humain nécessaire';
  }
}

function describeIntent(caseFile) {
  switch (caseFile.replyIntent) {
    case 'answer':
      return 'Intention : répondre à la demande à partir des éléments ci-dessous.';
    case 'ask':
      return 'Intention : demander l’information manquante, sans rien affirmer d’autre.';
    default:
      return 'Intention : le dossier part à un humain — ne rien promettre ni conclure.';
  }
}

function normaliseUnverified(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      claim: String(entry?.claim || '').trim(),
      why: String(entry?.why || '').trim()
    }))
    .filter((entry) => entry.claim && entry.why);
}

/** Unknown keys are dropped rather than defaulted: an invented field has no question to ask. */
/** How far a verdict takes a ticket out of the agent's hands. Higher wins. */
const VERDICT_RANK = { answerable: 0, needs_customer_input: 1, needs_human: 2 };

/**
 * The route a matched rule asks for, applied only when it tightens.
 *
 * RETURNS THE DECISION RATHER THAN MAKING IT, so the caller keeps the single
 * place a verdict is assigned. A rule with no route, no rule at all, or a route
 * the investigation has already passed leaves the verdict exactly where it was.
 */
function applyPolicyRoute(verdict, policy) {
  const route = policy?.route ?? null;
  if (!route || !(route in VERDICT_RANK)) {
    return { verdict };
  }
  if (VERDICT_RANK[route] <= VERDICT_RANK[verdict]) {
    return { verdict };
  }
  return { verdict: route };
}

/**
 * The facts a matched rule names, as a list.
 *
 * A LIST BECAUSE ONE RULE CAN REQUIRE TWO: a reaction reported with no product
 * named needs the product AND the batch number, and asking for one and then the
 * other is two round trips with somebody waiting on an answer about their skin.
 *
 * Tolerates a bare string, because the column was a single key until 2026-08-30
 * and a row or a caller written against that shape must not silently ask for
 * nothing — which would be invisible, since a `needs_customer_input` verdict
 * with an empty `missing` is turned straight back into `needs_human` below.
 */
function policyAsks(policy) {
  const ask = policy?.ask;
  if (Array.isArray(ask)) {
    return ask.filter(Boolean);
  }
  return ask ? [ask] : [];
}

function normaliseMissing(entries) {
  const seen = new Set();
  const kept = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const field = entry?.field;
    if (MISSING_FIELDS[field] && !seen.has(field)) {
      seen.add(field);
      kept.push({ field });
    }
  }
  return kept;
}

function normaliseHandoff(handoff) {
  const action = String(handoff?.action || '').trim();
  const why = String(handoff?.why || '').trim();
  return action ? { action, why } : null;
}
