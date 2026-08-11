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
  EXEMPLAR_PHRASING_INPUT,
  embedChunks,
  evaluateChunkEmbedding,
  toVectorLiteral,
  buildClearEmbeddingPatch
} from './lib/embeddings/embed-chunks.mjs';

// Reconciler for exemplar-phrasing embeddings — the same two jobs the knowledge
// reconciler does, against the other corpus:
//   1. embed phrasings of APPROVED exemplars whose vector is missing or stale
//      (after an inline failure, or a model/dimension change), and
//   2. clear vectors from phrasings whose parent left `approved` — or was soft
//      deleted, which the knowledge side has no equivalent of.
//
// APPROVAL IS THE RETRIEVAL GATE, so this is not housekeeping. `match_support_
// exemplars` selects on `embedding is not null` and trusts that only approved
// rows carry one; a missed clear here does not degrade retrieval quality, it
// makes an unapproved situation reachable.
//
// Deterministic and idempotent: unchanged phrasings are skipped by the hash
// gate, so a second run with no intervening edits does nothing.
//
// Flags: --dry-run (report only), --limit=N (cap exemplars embedded this run).

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
  // Approved AND not soft-deleted. Both halves matter: `deleted_at` is set by
  // the dashboard without touching approval, so filtering on status alone would
  // leave a deleted situation embedded and retrievable.
  const approved = (
    await supabaseSelect(
      supabase,
      'support_exemplars',
      { approval_status: 'approved' },
      'id,exemplar_key,deleted_at'
    )
  ).filter((row) => row.deleted_at === null);

  const approvedIds = new Set(approved.map((row) => row.id));
  const toEmbed = args.limit ? approved.slice(0, args.limit) : approved;

  const client =
    !args.dryRun && config.openaiApiKey
      ? createEmbeddingsClient({
          apiKey: config.openaiApiKey,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions
        })
      : null;

  let embeddedPhrasings = 0;
  let staleFound = 0;
  for (const exemplar of toEmbed) {
    const phrasings = await supabaseSelect(
      supabase,
      'support_exemplar_phrasings',
      { support_exemplar_id: exemplar.id },
      'id,phrasing_text,embedding,embedding_model,embedding_dimensions,embedded_input_hash'
    );

    if (args.dryRun || !client) {
      staleFound += countStale(phrasings, config);
      continue;
    }

    const { patches } = await embedChunks({
      chunks: phrasings,
      client,
      inputSpec: EXEMPLAR_PHRASING_INPUT
    });
    for (const patch of patches) {
      const { id, ...columns } = patch;
      await supabaseUpdateById(supabase, 'support_exemplar_phrasings', id, {
        ...columns,
        embedding: toVectorLiteral(columns.embedding)
      });
    }
    embeddedPhrasings += patches.length;
  }

  const cleared = await clearOrphanedEmbeddings({ args, supabase, approvedIds });

  if (args.dryRun) {
    console.log(
      `Dry run: ${approved.length} approved exemplar(s); ${staleFound} phrasing(s) would be embedded; ${cleared} orphaned phrasing(s) would be cleared.`
    );
  } else if (!config.openaiApiKey) {
    console.warn('OPENAI_API_KEY is not set; skipped embedding. Only orphan cleanup ran.');
    console.log(`Cleared ${cleared} orphaned phrasing embedding(s).`);
  } else {
    console.log(
      `Exemplar embedding reconcile complete: embedded ${embeddedPhrasings} phrasing(s) across ${toEmbed.length} exemplar(s); cleared ${cleared} orphaned phrasing(s).`
    );
  }

  return { approvedExemplars: approved.length, embeddedPhrasings, staleFound, cleared };
}

function countStale(phrasings, config) {
  const target = {
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    inputSpec: EXEMPLAR_PHRASING_INPUT
  };
  return phrasings.filter((row) => evaluateChunkEmbedding(row, target).needsEmbedding).length;
}

/**
 * Clears vectors from phrasings whose parent is no longer approved, or was soft
 * deleted. Enforces the invariant from the other direction, in case an inline
 * clear was missed — here that is a reachability bug, not a quality one.
 */
async function clearOrphanedEmbeddings({ args, supabase, approvedIds }) {
  const embedded = await supabaseSelect(
    supabase,
    'support_exemplar_phrasings',
    { embedding: { operator: 'not.is', value: 'null' } },
    'id,support_exemplar_id'
  );

  const orphanIds = new Set(
    embedded
      .filter((row) => !approvedIds.has(row.support_exemplar_id))
      .map((row) => row.support_exemplar_id)
  );

  if (orphanIds.size === 0) {
    return 0;
  }

  const orphanCount = embedded.filter((row) => orphanIds.has(row.support_exemplar_id)).length;
  if (args.dryRun) {
    return orphanCount;
  }

  const cleared = buildClearEmbeddingPatch('ignored');
  delete cleared.id;
  for (const exemplarId of orphanIds) {
    await supabaseUpdate(
      supabase,
      'support_exemplar_phrasings',
      { support_exemplar_id: exemplarId },
      cleared
    );
  }
  return orphanCount;
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
