import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_MAX_AGE_MS, SOURCE_STAMPS, createAgentCache, readSourceStamp } from './agent-freshness.mjs';

const TTL = 5 * 60 * 1000;
const AHEAD = 60 * 1000;

function harness({ stamp = 'v1', buildStamp } = {}) {
  const state = { clock: 0, stamp, builds: 0, stampReads: 0, stampFails: false, buildFails: false };
  const cache = createAgentCache({
    now: () => state.clock,
    ttlMs: TTL,
    aheadMs: AHEAD,
    build: async (key) => {
      if (state.buildFails) throw new Error('catalogue unavailable');
      state.builds += 1;
      return { agent: { key, n: state.builds }, knowledge: { loadedAt: state.clock }, stamp: buildStamp === undefined ? state.stamp : buildStamp };
    },
    readStamp: async () => {
      state.stampReads += 1;
      if (state.stampFails) throw new Error('unreachable');
      return state.stamp;
    }
  });
  return { state, cache };
}

test('an unchanged source is renewed in place, not reloaded, and its knowledge counts as checked now', async () => {
  const { state, cache } = harness();
  const first = await cache.current('m');
  assert.equal(state.builds, 1);

  state.clock = TTL - AHEAD; // the check starts a minute ahead, as the rebuild did
  assert.equal(await cache.current('m'), first, 'served while it checks');
  await new Promise((r) => setImmediate(r));
  assert.equal(state.stampReads, 1);
  assert.equal(state.builds, 1, 'no reload');
  assert.equal(first.n, 1);
  assert.equal(cache.state.at, TTL - AHEAD, 'renewed');

  // Past what would have been its lifetime: still the same agent, no wait.
  state.clock = TTL + 1000;
  assert.equal(await cache.current('m'), first);
  assert.equal(state.builds, 1);
});

test('the renewed knowledge is marked fresh, so policies keep answering', async () => {
  let clock = 0;
  let knowledge;
  const cache = createAgentCache({
    now: () => clock, ttlMs: TTL, aheadMs: AHEAD,
    build: async () => { knowledge = { loadedAt: clock }; return { agent: {}, knowledge, stamp: 'v1' }; },
    readStamp: async () => 'v1'
  });
  await cache.current('m');
  clock = TTL; // expired: the check is awaited
  await cache.current('m');
  assert.equal(knowledge.loadedAt, TTL);
});

test('a changed source is rebuilt, and an expired agent waits for it', async () => {
  const { state, cache } = harness();
  await cache.current('m');
  state.stamp = 'v2';
  state.clock = TTL + 1; // after a pause: past its lifetime
  const next = await cache.current('m');
  assert.equal(state.builds, 2);
  assert.equal(next.n, 2);
});

test('a fingerprint that cannot be read means a rebuild, as before', async () => {
  const { state, cache } = harness();
  await cache.current('m');
  state.stampFails = true;
  state.clock = TTL;
  await cache.current('m');
  assert.equal(state.builds, 2);
});

test('a degraded agent (no stamp) is never renewed', async () => {
  const { state, cache } = harness({ buildStamp: null });
  await cache.current('m');
  state.clock = TTL;
  await cache.current('m');
  assert.equal(state.stampReads, 0);
  assert.equal(state.builds, 2);
});

test('read whole again after a day, whatever the fingerprint says', async () => {
  const { state, cache } = harness();
  await cache.current('m');
  for (let t = TTL; t < AGENT_MAX_AGE_MS; t += TTL) {
    state.clock = t;
    await cache.current('m');
  }
  assert.equal(state.builds, 1);
  state.clock = AGENT_MAX_AGE_MS + TTL;
  await cache.current('m');
  assert.equal(state.builds, 2);
});

test('a failed rebuild of an expired agent serves the last one, as before', async () => {
  const { state, cache } = harness();
  const first = await cache.current('m');
  state.stamp = 'v2';
  state.buildFails = true;
  state.clock = TTL + 1;
  assert.equal(await cache.current('m'), first);
});

test('cold requests share one build; another model builds its own', async () => {
  const { state, cache } = harness();
  const [a, b] = await Promise.all([cache.current('m'), cache.current('m')]);
  assert.equal(a, b);
  assert.equal(state.builds, 1);
  const other = await cache.current('m2');
  assert.equal(other.key, 'm2');
  assert.equal(state.builds, 2);
});

test('the fingerprint: one row per table, whole rows where a row can be deleted, the shop by its name', async () => {
  const calls = [];
  const data = {
    shops: [{ shop_name: 'Boutique' }],
    company_policies: [{ id: 'p1', updated_at: 't1' }, { id: 'p2', updated_at: 't2' }],
    knowledge_documents: [{ id: 'k1', updated_at: 't3' }]
  };
  const select = async (table, filters, columns, options) => {
    calls.push({ table, filters, columns, options });
    return data[table] ?? [{ updated_at: `${table}-newest` }];
  };
  const stamp = await readSourceStamp(select, 's1');
  assert.equal(calls.length, SOURCE_STAMPS.length);
  assert.deepEqual(calls.find((c) => c.table === 'shops'), { table: 'shops', filters: { id: 's1' }, columns: 'shop_name', options: { limit: 1 } });
  assert.deepEqual(calls.find((c) => c.table === 'products').options, { order: 'updated_at.desc', limit: 1 });
  assert.equal(calls.find((c) => c.table === 'company_policies').columns, 'id,updated_at');
  assert.match(stamp, /company_policies:2:p1@t1,p2@t2/);
  assert.match(stamp, /shops:Boutique/);

  // A policy deleted outright moves no updated_at, but changes the fingerprint.
  data.company_policies.pop();
  assert.notEqual(await readSourceStamp(select, 's1'), stamp);
});
