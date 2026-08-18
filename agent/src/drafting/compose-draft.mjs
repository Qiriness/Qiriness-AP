import { toDraftingPrompt } from '../investigation/case-file.mjs';
import { toOrderContextText } from '../resolution/order-context.mjs';

// The per-ticket half of the drafting call: what this customer wrote, what the
// case file concluded, and the order facts a reply may rest on.
//
// IT READS RENDERINGS, NEVER ROWS. `toDraftingPrompt` and `toOrderContextText`
// are the two projections that already decided what a model may see — the first
// drops the handoff and the tool ledger, the second withholds join keys and
// names money only when a reply turns on it. Composing from the underlying rows
// here would quietly re-open both decisions.
//
// THE CASE FILE IS NOT RE-DERIVED. It is read back from the stored row exactly
// as the investigation wrote it, so a draft is always written from the reading
// that produced its verdict rather than from whatever the tools would say now.

/**
 * The stored `ticket_investigations` row, in the shape `toDraftingPrompt` reads.
 *
 * A mapper rather than a shared type: the row is snake_case jsonb and the case
 * file is a camelCase object, and the investigation builds the second from a
 * model answer while this builds it from the first. Only the fields the drafting
 * projection actually renders are mapped — `handoff`, `tool_calls` and
 * `dropped_claims` are absent here for the same reason they are absent there.
 */
export function caseFileFromRow(row) {
  return {
    verdict: row?.verdict || 'needs_human',
    established: array(row?.established),
    unverified: array(row?.unverified),
    missing: array(row?.missing),
    doNotClaim: array(row?.do_not_claim),
    knowledge: array(row?.knowledge)
  };
}

/**
 * The user message.
 *
 * ORDER IS DELIBERATE: the customer's own words first, then the dossier, then
 * the order facts. A model handed conclusions before the question tends to
 * answer the conclusions — measured elsewhere in this codebase and true here
 * too. The email is what is being replied to; everything after it is support.
 *
 * THE EXEMPLAR IS ABSENT, and that is a decision rather than an omission. The
 * exemplar layer holds QUESTIONS, not answers (05_exemplars.sql): matching one
 * tells the drafting model which recurring situation this is, which it can
 * already see from the email, and the reply text that would make it useful lives
 * in `support_answers`, which has no rows. Passing the canonical question would
 * add a second phrasing of the customer's own question to a prompt that already
 * contains it. When the skeletons are written, they come in here.
 */
export function composeDraftingMessage({
  message,
  caseFile,
  orderContext = null,
  ticket = null
} = {}) {
  const parts = [];

  parts.push(
    `# Message du client\n\n` +
      `Objet : ${message?.subject?.trim() || '(sans objet)'}\n\n${(message?.body_text || '').trim()}`
  );

  parts.push(toDraftingPrompt(caseFile));

  // Only when a bundle was built. `toOrderContextText` returns null for a
  // ticket with no confirmed order, which is 138 of the 214 — the absence is
  // the normal case, not a gap to apologise for in the prompt.
  const orderText = orderContext ? toOrderContextText(orderContext) : null;
  if (orderText) {
    parts.push(`## Commande concernée\n\n${orderText}`);
  }

  // The customer's name, when the thread carries one. Enough to open the reply
  // properly and nothing more — no address, no history, no email.
  if (ticket?.requester_name) {
    parts.push(`## Interlocuteur\n\n${ticket.requester_name}`);
  }

  return parts.join('\n\n');
}

/**
 * The shape the model must answer in.
 *
 * STRUCTURED OUTPUT FOR PROSE, which looks like a category error and is not.
 * The alternative is a free completion, and a free completion arrives wrapped:
 * « Voici la réponse : » before it, a note about the reasoning after it, and
 * occasionally the whole thing in a markdown fence. All of that would have to be
 * stripped by guesswork before the text could be shown to anyone, and a stripper
 * that guesses wrong mangles the reply. A schema makes the body a field.
 *
 * `subject` is nullable because most replies keep the thread's own subject; the
 * model proposes one only when the thread has none worth keeping.
 */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: {
      type: ['string', 'null'],
      description:
        'Objet de la réponse, uniquement si le fil n’en a pas d’utilisable. Sinon null.'
    },
    body: {
      type: 'string',
      description:
        'Le corps de l’e-mail, signature comprise. Aucun objet, aucun commentaire.'
    }
  }
};

/**
 * What went into this call, recorded beside the text it produced.
 *
 * The draft is prose and gives no account of itself: "why did it say that" is
 * unanswerable a week later unless the inputs were written down at the time.
 * Ids and counts rather than the content — the content is still in the rows
 * these point at, and copying it here would duplicate the case file per draft.
 */
export function promptInputs({ caseFile, orderContext, investigationId, model }) {
  return {
    investigation_id: investigationId || null,
    model: model || null,
    established_count: caseFile.established.length,
    unverified_count: caseFile.unverified.length,
    missing_fields: caseFile.missing.map((item) => item?.field).filter(Boolean),
    do_not_claim_count: caseFile.doNotClaim.length,
    knowledge_titles: caseFile.knowledge.map((chunk) => chunk?.title).filter(Boolean),
    order_context: Boolean(orderContext && toOrderContextText(orderContext))
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
