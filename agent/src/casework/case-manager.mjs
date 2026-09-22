import { CASE_RELATIONSHIPS } from '../../../scripts/lib/case-state-record.mjs';
import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';

import { MISSING_FIELDS } from '../investigation/case-file.mjs';
import { senderRoleName } from '../ingestion/sender-directory.mjs';

// What a new message changed about a case that already existed.
//
// ONE CALL, ONE QUESTION, AND A CLOSED VOCABULARY. It is asked how the newest
// message relates to the case, which of OUR outstanding questions it answered,
// what it added, and what we have promised. It is not asked what to do about
// any of that — `case-manager-rules.mjs` decides in code whether the categoriser
// re-runs and which situation the case is in, for the reason that file states.
//
// IT NEVER RUNS ON A NEW CASE. A first message has no prior reading to change,
// and the classifier already does this job for it. The queue is derived from
// "has a case file and no reading for its newest message", so a genuinely new
// ticket matches nothing and this costs it nothing.
//
// IT CANNOT NAME A SITUATION. The model is never shown the library and the
// schema has no field for one: the situation is carried forward in code, or
// dropped on `new_issue` and re-matched by the machinery that already does it.
// A Case Manager inventing situation names would be a second classifier with no
// calibration behind it.
//
// THE ASKS ARE OURS, NOT ITS. It picks from the `MISSING_FIELDS` keys the
// previous reading left outstanding — it cannot invent a question, and anything
// outside that set is dropped by `normaliseCaseReading`. The whole value of the
// table is that a question is recorded when it is ASKED; letting the reader
// mint new ones would put guesses back in.

export const CASE_READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['case_relationship', 'answered', 'new_facts', 'commitments', 'contradictions', 'case_summary'],
  properties: {
    case_relationship: { type: 'string', enum: CASE_RELATIONSHIPS },
    // Which of the questions WE asked this message answers. Keys, from the list
    // in the prompt; code owns what each one means.
    answered: { type: 'array', items: { type: 'string' } },
    new_facts: { type: 'array', items: { type: 'string' } },
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'status'],
        properties: { what: { type: 'string' }, status: { type: 'string', enum: ['pending', 'done'] } }
      }
    },
    // Where the message disagrees with something the case already held. Rare,
    // and worth a person's attention when it happens.
    contradictions: { type: 'array', items: { type: 'string' } },
    case_summary: { type: 'string' }
  }
};

const SYSTEM = [
  "Tu suis un dossier de service client déjà ouvert. Un nouveau message vient d'arriver.",
  "Une seule question : qu'est-ce que ce message change au dossier ?",
  '',
  "Tu ne rédiges aucune réponse, tu ne décides d'aucune action, tu ne nommes aucune situation.",
  '',
  '`case_relationship` :',
  "- continuation    : la même demande, qui avance. Rien de nouveau sur le fond.",
  "- new_information : la même demande, avec des faits qui n'y étaient pas.",
  "- new_issue       : une DEUXIÈME demande, distincte, dans le même fil.",
  "- unclear         : impossible de situer le message.",
  '',
  "Dans le doute entre continuation et new_information, choisis new_information :",
  "le coût est une relecture des libellés, pas un client répondu depuis le mauvais dossier.",
  '',
  "`answered` : parmi les questions QUE NOUS AVONS POSÉES et listées plus bas, celles",
  "auxquelles ce message répond. Uniquement ces clés-là, jamais d'autres.",
  '',
  "`commitments` : ce que NOUS nous sommes engagés à faire, d'après l'historique.",
  "`status: done` seulement si le fil montre que c'est fait.",
  '',
  "`new_facts` : ce que ce message apprend, en une phrase chacun.",
  "`contradictions` : ce qui contredit un élément déjà établi du dossier.",
  '',
  "Écris toujours en français, quelle que soit la langue du fil."
].join('\n');

