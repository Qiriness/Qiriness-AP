import {
  supabaseSelectAll,
  supabaseUpdate,
  supabaseUpdateById
} from '../supabase-rest-client.mjs';
import { createEmbeddingsClient } from './openai-embeddings-client.mjs';
import {
  buildClearEmbeddingPatch,
  embedChunks,
  evaluateChunkEmbedding,
  toVectorLiteral
} from './embed-chunks.mjs';

/**
 * The reconcile loop, once.
 *
 * WHY THIS EXISTS. Three tables hold an embedding — `knowledge_chunks`,
 * `support_exemplar_phrasings` and `ticket_messages` — and each had its own
 * ~160-line script around the same five steps: find the rows that may hold a
 * vector, read them, hash-gate, write the ones that changed, and clear vectors
 * off rows that must not keep one. The pure part of that (the staleness gate,
 * `embed-chunks.mjs`) was extracted and tested; the loop around it was copied
 * three times and tested nowhere — which is exactly where the interesting
 * failures live, because the gate cannot be wrong about a row nobody read.
 *
 * The three scripts are still three commands with three reports. What they no
 * longer each own is this.
 *
 * THE DESCRIPTOR answers one question per table: which rows should hold a
 * vector? Everything else follows from it.
 *
 *   parent   optional. The row that GRANTS eligibility — an approved document,
 *            an approved exemplar. Null for ticket_messages, where every stored
 *            message is part of the corpus (see DECISIONS.md § Embeddings).
 *   child    the table that actually holds the vector.
 *   orphan   the same question asked backwards: given a row that HAS a vector,
 *            should it? Enforced from both directions because a missed inline
 *            clear would otherwise leave a derived representation of deleted
 *            text in the database indefinitely.
 *   limitApplies  whether `--limit` caps parents or children. The knowledge and
 *            exemplar runs cap parents (documents, exemplars); the message run
 *            has no parents to cap, so it caps rows.
 */

const HAS_VECTOR = { embedding: { operator: 'not.is', value: 'null' } };

/**
 * The calls this module makes, as one object.
 *
 * Injectable for the same reason the ticket record's is: the loop is the part
 * that was copied three times and tested nowhere, and testing it means being
 * able to answer its reads without a database and inspect its writes.
 */
export const REST_TRANSPORT = {
  selectAll: supabaseSelectAll,
  update: supabaseUpdate,
  updateById: supabaseUpdateById,
  createEmbeddingsClient
};

export async function reconcileEmbeddings({
  descriptor,
  args,
  config,
  supabase,
  transport = REST_TRANSPORT,
  // Where the token counts go, if the caller wants them. A bulk backfill is the
  // one embedding path where the bill is large enough to be worth a row, and it
  // is also the only one whose cost is not attributable to a ticket.
  usageSink = null
}) {
  const target = {
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    inputSpec: descriptor.inputSpec
  };

  // No client on a dry run, and none without a key: both cases still do the
  // counting and the orphan sweep, which need no API call. `!client` is
  // therefore "report only", and the report says which of the two it was.
  const client =
    !args.dryRun && config.openaiApiKey
      ? transport.createEmbeddingsClient({
          apiKey: config.openaiApiKey,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
          usageSink
        })
      : null;

  const parents = descriptor.parent ? await readEligibleParents(supabase, descriptor, transport) : [];
  const eligibleParentIds = new Set(parents.map((row) => row.id));

  const batches = descriptor.parent
    ? (args.limit && descriptor.limitApplies === 'parents' ? parents.slice(0, args.limit) : parents)
    : [null];

  let considered = 0;
  let embedded = 0;
  let staleFound = 0;

  for (const parent of batches) {
    let rows = await readChildren(supabase, descriptor, parent, transport);
    if (!descriptor.parent && args.limit) {
      // A stable prefix rather than a random slice — the child read is ordered.
      rows = rows.slice(0, args.limit);
    }
    considered += rows.length;

    const chunks = descriptor.decorate ? rows.map((row) => descriptor.decorate(row, parent)) : rows;

    if (!client) {
      staleFound += chunks.filter((row) => evaluateChunkEmbedding(row, target).needsEmbedding).length;
      continue;
    }

    const { patches } = await embedChunks({
      chunks,
      client,
      inputSpec: descriptor.inputSpec
    });
    for (const patch of patches) {
      const { id, ...columns } = patch;
      await transport.updateById(supabase, descriptor.child.table, id, {
        ...columns,
        // pgvector wants a literal, not a JSON array.
        embedding: toVectorLiteral(columns.embedding)
      });
    }
    embedded += patches.length;
  }

  const cleared = await clearOrphans({ descriptor, args, supabase, eligibleParentIds, transport });

  return {
    eligibleParents: parents.length,
    parentsProcessed: batches.length,
    considered,
    embedded,
    // What a report calls "would be embedded". On a real run the answer is what
    // was embedded, because the gate ran and the writes followed it.
    staleFound: client ? embedded : staleFound,
    cleared,
    reportOnly: !client,
    // So a caller can say "skipped embedding" rather than "dry run" when the
    // only thing missing was the key.
    missingKey: !args.dryRun && !config.openaiApiKey
  };
}

async function readEligibleParents(supabase, descriptor, transport) {
  const rows = await transport.selectAll(
    supabase,
    descriptor.parent.table,
    descriptor.parent.filters ?? {},
    descriptor.parent.columns
  );
  return descriptor.parent.isEligible ? rows.filter(descriptor.parent.isEligible) : rows;
}

async function readChildren(supabase, descriptor, parent, transport) {
  const { table, columns, parentKey, filters = {}, order } = descriptor.child;
  return transport.selectAll(
    supabase,
    table,
    parent ? { ...filters, [parentKey]: parent.id } : filters,
    columns,
    order ? { order } : {}
  );
}

/**
 * The invariant from the other direction: a row holding a vector it should not.
 *
 * READS EVERY EMBEDDED ROW, PAGED. This used to be a plain `supabaseSelect` on
 * the knowledge and exemplar side, which PostgREST silently caps at
 * `db-max-rows` (1000) — so past a thousand embedded rows the sweep simply
 * stopped seeing the orphans, with no error and no way to tell. The message
 * reconciler had already been fixed for this reason; now all three are.
 */
async function clearOrphans({ descriptor, args, supabase, eligibleParentIds, transport }) {
  const { orphan, child } = descriptor;

  const rows = await transport.selectAll(supabase, child.table, HAS_VECTOR, orphan.columns);
  const orphans = rows.filter((row) => orphan.isOrphan(row, eligibleParentIds));

  if (orphans.length === 0 || args.dryRun) {
    return orphans.length;
  }

  if (orphan.clearBy === 'parent') {
    // One update per parent rather than per row: the whole point of a parent
    // losing approval is that every child under it goes at once.
    const cleared = buildClearEmbeddingPatch('ignored');
    delete cleared.id;
    for (const parentId of new Set(orphans.map((row) => row[child.parentKey]))) {
      await transport.update(supabase, child.table, { [child.parentKey]: parentId }, cleared);
    }
  } else {
    for (const row of orphans) {
      const { id, ...columns } = buildClearEmbeddingPatch(row.id);
      await transport.updateById(supabase, child.table, id, columns);
    }
  }

  return orphans.length;
}
