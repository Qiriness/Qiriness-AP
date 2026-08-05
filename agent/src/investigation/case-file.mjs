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
  product_name: {
    label: 'le produit concerné',
    ask: 'De quel produit s’agit-il exactement ?'
  },
  promotion_code: {
    label: 'le code promotionnel',
    ask: 'Pouvez-vous nous indiquer le code promotionnel que vous avez utilisé ?'
  },
  order_date_or_amount: {
    label: 'la date ou le montant de la commande',
    ask: 'Pouvez-vous nous préciser la date et le montant de la commande ?'
  },
  photo: {
    label: 'la photo du produit',
    ask: 'Pourriez-vous nous envoyer une photo du produit concerné ?'
  }
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
    'Ne pas annoncer de disponibilité ni de date de réassort : le stock n’a pas pu être établi.'
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
    knowledge: Array.isArray(knowledge) ? knowledge : [],
    // A POINTER, not a copy. The order/customer bundle already lives in
    // tickets.resolved_context: copying it here would duplicate personal data
    // across every investigation row and freeze a snapshot of a snapshot.
    contextRef,
    handoff: normaliseHandoff(answer.handoff),
    toolCalls: ledger.map(({ id, tool, argsHash, outcome }) => ({ id, tool, argsHash, outcome })),
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
  if (caseFile.toolCalls.length > 0) {
    parts.push(
      '## Outils appelés (interne)\n' +
        caseFile.toolCalls.map((c) => `- ${c.id} · ${c.tool} → ${c.outcome}`).join('\n')
    );
  }

  return parts.join('\n\n');
}

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
