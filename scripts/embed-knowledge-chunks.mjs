import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { COLUMNS, T } from './lib/tables.mjs';
import { KNOWLEDGE_CHUNK_INPUT } from './lib/embeddings/embed-chunks.mjs';
import { reconcileEmbeddings } from './lib/embeddings/reconcile.mjs';

// Reconciler for knowledge-chunk embeddings. The web service embeds inline on
// approval, but that is best-effort; this script is the safety net that:
//   1. embeds approved, non-brand chunks whose vector is missing or stale
//      (after an inline failure, or a model/dimension change), and
//   2. clears vectors from chunks whose parent document is no longer approved.
//
// It is deterministic and idempotent: unchanged chunks are skipped by the hash
// gate, so a second run with no intervening edits does nothing.
//
// The loop itself lives in lib/embeddings/reconcile.mjs and is shared with the
// exemplar and ticket-message reconcilers. What is here is the part that is
// actually about knowledge: which documents may hold vectors, and what a run
// reports.
//
// Flags: --dry-run (report only), --limit=N (cap documents embedded this run).

/**
 * Which knowledge rows may hold a vector.
 *
 * APPROVED AND NOT BRAND. `core_topic = 'brand'` is excluded in JS rather than
 * with a `neq` filter because most documents have a null core_topic, and
 * PostgREST's `neq.brand` would drop those null rows too — which is every
 * ordinary document.
 */
export const KNOWLEDGE_CHUNKS = {
  parent: {
    table: T.KNOWLEDGE_DOCUMENTS,
    filters: { approval_status: 'approved' },
    columns: 'id,title,core_topic',
    isEligible: (doc) => doc.core_topic !== 'brand'
  },
  child: {
    table: T.KNOWLEDGE_CHUNKS,
    parentKey: 'knowledge_document_id',
    columns: COLUMNS.chunkForEmbedding
  },
  inputSpec: KNOWLEDGE_CHUNK_INPUT,
  // The composed input includes the document title, which the chunk row does not
  // carry — so a title change invalidates every chunk vector under it.
  decorate: (chunk, doc) => ({ ...chunk, title: doc.title }),
  orphan: {
    columns: 'id,knowledge_document_id',
    isOrphan: (row, eligibleIds) => !eligibleIds.has(row.knowledge_document_id),
    clearBy: 'parent'
  },
  limitApplies: 'parents'
};

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
  const result = await reconcileEmbeddings({
    descriptor: KNOWLEDGE_CHUNKS,
    args,
    config,
    supabase
  });

  if (args.dryRun) {
    console.log(
      `Dry run: ${result.eligibleParents} approved document(s); ${result.staleFound} chunk(s) would be embedded; ${result.cleared} orphaned chunk(s) would be cleared.`
    );
  } else if (result.missingKey) {
    console.warn('OPENAI_API_KEY is not set; skipped embedding. Only orphan cleanup ran.');
    console.log(`Cleared ${result.cleared} orphaned chunk embedding(s).`);
  } else {
    console.log(
      `Embedding reconcile complete: embedded ${result.embedded} chunk(s) across ${result.parentsProcessed} document(s); cleared ${result.cleared} orphaned chunk(s).`
    );
  }

  return {
    approvedDocuments: result.eligibleParents,
    embeddedChunks: result.embedded,
    staleFound: result.staleFound,
    cleared: result.cleared
  };
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
