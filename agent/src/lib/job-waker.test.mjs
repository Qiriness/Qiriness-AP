import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createJobListener, createJobWaker, ringsFor } from './job-waker.mjs';

const never = () => false;
const fakeListener = (listening = true) => {
  let wake = null;
  return { isListening: () => listening, onWake: (fn) => { wake = fn; }, ring: () => wake?.(), set: (value) => { listening = value; } };
};
const timed = async (promise) => {
  const start = Date.now();
  await promise;
  return Date.now() - start;
};

test('without a listener it asks hasDue every checkIntervalMs, as the REST worker does', async () => {
  let asks = 0;
  const waker = createJobWaker({ nextDueAt: async () => assert.fail('not over REST'), hasDue: async () => ++asks >= 3, checkIntervalMs: 20 });
  const ms = await timed(waker.wait(5_000, never));
  assert.equal(asks, 3);
  assert.ok(ms < 1_000, `woke after ${ms} ms`);
});

test('listening, with nothing queued, it sleeps to the deadline without asking hasDue', async () => {
  let reads = 0;
  const waker = createJobWaker({ listener: fakeListener(), nextDueAt: async () => { reads += 1; return null; }, hasDue: async () => assert.fail('no polling while listening'), checkIntervalMs: 10 });
  const ms = await timed(waker.wait(150, never));
  assert.ok(ms >= 140, `returned after ${ms} ms`);
  assert.equal(reads, 1, 'one read of the queue, then asleep');
});

test('a ring wakes it at once when a job is now due', async () => {
  const listener = fakeListener();
  let due = null;
  const waker = createJobWaker({ listener, nextDueAt: async () => due, hasDue: never, checkIntervalMs: 60_000 });
  const polledAt = Date.now();
  setTimeout(() => { due = new Date(); listener.ring(); }, 50);
  const ms = await timed(waker.wait(10_000, never, { polledAt }));
  assert.ok(ms < 1_000, `woke after ${ms} ms`);
});

test('a ring for a job due later sleeps until it is due', async () => {
  const listener = fakeListener();
  const at = new Date(Date.now() + 120);
  const waker = createJobWaker({ listener, nextDueAt: async () => at, hasDue: never, checkIntervalMs: 60_000 });
  const ms = await timed(waker.wait(10_000, never, { polledAt: Date.now() - 1 }));
  assert.ok(ms >= 100 && ms < 1_500, `woke after ${ms} ms`);
});

test('a job already due before the last poll waits the old check interval instead of looping', async () => {
  const polledAt = Date.now();
  const stale = new Date(polledAt - 1_000);
  const waker = createJobWaker({ listener: fakeListener(), nextDueAt: async () => stale, hasDue: never, checkIntervalMs: 150 });
  const ms = await timed(waker.wait(10_000, never, { polledAt }));
  assert.ok(ms >= 140 && ms < 1_500, `woke after ${ms} ms`);
});

test('a queue it cannot read falls back to hasDue for that turn', async () => {
  let asks = 0;
  const waker = createJobWaker({ listener: fakeListener(), nextDueAt: async () => { throw new Error('boom'); }, hasDue: async () => ++asks >= 1, checkIntervalMs: 20 });
  await waker.wait(5_000, never);
  assert.equal(asks, 1);
});

test('the listener going down mid-wait hands over to hasDue', async () => {
  const listener = fakeListener();
  let asks = 0;
  const waker = createJobWaker({ listener, nextDueAt: async () => null, hasDue: async () => ++asks >= 1, checkIntervalMs: 20, fallbackMs: 600_000 });
  // The real listener rings when it goes down (createJobListener's `down`).
  setTimeout(() => { listener.set(false); listener.ring(); }, 10);
  const ms = await timed(waker.wait(10_000, never));
  assert.equal(asks, 1);
  assert.ok(ms < 1_000, `woke after ${ms} ms`);
});

test('a stop ends the wait', async () => {
  let stop = false;
  const waker = createJobWaker({ listener: fakeListener(), nextDueAt: async () => null, hasDue: never, checkIntervalMs: 10 });
  setTimeout(() => { stop = true; }, 30);
  const ms = await timed(waker.wait(60_000, () => stop));
  assert.ok(ms < 2_000, `stopped after ${ms} ms`);
});

test('ringsFor: this shop and a wake kind ring; another shop or kind does not; garbage rings', () => {
  const scope = { shopId: 's1', kinds: ['sync_mailbox', 'sync_social'] };
  assert.equal(ringsFor(JSON.stringify({ shop_id: 's1', kind: 'sync_mailbox' }), scope), true);
  assert.equal(ringsFor(JSON.stringify({ shop_id: 's2', kind: 'sync_mailbox' }), scope), false);
  assert.equal(ringsFor(JSON.stringify({ shop_id: 's1', kind: 'send_outbound' }), scope), false);
  assert.equal(ringsFor('not json', scope), true);
});

function fakeClient({ failListen = false } = {}) {
  const client = new EventEmitter();
  client.queries = [];
  client.ended = false;
  client.query = async (sql) => {
    client.queries.push(sql);
    if (failListen && sql.startsWith('LISTEN')) throw new Error('listen refused');
    return { rows: [] };
  };
  client.end = async () => { client.ended = true; };
  return client;
}

test('the listener LISTENs, rings on connect and on a notification for this shop, and reconnects after an error', async () => {
  const clients = [];
  let failures = 1;
  const listener = createJobListener({
    connect: async () => {
      if (failures-- > 0) throw new Error('first connect refused');
      const client = fakeClient();
      clients.push(client);
      return client;
    },
    shopId: 's1',
    kinds: ['sync_mailbox'],
    maxBackoffMs: 20
  });
  let rings = 0;
  listener.onWake(() => { rings += 1; });
  await listener.start();
  assert.equal(listener.isListening(), false, 'the first connect failed');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(listener.isListening(), true, 'retried after the back-off');
  assert.deepEqual(clients[0].queries, ['LISTEN mail_jobs']);
  assert.equal(rings, 1, 'a ring on connecting, to re-read the queue');

  clients[0].emit('notification', { channel: 'mail_jobs', payload: JSON.stringify({ shop_id: 's1', kind: 'sync_mailbox' }) });
  clients[0].emit('notification', { channel: 'mail_jobs', payload: JSON.stringify({ shop_id: 's9', kind: 'sync_mailbox' }) });
  assert.equal(rings, 2);

  clients[0].emit('error', new Error('connection reset'));
  clients[0].emit('end');
  assert.equal(listener.isListening(), false);
  assert.equal(clients[0].ended, true);
  assert.equal(rings, 3, 'losing the connection rings, once');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(clients.length, 2, 'one reconnect for one lost connection');
  assert.equal(rings, 4, 'and a ring on reconnecting');
  assert.equal(listener.isListening(), true);
  await listener.stop();
});
