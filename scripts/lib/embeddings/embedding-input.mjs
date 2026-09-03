import { createHash } from 'node:crypto';

import { stripQuotedReply, STRIPPER_VERSION } from '../quoted-reply.mjs';

// Builds the exact text sent to the embedding model, and a stable hash of it.
// Two composers: one for knowledge chunks (the corpus) and one for email
// messages (both query and corpus — see AGENT_INTEGRATION_PLAN.md).
//
// Short retrieval chunks embed better with a little context, so a chunk is
// prefixed with its document title and section heading.
//
// THE CATEGORY IS DELIBERATELY NOT INCLUDED. Retrieval always filters by
// category first, so embedding the category name into every chunk adds a
// near-constant to every candidate inside the filtered set — and a constant
// contributes nothing to ranking while diluting the actual content. `title`
// already gives a bare chunk its topical anchoring ("Livraison et retours"),
// which is what stops a fragment like "Comptez 3 à 5 jours ouvrés" floating free.
//
// This is deliberately separate from knowledge_chunks.content_hash: that hash
// covers only { source, section_index, text }, so a title rename would NOT
// change it. The embedded input DOES include the title, so we track a dedicated
// embedded_input_hash — a rename must invalidate the vector.
//
// Determinism matters here: the same logical input must always produce the same
// composed string (and therefore the same hash), so trailing whitespace and
// blank fields can never cause a spurious re-embed.

const FIELD_SEPARATOR = '\n\n';

