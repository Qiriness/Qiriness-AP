import { toDraftingPrompt } from '../investigation/case-file.mjs';
import { fillParameters } from '../../../scripts/lib/parameters.mjs';
import { normaliseTones, toneInstructions } from '../../../scripts/lib/reply-tones.mjs';
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
// The ceiling on a pinned article in the prompt. The longest approved document
// is 18k characters against a 2.5k median, and one article that dwarfs the case
// file is an article the reply gets written from instead of the evidence.
const MAX_PINNED_ARTICLE_CHARS = 6000;

export function caseFileFromRow(row) {
  return {
    verdict: row?.verdict || 'needs_human',
    established: array(row?.established),
    unverified: array(row?.unverified),
    missing: array(row?.missing),
    doNotClaim: array(row?.do_not_claim),
    knowledge: array(row?.knowledge),
    // ONE FIELD OUT OF `exemplar_match`, NAMED. That column also holds the
    // similarity, the margin, the runner-up and every finding the run resolved —
    // diagnostics for a person, none of which a customer's reply has any use
    // for. Reading the skeleton by name is the narrowing; spreading the object
    // would put the whole diagnostic one careless renderer away from a prompt.
    answerSkeleton: skeletonOf(row),
    // The code the matched rule offers, as the rule named it. Whether it is
    // still live is decided below, not here — this is the record of what was
    // decided, and a stored run has to read back the same either way.
    offerCode: offerCodeOf(row),
    // The article the matched rule pinned, as an ID. Resolved below against the
    // documents still approved, for the same reason the code is: an operator can
    // unapprove an article between the investigation and the draft.
    knowledgeDocumentId: pinnedArticleIdOf(row),
    // The tones the matched rule set, read by name like everything above. Empty
    // for the Brand voice alone, which is every rule saved before tones existed.
    tones: tonesOf(row)
  };
}

/**
 * The skeleton with its parameters filled in, or null when they cannot be.
 *
 * DROPPED WHOLE RATHER THAN SENT HALF-FILLED, and this is the decision worth
 * arguing with. A skeleton reading « le retour est possible jusqu'à
 * {returns_window_days} jours » with nothing set has three possible treatments:
 *
 *   send it as-is   — the model sees a brace-wrapped token and either copies it
 *                     into the reply or invents a number to replace it. Both put
 *                     something in front of a customer that nobody wrote.
 *   refuse to draft — blocks the ticket entirely over a wording gap, when the
 *                     case file and the route are both perfectly good.
 *   drop it         — the draft is written from the facts alone, which is
 *                     exactly the behaviour before skeletons existed.
 *
 * The third degrades to something already known to work, and the miss is
 * recorded rather than silent: an unset parameter is a decision outstanding, and
 * the log line is how it stops being invisible.
 */
function resolveSkeleton(skeleton, parameters, logger) {
  if (!skeleton) {
    return null;
  }
  const filled = fillParameters(skeleton, parameters);
  if (filled.resolved) {
    return filled.text;
  }
  logger?.warn?.('draft.skeleton_dropped', {
    unknown: filled.unknown,
    unset: filled.unset
  });
  return null;
}

/**
 * The code the rule offers, IF IT IS STILL ONE WE OFFER.
 *
 * RE-CHECKED AT DRAFTING TIME, and this is the whole reason it is not a foreign
 * key. `promotions` is rewritten by the Shopify sync, so a code chosen months
 * ago may since have expired, been deactivated, or been taken off the offerable
 * list by an operator. A rule pointing at it is not broken — the rest of its
 * answer is still right — so the offer is dropped and the reply is written
 * without it, exactly the treatment `resolveSkeleton` gives a parameter nobody
 * has set.
 *
 * DROPPED LOUDLY. A code that has quietly stopped being offered is a rule that
 * has quietly stopped doing what it was written for, and the log line is how
 * that stops being invisible.
 */
function resolveOfferCode(code, offerableCodes, logger) {
  if (!code) {
    return null;
  }
  if (offerableCodes?.has?.(code)) {
    return code;
  }
  logger?.warn?.('draft.offer_code_dropped', { code });
  return null;
}

