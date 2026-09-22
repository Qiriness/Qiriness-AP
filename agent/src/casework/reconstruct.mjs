import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';

import { senderRoleName } from '../ingestion/sender-directory.mjs';

// Reads a thread that ran to its end BEFORE any of this existed, and says where
// the case stands.
//
// WHY THIS IS NOT THE PIPELINE RUN AGAIN. Replaying a historical thread
// message by message would spend a categorisation, an investigation and a draft
// per message to rebuild a state we can read off the whole conversation in one
// pass — and it would do it against tools whose answers have moved on. This
// reads the finished thread the way a person picking up the case file would.
//
// IT WRITES NOTHING, AND THAT IS STRUCTURAL RATHER THAN POLICED. The runner is
// handed a reader and no record module, so there is no write path to forget to
// guard. The app cannot reach Shopify with anything but `read_*` scopes, the
// drafting pass makes no Graph call, and nothing here goes near either.
//
// WHAT THE MODEL IS ASKED FOR AND WHAT IT IS NOT. It reads prose and reports
// what the prose says — what was asked, what was promised, what is still open.
// It is never asked whether a refund happened. That is a fact about the backend,
// and `backendPosition` derives it from `tickets.resolved_context` in code. The
// two are reported side by side and never merged: a customer who was told
// « votre remboursement est parti » has been told that, which is a fact about
// the conversation and evidence of nothing else.
//
// THE SITUATION IS CHOSEN FROM THE LIBRARY, NEVER INVENTED. The model picks one
// of the shop's own `support_exemplars` keys or none, and `normaliseReconstruction`
// drops anything else. A reconstruction that minted its own situation names
// would produce a vocabulary nothing downstream could act on.

/** What the conversation claims about a remedy, which is not what happened. */
export const CLAIM_STATES = ['not_mentioned', 'promised', 'stated_done'];

/** What a commitment we made looks like from the thread alone. */
export const COMMITMENT_STATES = ['pending', 'done', 'unknown'];

export const RECONSTRUCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'situation_key',
    'customer_objective',
    'established_facts',
    'asked_by_qiriness',
    'commitments',
    'pending_customer_inputs',
    'pending_internal_actions',
    'open_issue',
    'case_summary',
    'refund_claimed',
    'replacement_claimed'
  ],
  properties: {
    // Null is a real answer and the schema says so. A thread that matches
    // nothing in the library is the honest outcome for a corpus the library was
    // never written against.
    situation_key: { type: ['string', 'null'] },
    customer_objective: { type: 'string' },
    established_facts: { type: 'array', items: { type: 'string' } },
    asked_by_qiriness: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'answered'],
        properties: { what: { type: 'string' }, answered: { type: 'boolean' } }
      }
    },
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'status'],
        properties: { what: { type: 'string' }, status: { type: 'string', enum: COMMITMENT_STATES } }
      }
    },
    pending_customer_inputs: { type: 'array', items: { type: 'string' } },
    pending_internal_actions: { type: 'array', items: { type: 'string' } },
    open_issue: { type: ['string', 'null'] },
    case_summary: { type: 'string' },
    // CLAIMS, NOT FACTS. Named so at the point of collection, because a field
    // called `refund` would be read as one three files later.
    refund_claimed: { type: 'string', enum: CLAIM_STATES },
    replacement_claimed: { type: 'string', enum: CLAIM_STATES }
  }
};

