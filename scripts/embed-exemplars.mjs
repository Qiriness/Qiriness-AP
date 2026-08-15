import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { COLUMNS, T } from './lib/tables.mjs';
import { EXEMPLAR_PHRASING_INPUT } from './lib/embeddings/embed-chunks.mjs';
import { reconcileEmbeddings } from './lib/embeddings/reconcile.mjs';

// Reconciler for exemplar-phrasing embeddings — the same mechanics as
// embed-knowledge-chunks.mjs, over the recurring SITUATIONS rather than the
// policy that answers them.
//
// It:
//   1. embeds phrasings of APPROVED exemplars whose vector is missing or stale
//      (after an inline failure, or a model/dimension change), and
//   2. clears vectors from phrasings whose exemplar is no longer approved or was
//      soft-deleted — here that is a reachability bug rather than a quality one:
//      a retrievable question that nobody approved would be matched against.
//
// Deterministic and idempotent: unchanged phrasings are skipped by the hash gate.
//
// The loop lives in lib/embeddings/reconcile.mjs, shared with the knowledge and
// ticket-message reconcilers. What is here is which exemplars may hold vectors.
//
// Flags: --dry-run (report only), --limit=N (cap exemplars embedded this run).

/**
 * Which exemplar rows may hold a vector.
 *
 * APPROVED AND NOT SOFT-DELETED, and both halves matter: `deleted_at` is set by
 * the dashboard without touching approval, so filtering on status alone would
 * leave a deleted situation embedded and retrievable.
 */
export const EXEMPLAR_PHRASINGS = {
  parent: {
    table: T.SUPPORT_EXEMPLARS,
    filters: { approval_status: 'approved' },
    columns: 'id,exemplar_key,deleted_at',
    isEligible: (row) => row.deleted_at === null
  },
  child: {
    table: T.SUPPORT_EXEMPLAR_PHRASINGS,
    parentKey: 'support_exemplar_id',
    columns: COLUMNS.phrasingForEmbedding
  },
  inputSpec: EXEMPLAR_PHRASING_INPUT,
  orphan: {
    columns: 'id,support_exemplar_id',
    isOrphan: (row, eligibleIds) => !eligibleIds.has(row.support_exemplar_id),
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

  await runExemplarEmbeddingReconcile({ args, config, supabase });
}

export async function runExemplarEmbeddingReconcile({ args, config, supabase }) {
  const result = await reconcileEmbeddings({
    descriptor: EXEMPLAR_PHRASINGS,
    args,
    config,
    supabase
  });

  if (args.dryRun) {
    console.log(
      `Dry run: ${result.eligibleParents} approved exemplar(s); ${result.staleFound} phrasing(s) would be embedded; ${result.cleared} orphaned phrasing(s) would be cleared.`
    );
  } else if (result.missingKey) {
    console.warn('OPENAI_API_KEY is not set; skipped embedding. Only orphan cleanup ran.');
    console.log(`Cleared ${result.cleared} orphaned phrasing embedding(s).`);
  } else {
    console.log(
      `Exemplar embedding reconcile complete: embedded ${result.embedded} phrasing(s) across ${result.parentsProcessed} exemplar(s); cleared ${result.cleared} orphaned phrasing(s).`
    );
  }

  return {
    approvedExemplars: result.eligibleParents,
    embeddedPhrasings: result.embedded,
    staleFound: result.staleFound,
    cleared: result.cleared
  };
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