/**
 * The pinned article's text, or null when it can no longer be used.
 *
 * THE SAME TREATMENT AN OFFER CODE GETS, and for the same reason: an operator
 * pins an article once and can unapprove or delete it later, so what the rule
 * recorded is a claim about the past. Dropping degrades to the behaviour before
 * pinning existed -- the draft is written from the case file and whatever
 * retrieval found -- rather than blocking a ticket over a library edit.
 *
 * CAPPED. The longest approved document is 18k characters against a 2.5k median,
 * and a prompt where one article dwarfs the case file is a prompt that gets
 * answered from the article. Truncation is logged, because an article that keeps
 * hitting the ceiling wants pinning by section instead.
 */
function resolvePinnedArticle(id, pinnedArticles, logger) {
  if (!id) {
    return null;
  }
  const article = pinnedArticles?.get?.(id) ?? null;
  if (!article) {
    logger?.warn?.('draft.pinned_article_dropped', { knowledgeDocumentId: id });
    return null;
  }
  const text = String(article.text ?? '').trim();
  if (text.length === 0) {
    logger?.warn?.('draft.pinned_article_dropped', { knowledgeDocumentId: id, reason: 'empty' });
    return null;
  }
  if (text.length > MAX_PINNED_ARTICLE_CHARS) {
    logger?.warn?.('draft.pinned_article_truncated', {
      knowledgeDocumentId: id,
      length: text.length,
      cap: MAX_PINNED_ARTICLE_CHARS
    });
    return { title: article.title ?? null, text: text.slice(0, MAX_PINNED_ARTICLE_CHARS) };
  }
  return { title: article.title ?? null, text };
}

