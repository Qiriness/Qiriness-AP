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
 * Email message: `subject → cleaned, quote-stripped body`.
 *
 * The subject is kept because support subject lines carry real signal ("Colis
 * bloqué", "remboursement commande #5229"). The body has its quoted history
 * removed first — see quoted-reply.mjs for why that matters more for retrieval
 * quality than for size.
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
    normalizeField(subject),
    String(stripQuotedReply(body_text) ?? '').trim()
  ];

  return parts.filter(Boolean).join(FIELD_SEPARATOR);
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

/** The salt message embeddings hash with, so a stripper change invalidates them. */
export const MESSAGE_HASH_SALT = STRIPPER_VERSION;
