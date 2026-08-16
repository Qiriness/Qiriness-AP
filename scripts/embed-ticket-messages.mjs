import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { COLUMNS, T } from './lib/tables.mjs';
import { TICKET_MESSAGE_INPUT } from './lib/embeddings/embed-chunks.mjs';
import { reconcileEmbeddings } from './lib/embeddings/reconcile.mjs';
import { createUsageRecording } from '../agent/src/llm/usage-store.mjs';

// Reconciler for ticket-message embeddings — the safety net behind ingestion's
// inline best-effort embed.
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
// NO APPROVAL GATE, unlike the other two reconcilers: every stored message is
// part of the corpus (DECISIONS.md § Embeddings). Ingestion decides what is
// stored; this only decides what is embedded. That is the whole of what makes
// this descriptor different — there is no parent, so `--limit` caps rows.
//
//   npm run embed:tickets
//   npm run embed:tickets:dry-run
//   npm run embed:tickets -- --limit=50

/**
 * Which message rows may hold a vector.
 *
 * BOTH READS PAGE through the whole table rather than passing a large `limit`.
 * PostgREST silently caps a single response at `db-max-rows` (1000), so a
 * `limit: 2000` returned 1000 rows of the 1383 stored and gave the caller no way
 * to tell — the reconciler could not see the newest messages, and the redaction
 * sweep could not clear vectors past row 1000.
 */
export const TICKET_MESSAGES = {
  parent: null,
  child: {
    table: T.TICKET_MESSAGES,
    columns: COLUMNS.messageForEmbedding,
    filters: {
      body_text: { operator: 'not.is', value: 'null' },
      deleted_at: { operator: 'is', value: 'null' }
    },
    // Oldest first so a --limit run is a stable prefix rather than a random slice.
    order: 'received_at.asc'
  },
  inputSpec: TICKET_MESSAGE_INPUT,
  orphan: {
    columns: 'id,body_text,deleted_at',
    // No parent to consult: a message loses its right to a vector by losing its
    // body, which is what a redaction and a soft delete both do.
    isOrphan: (row) => !row.body_text || Boolean(row.deleted_at),
    clearBy: 'row'
  },
  limitApplies: 'children'
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

  await runMessageEmbeddingReconcile({ args, config, supabase });
}

export async function runMessageEmbeddingReconcile({ args, config, supabase }) {
  // One flush for the whole run, not one per batch: this is a ledger of what the
  // backfill cost, and a write per 256-input request would put a database round
  // trip between every batch and the next.
  const usage = createUsageRecording({ supabase, shopDomain: config.shopDomain });

  const result = await reconcileEmbeddings({
    descriptor: TICKET_MESSAGES,
    args,
    config,
    supabase,
    usageSink: usage.sink
  });
  await usage.flush();

  if (result.reportOnly) {
    const reason = args.dryRun ? 'Dry run' : 'OPENAI_API_KEY is not set; skipped embedding';
    console.log(
      `${reason}: ${result.considered} message(s) considered; ${result.staleFound} would be embedded; ` +
        `${result.cleared} redacted vector(s) ${args.dryRun ? 'would be' : ''} cleared.`
    );
  } else {
    console.log(
      `Message embedding reconcile complete: embedded ${result.embedded} of ${result.considered} ` +
        `message(s); cleared ${result.cleared} redacted vector(s).`
    );
  }

  return {
    considered: result.considered,
    embedded: result.embedded,
    staleFound: result.staleFound,
    cleared: result.cleared
  };
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
