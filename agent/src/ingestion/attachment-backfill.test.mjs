import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttachmentBackfillStore, runAttachmentBackfill } from './attachment-backfill.mjs';

// The corpus this repair walks, as Supabase holds it. `attachments: null` is the
// condition it selects on; `has_attachments` is recorded but must not gate it.
const ROWS = [
  { id: 'm1', graph_message_id: 'g1', has_attachments: false, attachments: null, deleted_at: null },
  { id: 'm2', graph_message_id: 'g2', has_attachments: true, attachments: null, deleted_at: null },
  { id: 'm3', graph_message_id: 'g3', has_attachments: false, attachments: [], deleted_at: null }
];

/**
 * Captures the query `pending` builds.
 *
 * It has to go through the real `supabaseSelect` — the filter is the thing under
 * test, and a hand-rolled fake would be asserting against my own reading of the
 * query rather than the query PostgREST is sent.
 */
function buildSupabase(rows = ROWS) {
  const queries = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    queries.push(String(url));
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    if (from > 0) return { ok: true, json: async () => [] };

    const params = new URL(String(url)).searchParams;
    const matched = rows.filter((row) => {
      if (params.get('attachments') === 'is.null' && row.attachments !== null) return false;
      const flag = params.get('has_attachments');
      if (flag && row.has_attachments !== (flag === 'eq.true')) return false;
      return true;
    });
    return { ok: true, json: async () => matched };
  };

  return {
    queries,
    client: { baseUrl: 'https://example.test/rest/v1', key: 'test-key' },
    restore: () => { globalThis.fetch = originalFetch; }
  };
}

function fakeStore(rows) {
  const saved = new Map();
  return {
    saved,
    async pending() {
      return rows;
    },
    async save(id, attachments) {
      saved.set(id, attachments);
    }
  };
}

const IMAGE = { name: 'gmail_image.png', contentType: 'image/png', size: 3_623_198, isInline: true };

test('the queue is every unfetched row, whatever has_attachments says', async (t) => {
  // THE BUG THIS FILE EXISTS FOR. The filter carried `has_attachments: true`,
  // so the rows it could never reach were the ones worth reaching: an inline
  // photo sets the flag false. Measured 2026-09-20 — 199 of 234 inbound
  // messages were unreachable, 6 of the 7 probed carried inline images.
  const sb = buildSupabase();
  t.after(sb.restore);

  const pending = await createAttachmentBackfillStore(sb.client).pending('shop-1', 25);

  assert.deepEqual(
    pending.map((row) => row.id),
    ['m1', 'm2'],
    'both null rows are due; the flag decides nothing'
  );
  assert.ok(
    !sb.queries[0].includes('has_attachments'),
    'the flag must not appear in the query at all'
  );
  assert.ok(sb.queries[0].includes('attachments=is.null'));
});

test('a row that already has an empty array is finished, not re-fetched', async (t) => {
  // `[]` is a real answer — we asked and nothing was attached. Re-asking would
  // make the repair unable to ever terminate.
  const sb = buildSupabase();
  t.after(sb.restore);

  const pending = await createAttachmentBackfillStore(sb.client).pending('shop-1', 25);

  assert.ok(!pending.some((row) => row.id === 'm3'));
});

test('an inline photo on an unflagged message is written through', async () => {
  const store = fakeStore([ROWS[0]]);
  const totals = await runAttachmentBackfill({
    store,
    graphClient: { async getAttachmentMetadata() { return [IMAGE]; } },
    shopId: 'shop-1'
  });

  assert.equal(totals.filled, 1);
  assert.equal(totals.withImages, 1);
  assert.deepEqual(store.saved.get('m1'), [IMAGE]);
});

test('a message gone from the mailbox keeps its null', async () => {
  // Writing `[]` here would claim we looked and found nothing attached, about a
  // message we can no longer see at all.
  const store = fakeStore([ROWS[0]]);
  const totals = await runAttachmentBackfill({
    store,
    graphClient: { async getAttachmentMetadata() { return null; } },
    shopId: 'shop-1'
  });

  assert.equal(totals.gone, 1);
  assert.equal(totals.filled, 0);
  assert.equal(store.saved.size, 0);
});

test('a dry run reports what it would fill and writes nothing', async () => {
  const store = fakeStore([ROWS[0], ROWS[1]]);
  const totals = await runAttachmentBackfill({
    store,
    graphClient: { async getAttachmentMetadata() { return [IMAGE]; } },
    shopId: 'shop-1',
    dryRun: true
  });

  assert.equal(totals.filled, 2);
  assert.equal(store.saved.size, 0);
});

test('a mailbox-id mismatch stops the run instead of failing every row', async () => {
  const store = fakeStore([ROWS[0], ROWS[1]]);
  let calls = 0;
  const totals = await runAttachmentBackfill({
    store,
    graphClient: {
      async getAttachmentMetadata() {
        calls += 1;
        const error = new Error('wrong mailbox');
        error.mailboxMismatch = true;
        throw error;
      }
    },
    shopId: 'shop-1'
  });

  assert.equal(calls, 1, 'stops after the first, rather than repeating it per row');
  assert.equal(totals.mailboxMismatch, true);
  assert.equal(totals.failed, 0);
});