/** The code a matched rule carried, or null. */
function offerCodeOf(row) {
  const value = row?.exemplar_match?.policy?.offer_code;
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The article id a matched rule pinned, or null. */
function pinnedArticleIdOf(row) {
  const value = row?.exemplar_match?.policy?.knowledge_document_id;
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The tones a matched rule set, as catalogue keys. Empty for the Brand voice alone. */
function tonesOf(row) {
  return normaliseTones(row?.exemplar_match?.policy?.tones);
}

/** The wording guidance a matched rule carried, or null. Nothing else. */
function skeletonOf(row) {
  const value = row?.exemplar_match?.policy?.answer_skeleton;
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The user message.
 *
 * ORDER IS DELIBERATE: the customer's own words first, then the dossier, then
 * the order facts. A model handed conclusions before the question tends to
 * answer the conclusions — measured elsewhere in this codebase and true here
 * too. The email is what is being replied to; everything after it is support.
 *
 * THE EXEMPLAR'S QUESTION IS STILL ABSENT, and its ANSWER now is not. Matching a
 * situation tells the model which recurring case this is — which it can already
 * see from the email — so passing the canonical question would add a second
 * phrasing of the customer's own words to a prompt that already holds them. The
 * skeleton is the half carrying what the email does not: what a reply to this
 * situation, in this evidence position, is supposed to DO.
 *
 * IT IS GUIDANCE, NOT A REPLY, and the prompt says so in those words. A skeleton
 * is shared across situations by design — « pas encore expédiée » answers both
 * « où en est ma commande » and « pourquoi n'est-elle pas partie » — so it is
 * written about the shape of an answer, never as one. Handing it over as text to
 * send would produce identical replies to different customers, which is the one
 * thing the drafting stage exists to avoid.
 */
export function composeDraftingMessage({
  message,
  caseFile,
  orderContext = null,
  ticket = null,
  chase = null,
  // The numbers a skeleton may quote. Empty is safe: a skeleton naming one that
  // is unset is dropped rather than sent half-filled — see below.
  parameters = new Map(),
  // The codes an operator has marked offerable, loaded once per poll by the
  // caller. Empty is safe: an offer whose code is not in here is dropped.
  offerableCodes = new Set(),
  // The articles rules pin, loaded once per poll by the caller the same way.
  // Empty is safe: a pin whose document is not in here is dropped, which is what
  // an unapproved or deleted article looks like from here.
  pinnedArticles = new Map(),
  logger = null
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

  // AFTER THE FACTS, deliberately. The model needs to know what this reply is
  // FOR while the evidence is still in view, and placing it above the case file
  // would let an instruction about shape outrank the facts it is shaped around —
  // the same reason the customer's own words come first.
  //
  // The framing is the load-bearing part. Told to "follow this", a model returns
  // the skeleton with a greeting bolted on; told it is an internal instruction
  // about the shape of a reply, it writes one.
  const skeleton = resolveSkeleton(caseFile?.answerSkeleton, parameters, logger);
  if (skeleton) {
    parts.push(
      `## Ce que cette réponse doit faire\n\n` +
        `Consigne interne sur la FORME de la réponse, écrite pour ce cas de figure. ` +
        `Ce n’est pas un texte à envoyer et il ne doit jamais être recopié tel quel : ` +
        `rédiger la réponse au client à partir des faits ci-dessus, en suivant cette consigne.\n\n` +
        skeleton
    );
  }

  // THE TONE A PERSON CHOSE FOR THIS CASE. After the skeleton, because the
  // skeleton says what the reply does and this says how it should land; before
  // the code and the article, which are the material it does it with.
  //
  // FRAMED AS AN ADJUSTMENT, NOT A VOICE. The Brand voice in the system prompt is
  // how Qiriness always sounds, and the structural rules there outrank anything
  // here — a tone able to override « n'affirmer que ce qui est établi » would be
  // an apology that promises a refund. No tone adds no section, so every rule
  // saved before tones existed drafts exactly as it did.
  const toneText = toneInstructions(caseFile?.tones);
  if (toneText) {
    parts.push(
      `## Ton de cette réponse\n\n` +
        `Ton choisi par l’équipe pour ce cas de figure. Il ajuste la voix de la marque sans la remplacer, ` +
        `et ne change ni les faits, ni ce que la réponse doit faire, ni les règles prioritaires.\n\n` +
        toneText
    );
  }

  // THE CODE THE RULE OFFERS, AND THE ONLY PLACE ONE MAY COME FROM. A discount
  // code is the one thing in a reply a model must never compose: it looks like a
  // word and it is a key, so an invented one is indistinguishable from a real one
  // until the customer types it in. Naming it here — after the skeleton that
  // decided the reply would make an offer, and as a literal to reproduce — is
  // what makes "do not invent a code" enforceable rather than hopeful.
  //
  // AFTER THE SKELETON, deliberately: the skeleton says what the reply does, and
  // this is the value it does it with. A code arriving above the instruction that
  // frames it reads as a fact about the ticket and gets quoted at random.
  const offerCode = resolveOfferCode(caseFile?.offerCode, offerableCodes, logger);
  if (offerCode) {
    parts.push(
      `## Code à communiquer au client

` +
        `Ce code a été choisi pour ce cas de figure. Le donner au client, ` +
        `EXACTEMENT tel qu’il est écrit ici, sans le modifier ni en inventer un autre :

` +
        offerCode +
        `

Si la réponse ne se prête pas à transmettre un code, ne pas en parler — ` +
        `mais ne jamais en citer un différent.`
    );
  }

  // THE ARTICLE A PERSON CHOSE FOR THIS SITUATION, under its own heading and
  // deliberately not inside « Base de connaissances approuvée ». That section is
  // what retrieval scored and cleared; this one is what an operator decided
  // answers this case. Same library, different provenance — and a reply written
  // from the wrong assumption about which is which is a different kind of
  // mistake, so the prompt does not blur them.
  //
  // AFTER THE SKELETON, for the reason the code is: the skeleton says what the
  // reply must do, and this is the material it does it with.
  const pinned = resolvePinnedArticle(caseFile?.knowledgeDocumentId, pinnedArticles, logger);
  if (pinned) {
    parts.push(
      `## Article de référence pour cette situation

` +
        `Cet article a été retenu par l'équipe comme la source qui répond à ce cas. ` +
        `Répondre à partir de lui, et ne rien affirmer qu'il ne dise pas :

` +
        (pinned.title ? `### ${pinned.title}
` : '') +
        pinned.text
    );
  }

  // WE LEFT THEM WAITING, stated as a fact rather than left to be inferred from
  // the customer's tone. Measured on the corpus: 12 threads hold an unanswered
  // chase and only 4 mention it in words, so a model reading the prose alone
  // would miss most of them. The rule that says what to do about it is in the
  // system prompt; this is only the fact.
  if (chase?.chased) {
    parts.push(
      `## Historique de l’échange\n\n` +
        `Le client a écrit ${chase.unanswered} fois sans avoir reçu de réponse de notre part.`
    );
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
    order_context: Boolean(orderContext && toOrderContextText(orderContext)),
    // Keys, not the wording: which tones shaped this reply, readable a week later.
    tones: array(caseFile.tones)
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
