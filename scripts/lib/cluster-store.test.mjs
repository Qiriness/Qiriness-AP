import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KEEP_RUNS,
  buildClusterRows,
  buildRunRow,
  createClusterStore
} from './cluster-store.mjs';
import { T } from './tables.mjs';

const SHOP = '00000000-0000-4000-8000-000000000001';

const FACTS = {
  shopId: SHOP,
  builtAt: '2026-08-16T09:00:00.000Z',
  threshold: 0.68,
  minSize: 2,
  dedupe: 0.97,
  messageCount: 780,
  internalExcluded: 331,
  subjectCount: 12,
  topicCount: 2
};

const CLUSTERS = [
  {
    subject: 'order',
    clusterIndex: 0,
    size: 5,
    cohesion: 0.7412345,
    representativeExcerpt: 'je nai toujours pas recu ma commande',
    memberMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5']
  },
  {
    subject: 'delivery',
    clusterIndex: 0,
    size: 2,
    cohesion: 0.69,
    representativeExcerpt: 'le suivi nest plus mis a jour',
    memberMessageIds: ['m6', 'm7']
  }
];

/**
 * Stands in for PostgREST at the fetch boundary, so the real REST client — its
 * headers, its filters, its error handling — is what the store is tested
 * against. Handlers are keyed `METHOD table`; an unhandled call fails the test
 * loudly rather than silently returning something plausible.
 */
function stubSupabase(handlers) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const table = parsed.pathname.split('/').pop();
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    const call = { table, method, body, params: parsed.searchParams };
    calls.push(call);

    const handler = handlers[`${method} ${table}`];
    if (!handler) {
      throw new Error(`unexpected ${method} ${table}`);
    }
    return handler(call);
  };

  return {
    supabase: { baseUrl: 'https://db.test/rest/v1', key: 'test-key' },
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const ok = (rows) => ({ ok: true, status: 200, json: async () => rows });
// 400, not 500: `supabaseFetch` retries 5xx with a backoff, which would make a
// failure test sleep for over a second to prove the same thing.
const rejected = (message) => ({ ok: false, status: 400, json: async () => ({ message }) });

// --- pure mapping ----------------------------------------------------

test('run facts map to the cluster_runs row', () => {
  assert.deepEqual(buildRunRow(FACTS), {
    shop_id: SHOP,
    built_at: '2026-08-16T09:00:00.000Z',
    threshold: 0.68,
    min_size: 2,
    dedupe: 0.97,
    message_count: 780,
    internal_excluded: 331,
    subject_count: 12,
    topic_count: 2
  });
});

test('a run with no built_at is stamped now', () => {
  const row = buildRunRow({ ...FACTS, builtAt: undefined });
  assert.ok(!Number.isNaN(Date.parse(row.built_at)));
});

test('counts default to zero rather than null', () => {
  const row = buildRunRow({ shopId: SHOP, threshold: 0.68, minSize: 2, dedupe: 0.97 });
  assert.equal(row.message_count, 0);
  assert.equal(row.internal_excluded, 0);
  assert.equal(row.subject_count, 0);
  assert.equal(row.topic_count, 0);
});

test('clustering output maps to ticket_clusters rows, stamped with the run', () => {
  const rows = buildClusterRows({ shopId: SHOP, runId: 'run-1', clusters: CLUSTERS });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    shop_id: SHOP,
    run_id: 'run-1',
    subject: 'order',
    cluster_index: 0,
    size: 5,
    cohesion: 0.741,
    representative_excerpt: 'je nai toujours pas recu ma commande',
    member_message_ids: ['m1', 'm2', 'm3', 'm4', 'm5']
  });
  // Both topics are index 0: the index ranks within a subject, and the unique
  // key is (run_id, subject, cluster_index).
  assert.equal(rows[1].cluster_index, 0);
  assert.equal(rows[1].subject, 'delivery');
});

test('numeric(4,3) values are rounded at the boundary, not by Postgres', () => {
  const [row] = buildClusterRows({
    shopId: SHOP,
    runId: 'run-1',
    clusters: [{ ...CLUSTERS[0], cohesion: 0.6785 }]
  });
  assert.equal(row.cohesion, 0.679);
  assert.equal(buildRunRow({ ...FACTS, threshold: 0.68499 }).threshold, 0.685);
});

test('a topic with no members or excerpt still produces a valid row', () => {
  const [row] = buildClusterRows({
    shopId: SHOP,
    runId: 'run-1',
    clusters: [{ subject: 'other', clusterIndex: 0, size: 2 }]
  });
  assert.deepEqual(row.member_message_ids, []);
  assert.equal(row.representative_excerpt, null);
  assert.equal(row.cohesion, null);
});

test('no clusters means no rows', () => {
  assert.deepEqual(buildClusterRows({ shopId: SHOP, runId: 'run-1' }), []);
});

// --- saveRun ---------------------------------------------------------

