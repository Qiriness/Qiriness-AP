import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdate,
  supabaseUpdateById
} from './lib/supabase-rest-client.mjs';
import { createEmbeddingsClient } from './lib/embeddings/openai-embeddings-client.mjs';
import {
  embedChunks,
  evaluateChunkEmbedding,
  toVectorLiteral,
  buildClearEmbeddingPatch
} from './lib/embeddings/embed-chunks.mjs';

// Reconciler for knowledge-chunk embeddings. The web service embeds inline on
// approval, but that is best-effort; this script is the safety net that:
//   1. embeds approved, non-brand chunks whose vector is missing or stale
//      (after an inline failure, or a model/dimension change), and
//   2. clears vectors from chunks whose parent document is no longer approved.
//
// It is deterministic and idempotent: unchanged chunks are skipped by the hash
// gate, so a second run with no intervening edits does nothing.
//
// Flags: --dry-run (report only), --limit=N (cap documents embedded this run).

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

  await runEmbeddingReconcile({ args, config, supabase });
}

export async function runEmbeddingReconcile({ args, config, supabase }) {
  // Approved, non-brand documents are the only ones that may hold vectors.
  // core_topic = 'brand' is excluded, and we filter it in JS rather than with a
  // `neq` filter because most documents have a null core_topic (a `neq.brand`
  // filter would wrongly drop those null rows too).
  const approvedDocs = (
    await supabaseSelect(supabase, 'knowledge_documents', { approval_status: 'approved' }, 'id,title,core_topic')
  ).filter((doc) => doc.core_topic !== 'brand');

  const approvedIds = new Set(approvedDocs.map((doc) => doc.id));
  const docsToEmbed = args.limit ? approvedDocs.slice(0, args.limit) : approvedDocs;

  const client =
    !args.dryRun && config.openaiApiKey
      ? createEmbeddingsClient({
          apiKey: config.openaiApiKey,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions
        })
      : null;

  let embeddedChunks = 0;
  let staleFound = 0;
  for (const doc of docsToEmbed) {
    const chunkRows = await supabaseSelect(
      supabase,
      'knowledge_chunks',
      { knowledge_document_id: doc.id },
      'id,section_heading,category,chunk_text,embedding,embedding_model,embedding_dimensions,embedded_input_hash'
    );
    const chunks = chunkRows.map((row) => ({ ...row, title: doc.title }));

    if (args.dryRun || !client) {
      staleFound += countStale(chunks, config);
      continue;
    }

    const { patches } = await embedChunks({ chunks, client });
    for (const patch of patches) {
      const { id, ...columns } = patch;
      await supabaseUpdateById(supabase, 'knowledge_chunks', id, {
        ...columns,
        embedding: toVectorLiteral(columns.embedding)
      });
    }
    embeddedChunks += patches.length;
  }

  const cleared = await clearOrphanedEmbeddings({ args, supabase, approvedIds });

  if (args.dryRun) {
    console.log(
      `Dry run: ${approvedDocs.length} approved document(s); ${staleFound} chunk(s) would be embedded; ${cleared} orphaned chunk(s) would be cleared.`
    );
  } else if (!config.openaiApiKey) {
    console.warn('OPENAI_API_KEY is not set; skipped embedding. Only orphan cleanup ran.');
    console.log(`Cleared ${cleared} orphaned chunk embedding(s).`);
  } else {
    console.log(
      `Embedding reconcile complete: embedded ${embeddedChunks} chunk(s) across ${docsToEmbed.length} document(s); cleared ${cleared} orphaned chunk(s).`
    );
  }

  return { approvedDocuments: approvedDocs.length, embeddedChunks, staleFound, cleared };
}

function countStale(chunks, config) {
  const target = { model: config.embeddingModel, dimensions: config.embeddingDimensions };
  return chunks.filter((chunk) => evaluateChunkEmbedding(chunk, target).needsEmbedding).length;
}

/**
 * Clears vectors from chunks whose parent document is no longer approved (or
 * became the brand document). Enforces the invariant from the other direction
 * in case an inline clear was missed.
 */
async function clearOrphanedEmbeddings({ args, supabase, approvedIds }) {
  const embeddedChunks = await supabaseSelect(
    supabase,
    'knowledge_chunks',
    { embedding: { operator: 'not.is', value: 'null' } },
    'id,knowledge_document_id'
  );

  const orphanDocIds = new Set(
    embeddedChunks
      .filter((row) => !approvedIds.has(row.knowledge_document_id))
      .map((row) => row.knowledge_document_id)
  );

  if (orphanDocIds.size === 0) {
    return 0;
  }

  const orphanChunkCount = embeddedChunks.filter((row) => orphanDocIds.has(row.knowledge_document_id)).length;
  if (args.dryRun) {
    return orphanChunkCount;
  }

  const cleared = buildClearEmbeddingPatch('ignored');
  delete cleared.id;
  for (const documentId of orphanDocIds) {
    await supabaseUpdate(supabase, 'knowledge_chunks', { knowledge_document_id: documentId }, cleared);
  }
  return orphanChunkCount;
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