const SYSTEM = [
  "Tu relis un échange de service client terminé, pour dire OÙ EN EST LE DOSSIER.",
  "Tu ne rédiges aucune réponse et tu ne proposes aucune action commerciale.",
  '',
  "ÉCRIS TOUJOURS EN FRANÇAIS, quelle que soit la langue du fil. Ces lignes sont",
  "relues par l'équipe et servent d'étiquettes : un dossier résumé en anglais et",
  "le suivant en français ne se comparent pas.",
  '',
  "Règles :",
  "- Ne rapporte que ce que le fil dit. Si une information n'y figure pas, ne la déduis pas.",
  "- `situation_key` doit être une des clés proposées, ou null. N'invente jamais de clé.",
  "- `asked_by_qiriness` : ce que NOUS avons demandé au client, et si le client y a répondu.",
  "- `commitments` : ce que NOUS avons promis de faire. `done` seulement si le fil le montre fait.",
  "- `pending_customer_inputs` : ce qu'on attend encore du client.",
  "- `pending_internal_actions` : ce qu'il reste à faire de notre côté.",
  "- `refund_claimed` / `replacement_claimed` : ce que le fil DIT, jamais ce qui s'est passé.",
  "  `stated_done` = on a écrit que c'était fait. Cela ne prouve rien.",
  "- `open_issue` : null si plus rien n'est en suspens."
].join('\n');

/**
 * The thread, rendered for a reader who was not there.
 *
 * Both directions and every message, because the whole point is the trajectory;
 * this is a once-per-thread report, not a per-poll prompt, so the budget that
 * governs the live passes does not apply.
 */
