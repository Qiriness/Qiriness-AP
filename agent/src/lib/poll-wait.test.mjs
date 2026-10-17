import assert from 'node:assert/strict';
import test from 'node:test';

import { nextPollWait } from './poll-wait.mjs';

const base = { baseMs: 60_000, maxMs: 600_000 };

test('idle polls double the wait up to the cap', () => {
  const waits = [];
  let previousMs = 60_000;
  for (let i = 0; i < 6; i++) waits.push(previousMs = nextPollWait({ ...base, active: false, previousMs }));
  assert.deepEqual(waits, [120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
});

test('anything moving brings it straight back to the base', () => {
  assert.equal(nextPollWait({ ...base, active: true, previousMs: 600_000 }), 60_000);
});

test('a cap below the base never shortens the base', () => {
  assert.equal(nextPollWait({ baseMs: 60_000, maxMs: 30_000, active: false, previousMs: 60_000 }), 60_000);
});

test('no previous wait starts at the base', () => {
  assert.equal(nextPollWait({ ...base, active: false, previousMs: undefined }), 60_000);
});
