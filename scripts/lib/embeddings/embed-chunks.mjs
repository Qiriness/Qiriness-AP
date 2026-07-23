import { buildEmbeddingInput, hashEmbeddingInput } from './embedding-input.mjs';

// Orchestrates embedding for a set of chunk rows without touching Supabase, so
// both the web service (inline, on approve) and the reconciler script can reuse
// it. Callers pass chunk rows that carry the fields needed to compose the input
// (title, category, section_heading, chunk_text) plus the currently stored
// embedding metadata; this module decides which are stale, embeds only those,
// and returns column patches to persist.

/**
 * Decides whether one chunk needs (re)embedding against a target model +
 * dimensions, and returns the composed input and its hash either way.
 */
export function evaluateChunkEmbedding(chunk, { model, dimensions }) {
  const input = buildEmbeddingInput(chunk);
  const hash = hashEmbeddingInput(input);
  const needsEmbedding =
    chunk.embedding == null ||
    chunk.embedded_input_hash !== hash ||
    chunk.embedding_model !== model ||
    chunk.embedding_dimensions !== dimensions;

  return { needsEmbedding, input, hash };
}

/**
 * Embeds the stale chunks in `chunks` using `client` (from
 * createEmbeddingsClient, or any object exposing { embed, model, dimensions }).
 *
 * @returns {Promise<{ patches: object[], embeddedCount: number, skippedCount: number }>}
 *   `patches` holds one row per embedded chunk: { id, embedding,
 *   embedding_model, embedding_dimensions, embedded_input_hash, embedded_at }.
 *   Unchanged chunks are skipped (no API call, no patch) — this is what makes a
 *   re-run idempotent.
 */
export async function embedChunks({ chunks, client }) {
  const { model, dimensions } = client;
  const stale = [];

  for (const chunk of chunks) {
    const { needsEmbedding, input, hash } = evaluateChunkEmbedding(chunk, { model, dimensions });
    if (needsEmbedding) {
      stale.push({ id: chunk.id, input, hash });
    }
  }

  if (stale.length === 0) {
    return { patches: [], embeddedCount: 0, skippedCount: chunks.length };
  }

  const vectors = await client.embed(stale.map((item) => item.input));
  if (vectors.length !== stale.length) {
    throw new Error(
      `Embedding count mismatch: requested ${stale.length}, received ${vectors.length}.`
    );
  }

  const embeddedAt = new Date().toISOString();
  const patches = stale.map((item, index) => ({
    id: item.id,
    embedding: vectors[index],
    embedding_model: model,
    embedding_dimensions: dimensions,
    embedded_input_hash: item.hash,
    embedded_at: embeddedAt
  }));

  return { patches, embeddedCount: patches.length, skippedCount: chunks.length - patches.length };
}

/**
 * Formats an embedding for storage in a pgvector column via PostgREST. pgvector
 * accepts the `[a,b,c]` text literal; a JS number[] is converted to it, and an
 * already-stringified vector (as read back from a select) is passed through.
 */
export function toVectorLiteral(embedding) {
  if (embedding == null) {
    return null;
  }
  if (typeof embedding === 'string') {
    return embedding;
  }
  return `[${embedding.join(',')}]`;
}

/** Column patch that clears a chunk's vector (used on unapprove/demote). */
export function buildClearEmbeddingPatch(id) {
  return {
    id,
    embedding: null,
    embedding_model: null,
    embedding_dimensions: null,
    embedded_input_hash: null,
    embedded_at: null
  };
}