export function renderThread(conversation = [], senderDirectory = null) {
  return conversation
    .map((message) => {
      const own = splitQuotedReply(message?.body_text || '').own?.trim();
      if (!own) return null;
      // « reçu » for every inbound message told the reader nothing. On
      // `45c0a2b7` the whole thread is internal coordination about three
      // different customers, and it reconstructed as one customer's case.
      const who = senderRoleName(message, senderDirectory);
      const at = timestamp(message);
      return `[${who}${at ? ` — ${at}` : ''}]\n${own}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildReconstructionPrompt({ ticket = {}, conversation = [], situations = [], senderDirectory = null } = {}) {
  const library = situations
    .map((row) => `- ${row.exemplar_key} : ${row.canonical_question}`)
    .join('\n');

  return [
    `# Fil à relire`,
    `Objet : ${ticket.subject?.trim() || '(sans objet)'}`,
    `Sujet classé : ${ticket.category || 'inconnu'} / ${ticket.request_kind || 'inconnu'}`,
    '',
    renderThread(conversation, senderDirectory),
    '',
    `# Situations disponibles`,
    library || '(aucune)',
    '',
    // The backend is deliberately NOT in this prompt. The model's job is to read
    // the conversation; mixing the order bundle in would let it report a refund
    // as established because Shopify shows one, which is the exact conflation
    // this report exists to keep apart.
    `Choisis une de ces clés ou null.`
  ].join('\n');
}

/**
 * The model's answer, reduced to what this codebase will stand behind.
 *
 * An unknown `situation_key` becomes null and is reported, never silently kept:
 * the whole value of the field is that it names something the rules layer can
 * already act on.
 */
export function normaliseReconstruction(answer, { situationKeys = [] } = {}) {
  const known = new Set(situationKeys);
  const proposed = typeof answer?.situation_key === 'string' ? answer.situation_key.trim() : null;
  const situationKey = proposed && known.has(proposed) ? proposed : null;

  return {
    situationKey,
    // Kept so the report can say the model reached for a key that does not
    // exist, which is a fact about the library as much as about the model.
    rejectedSituationKey: proposed && !situationKey ? proposed : null,
    customerObjective: text(answer?.customer_objective),
    establishedFacts: list(answer?.established_facts),
    askedByQiriness: Array.isArray(answer?.asked_by_qiriness)
      ? answer.asked_by_qiriness
          .filter((row) => text(row?.what))
          .map((row) => ({ what: text(row.what), answered: row.answered === true }))
      : [],
    commitments: Array.isArray(answer?.commitments)
      ? answer.commitments
          .filter((row) => text(row?.what))
          .map((row) => ({
            what: text(row.what),
            status: COMMITMENT_STATES.includes(row?.status) ? row.status : 'unknown'
          }))
      : [],
    pendingCustomerInputs: list(answer?.pending_customer_inputs),
    pendingInternalActions: list(answer?.pending_internal_actions),
    openIssue: text(answer?.open_issue) || null,
    caseSummary: text(answer?.case_summary),
    claims: {
      refund: CLAIM_STATES.includes(answer?.refund_claimed) ? answer.refund_claimed : 'not_mentioned',
      replacement: CLAIM_STATES.includes(answer?.replacement_claimed)
        ? answer.replacement_claimed
        : 'not_mentioned'
    }
  };
}

/**
 * What the backend actually shows, in code, from the bundle already stored.
 *
 * READ, NEVER RE-DERIVED — the same rule the investigation follows for
 * `resolved_context`: a second derivation of the same order would be a second,
 * divergent account of it.
 *
 * `replacement` is `not_representable` and will stay that way. Nothing in the
 * order bundle records "we sent one of these again for free"; a replacement
 * leaves the building as a fulfilment on some other order or on none. Saying so
 * is the point — the alternative is a field that reads `no` and means
 * « nous n'avons pas regardé ».
 */
export function backendPosition(resolvedContext) {
  const signals = resolvedContext?.signals || {};
  const refunds = resolvedContext?.order?.refunds || {};

  if (!resolvedContext?.order) {
    return { refund: 'no_order_resolved', replacement: 'not_representable' };
  }
  if (signals.isFullyRefunded === true || refunds.isFull === true) {
    return { refund: 'full', replacement: 'not_representable' };
  }
  if (signals.isRefunded === true || Number(refunds.count) > 0) {
    return { refund: 'partial', replacement: 'not_representable' };
  }
  return { refund: 'none', replacement: 'not_representable' };
}

/**
 * Where the conversation and the backend disagree, and only where they do.
 *
 * `stated_done` against `none` is the one that matters: a customer was told a
 * refund was processed and the store shows none. That is either a promise
 * nobody kept or an order nobody resolved, and both are worth a person's time.
 */
export function contradictions({ claims, backend }) {
  const out = [];
  if (claims.refund === 'stated_done' && backend.refund === 'none') {
    out.push('Le client a été informé d’un remboursement effectué ; la commande n’en montre aucun.');
  }
  if (claims.refund === 'stated_done' && backend.refund === 'no_order_resolved') {
    out.push('Le client a été informé d’un remboursement effectué ; aucune commande n’est rattachée au ticket.');
  }
  return out;
}

/**
 * One thread, one call.
 *
 * NEVER THROWS FOR A THREAD. A report over a corpus stops being a report the
 * moment one bad row ends the run, so a failure becomes a row saying so and the
 * next thread is read.
 */
export async function reconstructCase({
  openai,
  model,
  ticket,
  conversation,
  situations = [],
  senderDirectory = null,
  logger = null
}) {
  const base = {
    ticketId: ticket?.id ?? null,
    subject: ticket?.subject ?? null,
    status: ticket?.status ?? null,
    messages: conversation.length,
    inbound: conversation.filter((m) => m.direction !== 'outbound').length,
    outbound: conversation.filter((m) => m.direction === 'outbound').length
  };

  try {
    const answer = await openai.completeJson({
      model,
      system: SYSTEM,
      user: buildReconstructionPrompt({ ticket, conversation, situations, senderDirectory }),
      schema: RECONSTRUCTION_SCHEMA,
      schemaName: 'case_reconstruction',
      // A whole thread's reading runs longer than a classification: the facts,
      // the asks and the summary are all prose.
      maxTokens: 900,
      pass: 'reconstruct',
      ticketId: ticket?.id ?? null
    });

    const reading = normaliseReconstruction(answer, {
      situationKeys: situations.map((row) => row.exemplar_key)
    });
    const backend = backendPosition(ticket?.resolved_context);

    if (reading.rejectedSituationKey) {
      logger?.warn?.('reconstruct.unknown_situation', {
        ticketId: ticket?.id,
        proposed: reading.rejectedSituationKey
      });
    }

    return {
      ...base,
      ...reading,
      backend,
      contradictions: contradictions({ claims: reading.claims, backend })
    };
  } catch (error) {
    logger?.warn?.('reconstruct.failed', { ticketId: ticket?.id, reason: error.message });
    return { ...base, error: error.message };
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function timestamp(message) {
  const at = message?.received_at || message?.sent_at;
  if (!at) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
