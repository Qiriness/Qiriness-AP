import assert from 'node:assert/strict';
import test from 'node:test';

import { createChangeGate } from './change-gate.mjs';

function setup() {
  const stamps = { tickets: 'a', orders: 'x' };
  let at = 0;
  const gate = createChangeGate({ read: async (table) => stamps[table], now: () => at, everyMs: 1000 });
  let runs = 0;
  const pass = () => gate.run('p', ['tickets', 'orders'], async () => ++runs);
  return { stamps, pass, advance: (ms) => { at += ms; }, runs: () => runs };
}

test('the first call runs, an unchanged second one does not', async () => {
  const s = setup();
  assert.equal(await s.pass(), 1);
  assert.equal(await s.pass(), null);
  assert.equal(s.runs(), 1);
});

test('a write to any named table runs it again', async () => {
  const s = setup();
  await s.pass();
  s.stamps.orders = 'y';
  assert.equal(await s.pass(), 2);
  assert.equal(await s.pass(), null);
});

test('time alone runs it again, for windows that elapse', async () => {
  const s = setup();
  await s.pass();
  s.advance(1000);
  assert.equal(await s.pass(), 2);
});

test('a pass that throws is not marked, so the next poll retries it', async () => {
  let calls = 0;
  const gate = createChangeGate({ read: async () => 'same', now: () => 0 });
  const failing = () => gate.run('p', ['tickets'], async () => { calls += 1; throw new Error('down'); });
  await assert.rejects(failing());
  await assert.rejects(failing());
  assert.equal(calls, 2);
});
