import { CASE_RELATIONSHIPS } from '../../../scripts/lib/case-state-record.mjs';
import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';

import { MISSING_FIELDS } from '../investigation/case-file.mjs';
import { NEED_KEYS, needLabel } from '../investigation/evidence-rules.mjs';
import { senderRoleName } from '../ingestion/sender-directory.mjs';

import { effectsFor } from './effects.mjs';

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
//
// SINCE 2026-09-26 (stage 5 of codex_plans/Case_State_Plan.md) IT READS EVERY
// MESSAGE, ours and a colleague's or partner's included, and adds four things,
// each from a closed list: the message's `effect`; for OUR message, which
// customer questions it `asked`; the checks it `opened` (an owner and a need);
// and which OPEN checks, from the list it is shown, it `cleared`. It still
// decides nothing: the fold (`case-fold.mjs`) turns these into who acts next.

/** The owners a check can have, in the words the model is shown. */
export const OWNER_WORDS = {
  support: 'nous (le service client)',
  colleague: 'un collègue (en interne)',
  partner: 'un partenaire opérationnel (entrepôt, transporteur)'
};

/**
 * The reading's schema for one message. Built per call because the effects
 * depend on who wrote the message, and the owners on which ones this brand has
 * (no operations partner, no `partner` to choose).
 */
export function caseReadingSchema({ actor = 'customer', owners = Object.keys(OWNER_WORDS) } = {}) {
  return {
    ...CASE_READING_SCHEMA,
    required: [...CASE_READING_SCHEMA.required, 'effect', 'asked', 'obligations_opened', 'obligations_cleared'],
    properties: {
      ...CASE_READING_SCHEMA.properties,
      effect: { type: 'string', enum: Object.keys(effectsFor(actor)) },
      asked: { type: 'array', items: { type: 'string' } },
      obligations_opened: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['owner', 'need', 'quote'],
          properties: {
            owner: { type: 'string', enum: owners },
            need: { type: 'string', enum: NEED_KEYS },
            quote: { type: 'string' }
          }
        }
      },
      obligations_cleared: { type: 'array', items: { type: 'string' } }
    }
  };
}

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
  "`effect` : ce que CE message fait au dossier, parmi les valeurs listées plus bas pour son émetteur.",
  "Un remerciement sans nouvelle demande est `closes_case`. Un « des nouvelles ? » sans rien de neuf est `chase`.",
  "`new_issue` seulement pour une DEUXIÈME demande distincte (une autre commande, un autre produit, un",
  "autre problème). Un nouveau symptôme, une précision ou une preuve sur la MÊME demande est `new_information`.",
  "Pour NOTRE message : `closes_case` quand il règle la demande et n'attend plus rien en retour ;",
  "`answers` quand il répond mais que la demande reste ouverte ; `asks_customer` dès qu'il pose une",
  "question au client ; `holding` quand il fait seulement patienter.",
  '',
  "`asked` : seulement si le message est de NOUS. Les questions, parmi la liste fournie, que ce",
  "message pose au client. Vide sinon.",
  '',
  "`obligations_opened` : une vérification ou une action que quelqu'un de NOTRE côté doit",
  "maintenant faire, d'après CE message (« je vérifie auprès de l'entrepôt », « merci de procéder",
  "au remboursement »). Le propriétaire est celui qui doit agir. Cite la phrase dans `quote`.",
  "N'en ouvre pas une qui figure déjà dans les vérifications en cours.",
  "Ce que nous DEMANDONS AU CLIENT va dans `asked`, jamais dans une vérification : attendre son",
  "numéro de commande n'est pas une vérification de notre côté. Identifier la commande ou le produit",
  "fait partie de notre réponse : n'ouvre jamais de vérification pour cela.",
  '',
  "`obligations_cleared` : les identifiants des vérifications EN COURS que ce message règle :",
  "leur propriétaire donne la réponse, ou notre message au client énonce le résultat.",
  "« On regarde » ne règle rien. Uniquement des identifiants de la liste.",
  '',
  "Écris toujours en français, quelle que soit la langue du fil."
].join('\n');

