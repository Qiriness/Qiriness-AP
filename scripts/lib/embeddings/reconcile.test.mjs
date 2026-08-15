import assert from 'node:assert/strict';
import test from 'node:test';

import { KNOWLEDGE_CHUNKS } from '../../embed-knowledge-chunks.mjs';
import { EXEMPLAR_PHRASINGS } from '../../embed-exemplars.mjs';
import { TICKET_MESSAGES } from '../../embed-ticket-messages.mjs';
import { COLUMNS, T, VECTOR_COLUMNS } from '../tables.mjs';
import { reconcileEmbeddings } from './reconcile.mjs';

/**
 * The loop, tested — which it never was while it existed three times.
 *
 * `embed-chunks.mjs` already covers the staleness gate as a pure function. What
 * these cover is everything around it: which rows are read, which are skipped,
 * what a dry run does not write, and the orphan sweep that stops a vector
 * outliving the text it was derived from. The gate cannot be wrong about a row
 * nobody read, which is why those were the interesting failures all along.
 */

const CONFIG = { embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, openaiApiKey: 'k' };
const VECTOR = Array.from({ length: 1536 }, () => 0.1);

/** In-memory tables plus a recording transport. */
function harness(tables) {
  const writes = [];
  const reads = [];

  const matches = (row, filters) =>
    Object.entries(filters).every(([column, value]) => {
      if (value && typeof value === 'object' && value.operator) {
        if (value.operator === 'is' && value.value === 'null') return row[column] == null;
        if (value.operator === 'not.is' && value.value === 'null') return row[column] != null;
        return true;
      }
      return row[column] === value;
    });

  const transport = {
    async selectAll(_client, table, filters, columns, options) {
      reads.push({ table, filters, columns, options });
      return (tables[table] || []).filter((row) => matches(row, filters)).map((row) => ({ ...row }));
    },
    async update(_client, table, filters, columns) {
      writes.push({ kind: 'update', table, filters, columns });
      return [];
    },
    async updateById(_client, table, id, columns) {
      writes.push({ kind: 'updateById', table, id, columns });
      return { id };
    },
    // The real client carries its model and dimensions, and `embedChunks` reads
    // them off it rather than off the config — so the fake has to as well, or
    // every patch is written with an undefined model and never goes stale.
    createEmbeddingsClient: ({ model, dimensions }) => ({
      model,
      dimensions,
      async embed(inputs) {
        return inputs.map(() => VECTOR);
      }
    })
  };

  return { writes, reads, transport };
}

const run = ({ descriptor, tables, args = {}, config = CONFIG }) => {
  const h = harness(tables);
  return reconcileEmbeddings({ descriptor, args, config, supabase: {}, transport: h.transport }).then(
    (result) => ({ result, ...h })
  );
};

/** A chunk with no vector — the thing a first run is for. */
const unembedded = (id, documentId) => ({
  id,
  knowledge_document_id: documentId,
  section_heading: 'Livraison',
  category: 'delivery',
  chunk_text: 'Nous expédions sous 48 heures.',
  embedding: null,
  embedding_model: null,
  embedding_dimensions: null,
  embedded_input_hash: null
});

// --- the loop ----------------------------------------------------------------

test('a first run embeds every chunk under an approved document', async () => {
  const { result, writes } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1'), unembedded('c2', 'd1')]
    }
  });

  assert.equal(result.embedded, 2);
  assert.equal(result.eligibleParents, 1);
  const patches = writes.filter((w) => w.kind === 'updateById');
  assert.equal(patches.length, 2);
  // pgvector wants a literal, not a JSON array — a write that skipped this is
  // rejected by Postgres at run time, on the one path that produced it.
  assert.match(patches[0].columns.embedding, /^\[0\.1,/);
  assert.equal(patches[0].columns.embedding_dimensions, 1536);
  assert.ok(patches[0].columns.embedded_input_hash, 'the hash is what makes a second run free');
});

test('a chunk whose stored hash still matches is not re-embedded', async () => {
  // Idempotency, which is the reconciler's whole claim: a second run with no
  // intervening edit costs nothing.
  const first = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1')]
    }
  });
  const written = first.writes.find((w) => w.kind === 'updateById').columns;

  const second = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [{ ...unembedded('c1', 'd1'), ...written, embedding: VECTOR }]
    }
  });

  assert.equal(second.result.embedded, 0);
  assert.equal(second.writes.filter((w) => w.kind === 'updateById').length, 0);
});

test('a model change makes every stored vector stale again', async () => {
  const { result } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    config: { ...CONFIG, embeddingModel: 'text-embedding-3-large' },
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [
        {
          ...unembedded('c1', 'd1'),
          embedding: VECTOR,
          embedding_model: 'text-embedding-3-small',
          embedding_dimensions: 1536,
          embedded_input_hash: 'whatever'
        }
      ]
    }
  });

  assert.equal(result.embedded, 1);
});

