import { createHash } from 'node:crypto';

// Builds the exact text sent to the embedding model for one chunk, and a stable
// hash of it. Short retrieval chunks embed better with a little context, so we
// prepend the document title, the loose category, and the section heading before
// the chunk text.
//
// This is deliberately separate from knowledge_chunks.content_hash: that hash
// covers only { source, section_index, text }, so a title or category rename
// would NOT change it. The embedded input DOES include those, so we track a
// dedicated embedded_input_hash — a category rename must invalidate the vector.
//
// Determinism matters here: the same logical chunk must always produce the same
// composed string (and therefore the same hash), so trailing whitespace and
// blank fields can never cause a spurious re-embed.

const FIELD_SEPARATOR = '\n\n';

function normalizeField(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} input
 * @param {string} [input.title]           parent document title
 * @param {string} [input.category]        loose knowledge category
 * @param {string} [input.section_heading] chunk's section heading
 * @param {string} [input.chunk_text]      the chunk body (required to be useful)
 * @returns {string} deterministic composed input string
 */
export function buildEmbeddingInput({ title, category, section_heading, chunk_text } = {}) {
  const parts = [
    normalizeField(title),
    normalizeField(category),
    normalizeField(section_heading),
    // The chunk body keeps its internal paragraph structure; only the edges are
    // trimmed. Collapsing all whitespace here would harm the embedding.
    String(chunk_text ?? '').trim()
  ];

  return parts.filter(Boolean).join(FIELD_SEPARATOR);
}

/** Stable sha256 of the composed input string. */
export function hashEmbeddingInput(input) {
  return createHash('sha256').update(input).digest('hex');
}