test('saveRun writes the run, then its clusters with the returned run id', async () => {
  const { supabase, calls, restore } = stubSupabase({
    'POST cluster_runs': () => ok([{ id: 'run-9' }]),
    'POST ticket_clusters': ({ body }) => ok(body),
    'GET cluster_runs': () => ok([{ id: 'run-9' }])
  });

  try {
    const result = await createClusterStore(supabase).saveRun(FACTS, CLUSTERS);

    assert.deepEqual(result, { runId: 'run-9', clusterCount: 2, prunedRuns: 0 });
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.table}`),
      ['POST cluster_runs', 'POST ticket_clusters', 'GET cluster_runs']
    );
    assert.deepEqual(
      calls[1].body.map((row) => row.run_id),
      ['run-9', 'run-9']
    );
  } finally {
    restore();
  }
});

test('an empty run is still recorded, and costs no cluster request', async () => {
  // No repeated topic above the threshold is a result, not a failure — it is
  // what somebody raising the threshold needs to see.
  const { supabase, calls, restore } = stubSupabase({
    'POST cluster_runs': () => ok([{ id: 'run-9' }]),
    'GET cluster_runs': () => ok([{ id: 'run-9' }])
  });

  try {
    const result = await createClusterStore(supabase).saveRun({ ...FACTS, topicCount: 0 }, []);
    assert.equal(result.clusterCount, 0);
    assert.ok(!calls.some((call) => call.table === 'ticket_clusters'));
  } finally {
    restore();
  }
});

test('a failed cluster insert deletes the run it just created', async () => {
  // The dashboard reads the NEWEST run, so an orphan header does not look like
  // an error — it looks like a rebuild that honestly found nothing.
  const { supabase, calls, restore } = stubSupabase({
    'POST cluster_runs': () => ok([{ id: 'run-9' }]),
    'POST ticket_clusters': () => rejected('violates check constraint'),
    'DELETE cluster_runs': () => ok([{ id: 'run-9' }])
  });

  try {
    await assert.rejects(
      () => createClusterStore(supabase).saveRun(FACTS, CLUSTERS),
      /violates check constraint/
    );

    const cleanup = calls.find((call) => call.method === 'DELETE');
    assert.ok(cleanup, 'the orphan run was not deleted');
    assert.equal(cleanup.table, T.CLUSTER_RUNS);
    assert.equal(cleanup.params.get('id'), 'eq.run-9');
    // Pruning must not run on a failed save.
    assert.ok(!calls.some((call) => call.method === 'GET'));
  } finally {
    restore();
  }
});

test('the original error survives a cleanup that also fails', async () => {
  const { supabase, restore } = stubSupabase({
    'POST cluster_runs': () => ok([{ id: 'run-9' }]),
    'POST ticket_clusters': () => rejected('the real problem'),
    'DELETE cluster_runs': () => rejected('cleanup also broken')
  });

  try {
    await assert.rejects(
      () => createClusterStore(supabase).saveRun(FACTS, CLUSTERS),
      /the real problem/
    );
  } finally {
    restore();
  }
});

test('a run insert that returns no row never attempts clusters', async () => {
  const { supabase, calls, restore } = stubSupabase({
    'POST cluster_runs': () => ok([])
  });

  try {
    await assert.rejects(() => createClusterStore(supabase).saveRun(FACTS, CLUSTERS), /no row/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

// --- retention -------------------------------------------------------

test('pruning keeps the newest N runs and deletes the rest', async () => {
  const runs = Array.from({ length: 13 }, (_, index) => ({ id: `run-${index}` }));
  const { supabase, calls, restore } = stubSupabase({
    'GET cluster_runs': () => ok(runs),
    'DELETE cluster_runs': () => ok([])
  });

  try {
    const pruned = await createClusterStore(supabase).pruneRuns(SHOP, { keep: 10 });

    assert.equal(pruned, 3);
    // Newest first, or "the rest" would be the wrong three.
    assert.equal(calls[0].params.get('order'), 'built_at.desc,id.desc');
    assert.equal(calls[0].params.get('shop_id'), `eq.${SHOP}`);
    assert.equal(calls[1].params.get('id'), 'in.(run-10,run-11,run-12)');
  } finally {
    restore();
  }
});

test('pruning is a no-op below the keep count, with no delete request', async () => {
  const { supabase, calls, restore } = stubSupabase({
    'GET cluster_runs': () => ok([{ id: 'run-0' }, { id: 'run-1' }])
  });

  try {
    assert.equal(await createClusterStore(supabase).pruneRuns(SHOP), 0);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('saveRun prunes after writing, and reports how many went', async () => {
  const runs = Array.from({ length: KEEP_RUNS + 2 }, (_, index) => ({ id: `run-${index}` }));
  const { supabase, restore } = stubSupabase({
    'POST cluster_runs': () => ok([{ id: 'run-0' }]),
    'POST ticket_clusters': ({ body }) => ok(body),
    'GET cluster_runs': () => ok(runs),
    'DELETE cluster_runs': () => ok([])
  });

  try {
    const result = await createClusterStore(supabase).saveRun(FACTS, CLUSTERS);
    assert.equal(result.prunedRuns, 2);
  } finally {
    restore();
  }
});

test('the default keeps ten runs', () => {
  assert.equal(KEEP_RUNS, 10);
});

// --- latestRun -------------------------------------------------------

test('latestRun returns the newest run with its clusters, largest first', async () => {
  const { supabase, calls, restore } = stubSupabase({
    'GET cluster_runs': () => ok([{ id: 'run-9', built_at: FACTS.builtAt, topic_count: 2 }]),
    'GET ticket_clusters': () => ok([{ id: 'c1', subject: 'order', size: 5 }])
  });

  try {
    const latest = await createClusterStore(supabase).latestRun(SHOP);

    assert.equal(latest.run.id, 'run-9');
    assert.equal(latest.clusters.length, 1);
    assert.equal(calls[0].params.get('limit'), '1');
    assert.equal(calls[0].params.get('order'), 'built_at.desc,id.desc');
    assert.equal(calls[1].params.get('run_id'), 'eq.run-9');
    assert.equal(calls[1].params.get('order'), 'size.desc,subject.asc,cluster_index.asc');
  } finally {
    restore();
  }
});

test('latestRun is null before any run exists, and reads no clusters', async () => {
  const { supabase, calls, restore } = stubSupabase({ 'GET cluster_runs': () => ok([]) });

  try {
    assert.equal(await createClusterStore(supabase).latestRun(SHOP), null);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});