test('a dry run counts what it would do and writes nothing at all', async () => {
  const { result, writes } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    args: { dryRun: true },
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1'), { ...unembedded('c2', 'draft-doc'), embedding: VECTOR }]
    }
  });

  assert.equal(writes.length, 0, 'a dry run must not write');
  assert.equal(result.staleFound, 1, 'the chunk that would be embedded');
  assert.equal(result.cleared, 1, 'the orphan that would be cleared');
  assert.equal(result.reportOnly, true);
});

test('without an API key the orphan sweep still runs, and the embedding does not', async () => {
  const { result, writes } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    config: { ...CONFIG, openaiApiKey: '' },
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1'), { ...unembedded('c9', 'gone'), embedding: VECTOR }]
    }
  });

  assert.equal(result.missingKey, true);
  assert.equal(result.embedded, 0);
  assert.equal(result.cleared, 1);
  // The only write is the clear — nothing was embedded.
  assert.deepEqual(writes.map((w) => w.kind), ['update']);
});

test('--limit caps documents on the knowledge run', async () => {
  const { result } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    args: { limit: 1 },
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [
        { id: 'd1', title: 'A', core_topic: null, approval_status: 'approved' },
        { id: 'd2', title: 'B', core_topic: null, approval_status: 'approved' }
      ],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1'), unembedded('c2', 'd2')]
    }
  });

  assert.equal(result.eligibleParents, 2, 'both are eligible');
  assert.equal(result.parentsProcessed, 1, 'only one was worked');
  assert.equal(result.embedded, 1);
});

test('--limit caps rows on the message run, which has no documents to cap', async () => {
  const message = (id) => ({
    id,
    subject: 'Commande',
    body_text: 'Où est ma commande ?',
    deleted_at: null,
    embedding: null,
    embedding_model: null,
    embedding_dimensions: null,
    embedded_input_hash: null
  });

  const { result } = await run({
    descriptor: TICKET_MESSAGES,
    args: { limit: 2 },
    tables: { [T.TICKET_MESSAGES]: [message('m1'), message('m2'), message('m3')] }
  });

  assert.equal(result.considered, 2);
  assert.equal(result.embedded, 2);
});

test('a chunk under a document that lost approval has its vector cleared, once per document', async () => {
  const { result, writes } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'live', title: 'A', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [
        { ...unembedded('c1', 'draft'), embedding: VECTOR },
        { ...unembedded('c2', 'draft'), embedding: VECTOR },
        { ...unembedded('c3', 'live'), embedding: VECTOR, embedded_input_hash: 'stale' }
      ]
    }
  });

  assert.equal(result.cleared, 2);
  const clears = writes.filter((w) => w.kind === 'update');
  // One update for the document, not one per chunk under it.
  assert.equal(clears.length, 1);
  assert.deepEqual(clears[0].filters, { knowledge_document_id: 'draft' });
  assert.equal(clears[0].columns.embedding, null);
  assert.equal(clears[0].columns.embedding_model, null);
});

test('a redacted message has its vector cleared row by row', async () => {
  const { result, writes } = await run({
    descriptor: TICKET_MESSAGES,
    tables: {
      [T.TICKET_MESSAGES]: [
        { id: 'm1', subject: 's', body_text: null, deleted_at: null, embedding: VECTOR },
        { id: 'm2', subject: 's', body_text: 'x', deleted_at: '2026-08-01T00:00:00Z', embedding: VECTOR }
      ]
    }
  });

  // Neither is a candidate for embedding — the child filters exclude both.
  assert.equal(result.considered, 0);
  assert.equal(result.cleared, 2);
  const clears = writes.filter((w) => w.kind === 'updateById');
  assert.deepEqual(clears.map((w) => w.id).sort(), ['m1', 'm2']);
  assert.equal(clears[0].columns.embedding, null);
});

test('a phrasing under a soft-deleted exemplar is cleared even though approval never changed', async () => {
  // `deleted_at` is set by the dashboard without touching approval_status, so
  // the parent filter alone would leave a deleted situation retrievable.
  const { result } = await run({
    descriptor: EXEMPLAR_PHRASINGS,
    tables: {
      [T.SUPPORT_EXEMPLARS]: [
        { id: 'live', exemplar_key: 'P-1', deleted_at: null, approval_status: 'approved' },
        { id: 'gone', exemplar_key: 'P-2', deleted_at: '2026-08-01T00:00:00Z', approval_status: 'approved' }
      ],
      [T.SUPPORT_EXEMPLAR_PHRASINGS]: [
        { id: 'p1', support_exemplar_id: 'gone', phrasing_text: 'où est ma commande', embedding: VECTOR }
      ]
    }
  });

  assert.equal(result.eligibleParents, 1, 'the deleted exemplar is not eligible');
  assert.equal(result.cleared, 1);
});

