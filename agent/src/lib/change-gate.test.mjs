import assert from 'node:assert/strict';
import test from 'node:test';

import { createChangeGate } from './change-gate.mjs';

function setup() {
  const stamps = { tickets: 'a', orders: 'x' };
  const reads = [];
  let at = 0;
  const gate = createChangeGate({ read: async (table) => { reads.push(table); return stamps[table]; }, now: () => at, everyMs: 1000 });
  let runs = 0;
  const pass = () => gate.run('p', ['tickets', 'orders'], async () => ++runs);
  // One poll: the pass, then the end of the poll.
  const poll = async () => { const result = await pass(); await gate.endPoll(); return result; };
  return { gate, stamps, reads, pass, poll, advance: (ms) => { at += ms; }, runs: () => runs };
}

test('the first poll runs it, an unchanged second one does not', async () => {
  const s = setup();
  assert.equal(await s.poll(), 1);
  assert.equal(await s.poll(), null);
  assert.equal(s.runs(), 1);
});

test('a write to any named table runs it again', async () => {
  const s = setup();
  await s.poll();
  s.stamps.orders = 'y';
  assert.equal(await s.poll(), 2);
  assert.equal(await s.poll(), null);
});

test('time alone runs it again, for windows that elapse', async () => {
  const s = setup();
  await s.poll();
  s.advance(1000);
  assert.equal(await s.poll(), 2);
});

test('a pass that throws is not marked, so the next poll retries it', async () => {
  let calls = 0;
  const gate = createChangeGate({ read: async () => 'same', now: () => 0 });
  const failing = () => gate.run('p', ['tickets'], async () => { calls += 1; throw new Error('down'); });
  await assert.rejects(failing());
  await gate.endPoll();
  await assert.rejects(failing());
  assert.equal(calls, 2);
});

test('a table is read once per poll, whatever the number of passes naming it', async () => {
  const s = setup();
  await s.gate.run('a', ['tickets'], async () => 1);
  await s.gate.run('b', ['tickets', 'orders'], async () => 1);
  await s.gate.run('c', ['tickets'], async () => 1);
  assert.deepEqual(s.reads, ['tickets', 'orders']);
  await s.gate.endPoll();
  await s.gate.run('a', ['tickets'], async () => 1);
  assert.deepEqual(s.reads, ['tickets', 'orders', 'tickets']);
});

test('a write during the poll is seen by the next poll', async () => {
  const s = setup();
  assert.equal(await s.pass(), 1);
  s.stamps.tickets = 'b';
  assert.equal(await s.pass(), null);
  await s.gate.endPoll();
  assert.equal(await s.pass(), 2);
});

test('endPoll says whether anything moved since the previous poll', async () => {
  const s = setup();
  assert.equal(await s.gate.endPoll(), false, 'nothing read, nothing moved');
  await s.pass();
  assert.equal(await s.gate.endPoll(), true, 'first reading counts as moved');
  await s.pass();
  assert.equal(await s.gate.endPoll(), false);
  s.stamps.tickets = 'b';
  await s.pass();
  assert.equal(await s.gate.endPoll(), true);
});

test('a stamp that cannot be read counts as moved and does not throw', async () => {
  const gate = createChangeGate({ read: async () => { throw new Error('down'); }, now: () => 0 });
  await assert.rejects(gate.run('p', ['tickets'], async () => 1));
  assert.equal(await gate.endPoll(), true);
});
