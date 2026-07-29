import {
  buildEmbeddingInput,
  buildMessageEmbeddingInput,
  hashEmbeddingInput,
  MESSAGE_HASH_SALT
} from './embedding-input.mjs';

// Orchestrates embedding for a set of rows without touching Supabase, so every
// caller can reuse it: the web service (inline, on approve), the knowledge
// reconciler, ingestion (inline, per message) and the message reconciler.
//
// Callers pass rows carrying the fields needed to compose the input plus the
// currently stored embedding metadata; this module decides which are stale,
// embeds only those, and returns column patches to persist. The composer is
// injectable because knowledge chunks and email messages compose differently —
// everything downstream of that is identical, including the staleness gate that
// makes a re-run a no-op.

/** How each corpus composes and hashes its embedding input. */
export const KNOWLEDGE_CHUNK_INPUT = {
  build: buildEmbeddingInput,
  salt: ''
};

export const TICKET_MESSAGE_INPUT = {
  build: buildMessageEmbeddingInput,
  // Mixing the stripper version into the hash means changing how quoted history
  // is removed invalidates every stored message vector.
  salt: MESSAGE_HASH_SALT
};

/**
 * Decides whether one row needs (re)embedding against a target model +
 * dimensions, and returns the composed input and its hash either way.
 */
export function evaluateChunkEmbedding(
  chunk,
  { model, dimensions, inputSpec = KNOWLEDGE_CHUNK_INPUT }
) {
  const input = inputSpec.build(chunk);
  const hash = hashEmbeddingInput(input, { salt: inputSpec.salt });
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
export async function embedChunks({ chunks, client, inputSpec = KNOWLEDGE_CHUNK_INPUT }) {
  const { model, dimensions } = client;
  const stale = [];

  for (const chunk of chunks) {
    const { needsEmbedding, input, hash } = evaluateChunkEmbedding(chunk, {
      model,
      dimensions,
      inputSpec
    });
    // An input that composes to nothing (a message with no subject and an empty
    // body) has no meaning to embed and would waste a call on whitespace.
    if (needsEmbedding && input.length > 0) {
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