test('the knowledge input carries the document title, so a retitle invalidates its chunks', async () => {
  const first = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Livraison', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1')]
    }
  });
  const written = first.writes.find((w) => w.kind === 'updateById').columns;

  const retitled = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'Expédition', core_topic: null, approval_status: 'approved' }],
      [T.KNOWLEDGE_CHUNKS]: [{ ...unembedded('c1', 'd1'), ...written, embedding: VECTOR }]
    }
  });

  assert.equal(retitled.result.embedded, 1, 'the title is part of the composed input');
});

test('the brand document is excluded, and its exclusion does not take the null ones with it', async () => {
  // Most documents have a null core_topic; PostgREST's `neq.brand` would drop
  // those too, which is every ordinary document. Hence the JS filter.
  const { result } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [
        { id: 'brand', title: 'Voix', core_topic: 'brand', approval_status: 'approved' },
        { id: 'plain', title: 'Livraison', core_topic: null, approval_status: 'approved' },
        { id: 'topic', title: 'Retours', core_topic: 'returns', approval_status: 'approved' }
      ],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'plain'), unembedded('c2', 'topic'), unembedded('c3', 'brand')]
    }
  });

  assert.equal(result.eligibleParents, 2, 'brand out, both others in');
  assert.equal(result.embedded, 2);
});

test('an unapproved document is never read for embedding at all', async () => {
  const { reads } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [{ id: 'd1', title: 'A', core_topic: null, approval_status: 'in_review' }],
      [T.KNOWLEDGE_CHUNKS]: [unembedded('c1', 'd1')]
    }
  });

  // The parent read filters on approval; no child read follows.
  assert.equal(reads[0].filters.approval_status, 'approved');
  assert.ok(
    !reads.some((r) => r.filters.knowledge_document_id === 'd1'),
    'chunks under an unapproved document must not be read'
  );
});

test('the orphan sweep pages, rather than being silently capped at 1000 rows', async () => {
  // This was a real hole on the knowledge and exemplar side: a plain
  // supabaseSelect, which PostgREST caps at db-max-rows with a 206 and no error.
  const { reads } = await run({
    descriptor: KNOWLEDGE_CHUNKS,
    tables: {
      [T.KNOWLEDGE_DOCUMENTS]: [],
      [T.KNOWLEDGE_CHUNKS]: []
    }
  });

  const sweep = reads.at(-1);
  assert.deepEqual(sweep.filters, { embedding: { operator: 'not.is', value: 'null' } });
  assert.equal(sweep.table, T.KNOWLEDGE_CHUNKS);
});

// --- the descriptors ---------------------------------------------------------

test('every descriptor reads the whole determinism quadruple', () => {
  // A descriptor missing one of these would embed the same row on every run (no
  // stored hash to compare) or never re-embed it after a model change.
  for (const [name, descriptor] of Object.entries({
    KNOWLEDGE_CHUNKS,
    EXEMPLAR_PHRASINGS,
    TICKET_MESSAGES
  })) {
    const columns = descriptor.child.columns.split(',');
    assert.ok(columns.includes('id'), `${name} must read the id it patches`);
    for (const column of VECTOR_COLUMNS) {
      assert.ok(columns.includes(column), `${name} does not read ${column}`);
    }
  }
});

test('the three descriptors name the three embedded tables, and use the contract projections', () => {
  assert.deepEqual(
    [KNOWLEDGE_CHUNKS, EXEMPLAR_PHRASINGS, TICKET_MESSAGES].map((d) => d.child.table).sort(),
    [T.KNOWLEDGE_CHUNKS, T.SUPPORT_EXEMPLAR_PHRASINGS, T.TICKET_MESSAGES].sort()
  );
  assert.equal(KNOWLEDGE_CHUNKS.child.columns, COLUMNS.chunkForEmbedding);
  assert.equal(EXEMPLAR_PHRASINGS.child.columns, COLUMNS.phrasingForEmbedding);
  assert.equal(TICKET_MESSAGES.child.columns, COLUMNS.messageForEmbedding);
});

test('only the message reconciler has no approval gate', () => {
  // Every stored message is part of the corpus; knowledge and exemplars hold a
  // vector only while an approved parent says they may. See DECISIONS.md.
  assert.equal(TICKET_MESSAGES.parent, null);
  assert.equal(KNOWLEDGE_CHUNKS.parent.filters.approval_status, 'approved');
  assert.equal(EXEMPLAR_PHRASINGS.parent.filters.approval_status, 'approved');
});
