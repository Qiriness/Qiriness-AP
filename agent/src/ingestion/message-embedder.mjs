import {
  embedChunks,
  toVectorLiteral,
  TICKET_MESSAGE_INPUT
} from '../../../scripts/lib/embeddings/embed-chunks.mjs';

// Embeds one message as it is ingested, returning the vector columns to write
// alongside the row — so a message is complete in a single upsert rather than
// stored and then patched.
//
// BEST-EFFORT BY CONTRACT. Any failure returns null and ingestion continues: a
// missing vector degrades retrieval to the category filter, whereas a failed
// ingestion loses an email. `embed-ticket-messages.mjs` is the reconciler that
// fills every gap this leaves, gated on the same hash, so nothing is lost —
// only deferred.
//
// This path is for the steady-state trickle (0-2 messages per poll). A bulk
// backfill should use the reconciler instead: it batches 256 inputs per request,
// where this issues one call per message.

export function createMessageEmbedder(client, { logger } = {}) {
  /**
   * @param {{subject?: string, body_text?: string}} message
   * @returns {Promise<object|null>} embedding column patch, or null if it could
   *   not be produced for any reason
   */
  return async function embedMessage(message) {
    try {
      const { patches } = await embedChunks({
        // A synthetic id: the row is being written now and has none yet. Only
        // the composed input and hash are used from here.
        chunks: [{ id: 'inline', ...message }],
        client,
        inputSpec: TICKET_MESSAGE_INPUT
      });

      // No patch means the input composed to nothing — an empty body with no
      // subject. There is nothing to embed, and that is not an error.
      if (patches.length === 0) {
        return null;
      }

      const { id, ...columns } = patches[0];
      return { ...columns, embedding: toVectorLiteral(columns.embedding) };
    } catch (error) {
      // No PII: the message body never reaches the log.
      logger?.warn?.('ingest.embed_failed', { message: error.message });
      return null;
    }
  };
}