export function buildCaseReadingPrompt({
  ticket = {},
  message = {},
  conversation = [],
  pendingInputs = [],
  previousSummary = null,
  senderDirectory = null,
  actor = 'customer',
  openObligations = [],
  owners = Object.keys(OWNER_WORDS)
} = {}) {
  const own = splitQuotedReply(message?.body_text || '').own?.trim() || '';
  const asked = pendingInputs
    .filter((field) => Object.hasOwn(MISSING_FIELDS, field))
    .map((field) => `- ${field} : ${MISSING_FIELDS[field].label}`);
  const effects = Object.entries(effectsFor(actor)).map(([key, words]) => `- ${key} : ${words}`);
  const open = openObligations.map((o) => `- ${o.id} : ${OWNER_WORDS[o.owner] ?? o.owner} — ${needLabel(o.need) ?? o.need}`);
  const questions = Object.entries(MISSING_FIELDS).map(([key, field]) => `- ${key} : ${field.label}`);
  const needs = NEED_KEYS.map((key) => `- ${key} : ${needLabel(key) ?? key}`);
  const ownerLines = owners.map((key) => `- ${key} : ${OWNER_WORDS[key]}`);

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
    own || '(vide)',
    '',
    `# Valeurs possibles pour \`effect\` (message ${actor === 'support' ? 'de nous' : 'reçu'})`,
    effects.join('\n'),
    '',
    '# Vérifications en cours (identifiant : qui — quoi)',
    open.length > 0 ? open.join('\n') : '(aucune)',
    '',
    '# Propriétaires possibles',
    ownerLines.join('\n'),
    '',
    '# Besoins possibles pour une vérification',
    needs.join('\n'),
    '',
    '# Questions possibles au client (pour `asked`)',
    questions.join('\n')
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
export function normaliseCaseReading(
  answer,
  { pendingInputs = [], actor = 'customer', openObligations = [], owners = Object.keys(OWNER_WORDS) } = {}
) {
  const offered = new Set(pendingInputs.filter((field) => Object.hasOwn(MISSING_FIELDS, field)));
  const openIds = new Set(openObligations.map((o) => o.id));
  const openKeys = new Set(openObligations.map((o) => `${o.owner}|${o.need}`));
  const opened = [];
  for (const row of Array.isArray(answer?.obligations_opened) ? answer.obligations_opened : []) {
    const key = `${row?.owner}|${row?.need}`;
    if (!owners.includes(row?.owner) || !NEED_KEYS.includes(row?.need) || openKeys.has(key)) continue;
    openKeys.add(key);
    opened.push({ owner: row.owner, need: row.need, quote: text(row.quote) });
  }
  return {
    // WHAT THE MESSAGE DID, from the list for its sender, or null when the
    // answer is outside it: an unknown effect changes nothing downstream.
    effect: Object.hasOwn(effectsFor(actor), answer?.effect ?? '') ? answer.effect : null,
    // ONLY OUR MESSAGE ASKS, and only questions this codebase can word.
    asked: actor === 'support' ? array(answer?.asked).filter((field) => Object.hasOwn(MISSING_FIELDS, field)) : [],
    obligationsOpened: opened,
    // ONLY CHECKS THAT ARE OPEN: an id outside the list would clear nothing real.
    obligationsCleared: array(answer?.obligations_cleared).filter((id) => openIds.has(id)),
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
  actor = 'customer',
  openObligations = [],
  owners = Object.keys(OWNER_WORDS),
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
        senderDirectory,
        actor,
        openObligations,
        owners
      }),
      schema: caseReadingSchema({ actor, owners }),
      schemaName: 'case_reading',
      maxTokens: 900,
      pass: 'casework',
      ticketId: ticket?.id ?? null
    });
    return { ...normaliseCaseReading(answer, { pendingInputs, actor, openObligations, owners }), failed: false };
  } catch (error) {
    logger?.warn?.('casework.failed', { ticketId: ticket?.id, reason: error.message });
    return {
      caseRelationship: 'unclear',
      resolvedInputs: [],
      newFacts: [],
      commitments: [],
      contradictions: [],
      caseSummary: '',
      effect: null,
      asked: [],
      obligationsOpened: [],
      obligationsCleared: [],
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