function normalizeField(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Knowledge chunk: `title → section_heading → chunk_text`.
 *
 * @param {object} input
 * @param {string} [input.title]           parent document title
 * @param {string} [input.section_heading] chunk's section heading
 * @param {string} [input.chunk_text]      the chunk body (required to be useful)
 * @returns {string} deterministic composed input string
 */
export function buildEmbeddingInput({ title, section_heading, chunk_text } = {}) {
  const parts = [
    normalizeField(title),
    normalizeField(section_heading),
    // The chunk body keeps its internal paragraph structure; only the edges are
    // trimmed. Collapsing all whitespace here would harm the embedding.
    String(chunk_text ?? '').trim()
  ];

  return parts.filter(Boolean).join(FIELD_SEPARATOR);
}

/**
 * Subject lines that are OUR OWN, and therefore say nothing about the customer.
 *
 * The contact form notifies us with « Nouveau message de client le 7 août 2026 à
 * 09:51 » and the order confirmation is titled « Votre commande est confirmée »;
 * a customer replying to either inherits the subject. **225 of 574 inbound
 * messages carry one** — 39% — and the second kind is worse than empty: a
 * complaint that an order never arrived, embedded under a heading announcing
 * that it was confirmed.
 *
 * THIS IS THE SAME ARGUMENT THE CHUNK COMPOSER ALREADY MAKES ABOUT CATEGORIES,
 * applied to the query side where it had never been. A near-constant prefixed to
 * two fifths of all queries contributes nothing to ranking and dilutes the
 * sentence that does — and the date inside it makes hundreds of unrelated
 * tickets share a phrase they have no business sharing.
 *
 * MEASURED before it was written, on 60 tickets whose best match sat in
 * 0.55–0.65 with one of these subjects: **9 crossed into `matched`, 0 fell out**,
 * and the median margin rose 13% (0.038 → 0.043). A third changed which exemplar
 * won, and by subject agreement — the same proxy the band was calibrated with —
 * that churn is neutral: 33 of 60 agreed before and after. So it converts near
 * misses without making the matches it changes any less relevant.
 *
 * MATCHED AGAINST THE SUBJECT ONLY, never the body: a customer who happens to
 * write « votre commande est confirmée ? » in a sentence is asking us something.
 */
export const SHOP_NOTIFICATION_SUBJECTS = [
  /^nouveau message de client\b/i,
  /^votre commande est confirmée\b/i,
  /^votre commande .* est en route\b/i,
  /^confirmation de commande\b/i
];

/** Strips the reply/forward markers a subject accumulates down a thread. */
const REPLY_MARKERS = /^(?:\s*(?:re|ré|tr|fw|fwd)\s*:\s*)+/i;

/**
 * Is this subject one of ours rather than the customer's?
 *
 * The markers are stripped first, because « RE: RE: Nouveau message de client »
 * is the same worthless heading three replies later — and that shape is common
 * in the corpus.
 */
export function isShopNotificationSubject(subject) {
  const bare = String(subject ?? '').replace(REPLY_MARKERS, '').trim();
  return bare.length > 0 && SHOP_NOTIFICATION_SUBJECTS.some((pattern) => pattern.test(bare));
}

/**
 * Email message: `subject → cleaned, quote-stripped body`.
 *
 * The subject is kept because support subject lines carry real signal ("Colis
 * bloqué", "remboursement commande #5229") — EXCEPT when the subject is one we
 * wrote ourselves, which is 39% of them. See `SHOP_NOTIFICATION_SUBJECTS`.
 *
 * The body has its quoted history removed first — see quoted-reply.mjs for why
 * that matters more for retrieval quality than for size.
 *
 * Sender identity is deliberately absent: it is personal data, and it says
 * nothing about what the email is *about*.
 *
 * @param {object} input
 * @param {string} [input.subject]
 * @param {string} [input.body_text]
 * @returns {string} deterministic composed input string
 */
export function buildMessageEmbeddingInput({ subject, body_text } = {}) {
  const parts = [
    isShopNotificationSubject(subject) ? '' : normalizeField(subject),
    String(stripQuotedReply(body_text) ?? '').trim()
  ];

  return parts.filter(Boolean).join(FIELD_SEPARATOR);
}

/**
 * Exemplar phrasing: the phrasing, and nothing else.
 *
 * THE ODD ONE OUT, DELIBERATELY. A knowledge chunk is prefixed with its title
 * and heading because a bare fragment ("Comptez 3 à 5 jours ouvrés") floats free
 * without them. A phrasing has the opposite problem: it is ALREADY a complete
 * question, and the thing it will be compared against is a bare customer email.
 * Prefixing it with the canonical question would pull every variant of one
 * exemplar toward a common centre — which sounds like a feature and is not: it
 * shrinks the distance between variants of DIFFERENT exemplars too, because the
 * added text is the tidiest and least discriminating part of the row.
 *
 * Symmetry with the query is the rule being followed here, the same one that
 * makes message embeddings compose subject + body on both sides.
 *
 * @param {object} input
 * @param {string} [input.phrasing_text]
 * @returns {string} deterministic composed input string
 */
export function buildExemplarEmbeddingInput({ phrasing_text } = {}) {
  // Collapsed, not merely trimmed: these are typed by hand into a dashboard
  // field, so a stray double space must not produce a different hash from the
  // same question entered twice.
  return normalizeField(phrasing_text);
}

/**
 * Stable sha256 of the composed input string.
 *
 * `salt` is mixed into the hash but never into the embedded text. Message inputs
 * pass the stripper version, so changing how quoted history is removed correctly
 * invalidates every stored message vector and the reconciler re-embeds — without
 * polluting what the model actually reads.
 */
export function hashEmbeddingInput(input, { salt = '' } = {}) {
  return createHash('sha256').update(salt ? `${salt}\n${input}` : input).digest('hex');
}

/**
 * Bumped whenever what goes INTO a message input changes, independently of the
 * stripper. Dropping our own notification subjects is the first bump.
 *
 * IT LIVES IN THE SALT SO IT NEVER REACHES THE MODEL. Putting a version marker
 * in the composed string would invalidate vectors just as well and would also
 * embed « message-input/2 » into the text being matched, which is the one thing
 * this file exists to keep clean.
 *
 * THE COST IS BLUNT AND WORTH IT: the salt is mixed into every message hash, so
 * a bump re-embeds all 851 messages rather than only the 225 whose text actually
 * changed. Correct beats precise here — a stale vector is a wrong match for
 * ever, and re-embedding the corpus costs a fraction of a cent.
 */
export const MESSAGE_INPUT_VERSION = 'message-input/2';

/**
 * The salt message embeddings hash with, so a change to either half — how quoted
 * history is stripped, or what is composed around it — invalidates the stored
 * vectors and the reconciler re-embeds.
 */
export const MESSAGE_HASH_SALT = `${STRIPPER_VERSION}+${MESSAGE_INPUT_VERSION}`;
