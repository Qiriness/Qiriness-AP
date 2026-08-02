import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById
} from './lib/supabase-rest-client.mjs';
import { createEmbeddingsClient } from './lib/embeddings/openai-embeddings-client.mjs';
import {
  embedChunks,
  evaluateChunkEmbedding,
  toVectorLiteral,
  buildClearEmbeddingPatch,
  TICKET_MESSAGE_INPUT
} from './lib/embeddings/embed-chunks.mjs';

// Reconciler for ticket-message embeddings — the mirror of
// embed-knowledge-chunks.mjs, and the safety net behind ingestion's inline
// best-effort embed.
//
// It:
//   1. embeds messages whose vector is missing or stale (after an inline
//      failure, a change to the quoted-reply stripper, or a model/dimension
//      change), and
//   2. clears vectors from messages that no longer have a body — a redacted or
//      soft-deleted message must not leave a vector behind, because an embedding
//      is a derived representation of the text and is partially invertible.
//
// Deterministic and idempotent: unchanged messages are skipped by the hash gate,
// so a second run with no intervening edits does nothing and costs nothing.
//
// Unlike the knowledge side there is no approval gate — every stored message is
// part of the corpus. Ingestion decides what is stored; this only decides what
// is embedded.
//
//   npm run embed:tickets
//   npm run embed:tickets:dry-run
//   npm run embed:tickets -- --limit=50

// Both reads below page through the whole table rather than passing a large
// `limit`. PostgREST silently caps a single response at `db-max-rows` (1000), so
// the previous `limit: 2000` returned 1000 rows of the 1383 stored and gave the
// caller no way to tell — the reconciler simply could not see the newest
// messages, and the redaction sweep could not clear vectors past row 1000.

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);

  await runMessageEmbeddingReconcile({ args, config, supabase });
}

export async function runMessageEmbeddingReconcile({ args, config, supabase }) {
  const target = {
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    inputSpec: TICKET_MESSAGE_INPUT
  };

  const rows = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    {
      body_text: { operator: 'not.is', value: 'null' },
      deleted_at: { operator: 'is', value: 'null' }
    },
    'id,subject,body_text,embedding,embedding_model,embedding_dimensions,embedded_input_hash',
    // Oldest first so a --limit run is a stable prefix rather than a random slice.
    { order: 'received_at.asc' }
  );

  const candidates = args.limit ? rows.slice(0, args.limit) : rows;
  const cleared = await clearRedactedEmbeddings({ args, supabase });

  if (args.dryRun || !config.openaiApiKey) {
    const stale = candidates.filter(
      (row) => evaluateChunkEmbedding(row, target).needsEmbedding
    ).length;
    const reason = args.dryRun ? 'Dry run' : 'OPENAI_API_KEY is not set; skipped embedding';
    console.log(
      `${reason}: ${candidates.length} message(s) considered; ${stale} would be embedded; ` +
        `${cleared} redacted vector(s) ${args.dryRun ? 'would be' : ''} cleared.`
    );
    return { considered: candidates.length, embedded: 0, staleFound: stale, cleared };
  }

  const client = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });

  const { patches, skippedCount } = await embedChunks({
    chunks: candidates,
    client,
    inputSpec: TICKET_MESSAGE_INPUT
  });

  for (const patch of patches) {
    const { id, ...columns } = patch;
    await supabaseUpdateById(supabase, 'ticket_messages', id, {
      ...columns,
      embedding: toVectorLiteral(columns.embedding)
    });
  }

  console.log(
    `Message embedding reconcile complete: embedded ${patches.length} of ${candidates.length} ` +
      `message(s) (${skippedCount} already current); cleared ${cleared} redacted vector(s).`
  );

  return {
    considered: candidates.length,
    embedded: patches.length,
    staleFound: patches.length,
    cleared
  };
}

/**
 * A message whose body has been redacted or soft-deleted must not keep its
 * vector. Enforced here as well as at the redaction site, for the same reason
 * the knowledge reconciler re-checks orphaned chunks: a missed inline clear
 * would otherwise leave derived personal data in the database indefinitely.
 */
async function clearRedactedEmbeddings({ args, supabase }) {
  const embedded = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    { embedding: { operator: 'not.is', value: 'null' } },
    'id,body_text,deleted_at'
  );

  const orphans = embedded.filter((row) => !row.body_text || row.deleted_at);
  if (args.dryRun) {
    return orphans.length;
  }

  for (const row of orphans) {
    const { id, ...columns } = buildClearEmbeddingPatch(row.id);
    await supabaseUpdateById(supabase, 'ticket_messages', id, columns);
  }
  return orphans.length;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