export function buildCaseReadingPrompt({
  ticket = {},
  message = {},
  conversation = [],
  pendingInputs = [],
  previousSummary = null,
  senderDirectory = null
} = {}) {
  const own = splitQuotedReply(message?.body_text || '').own?.trim() || '';
  const asked = pendingInputs
    .filter((field) => Object.hasOwn(MISSING_FIELDS, field))
    .map((field) => `- ${field} : ${MISSING_FIELDS[field].label}`);

  return [
    `# Le dossier jusqu'ici`,
    `Objet : ${ticket.subject?.trim() || '(sans objet)'}`,
    `Sujet classé : ${ticket.category || 'inconnu'} / ${ticket.request_kind || 'inconnu'}`,
    previousSummary ? `Résumé de la dernière lecture : ${previousSummary}` : null,
    '',
    `# Ce que nous attendions du client`,
    asked.length > 0 ? asked.join('\n') : '(rien en attente)',
    '',
    `# L'échange, du plus ancien au plus récent`,
    renderForCasework(conversation, message, senderDirectory) || '(aucun historique)',
    '',
    `# Le nouveau message (émetteur : ${senderRoleName(message, senderDirectory)})`,
    own || '(vide)'
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/**
 * The thread minus the message being read, with each sender named.
 *
 * WHO SPOKE IS PART OF WHAT A MESSAGE MEANS, and this layer is the one where
 * getting it wrong is most expensive: a colleague's note read as the customer
 * answering our question would strike that question off the list, and it would
 * never be asked again.
 */
function renderForCasework(conversation, triggerMessage, senderDirectory) {
  return conversation
    .filter((row) => row?.id !== triggerMessage?.id)
    .map((row) => {
      const own = splitQuotedReply(row?.body_text || '').own?.trim();
      if (!own) return null;
      const at = row.received_at ? new Date(row.received_at).toISOString().slice(0, 10) : null;
      return `[${senderRoleName(row, senderDirectory)}${at ? ` — ${at}` : ''}]\n${own}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** The model's answer, reduced to what this codebase will act on. */
export function normaliseCaseReading(answer, { pendingInputs = [] } = {}) {
  const offered = new Set(pendingInputs.filter((field) => Object.hasOwn(MISSING_FIELDS, field)));
  return {
    // An unrecognised relationship reads as `unclear`, which is the value that
    // changes nothing: every pass runs as it did before this layer existed.
    caseRelationship: CASE_RELATIONSHIPS.includes(answer?.case_relationship)
      ? answer.case_relationship
      : 'unclear',
    // ONLY QUESTIONS WE ACTUALLY ASKED. A key outside the offered set is
    // dropped: striking off a question nobody posed would suppress it for ever.
    resolvedInputs: array(answer?.answered).filter((field) => offered.has(field)),
    newFacts: array(answer?.new_facts),
    commitments: Array.isArray(answer?.commitments)
      ? answer.commitments
          .filter((row) => text(row?.what))
          .map((row) => ({ what: text(row.what), status: row?.status === 'done' ? 'done' : 'pending' }))
      : [],
    contradictions: array(answer?.contradictions),
    caseSummary: text(answer?.case_summary)
  };
}

/**
 * One message, one call.
 *
 * A FAILURE READS AS `unclear`, which is the value that changes nothing: the
 * categoriser runs, the situation is re-matched, and the pipeline behaves
 * exactly as it did before this layer existed. The dangerous direction is a
 * rate limit silently suppressing a re-categorisation or striking a question
 * off a list, so the failure path takes neither decision.
 */
export async function readCase({
  openai,
  model,
  ticket,
  message,
  conversation = [],
  pendingInputs = [],
  previousSummary = null,
  senderDirectory = null,
  logger = null
}) {
  try {
    const answer = await openai.completeJson({
      model,
      system: SYSTEM,
      user: buildCaseReadingPrompt({
        ticket,
        message,
        conversation,
        pendingInputs,
        previousSummary,
        senderDirectory
      }),
      schema: CASE_READING_SCHEMA,
      schemaName: 'case_reading',
      maxTokens: 600,
      pass: 'casework',
      ticketId: ticket?.id ?? null
    });
    return { ...normaliseCaseReading(answer, { pendingInputs }), failed: false };
  } catch (error) {
    logger?.warn?.('casework.failed', { ticketId: ticket?.id, reason: error.message });
    return {
      caseRelationship: 'unclear',
      resolvedInputs: [],
      newFacts: [],
      commitments: [],
      contradictions: [],
      caseSummary: '',
      failed: true,
      error: error.message
    };
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function array(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
