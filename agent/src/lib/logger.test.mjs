import assert from 'node:assert/strict';
import test from 'node:test';

import { logger } from './logger.mjs';

/** Captures the JSON lines the logger writes, without touching the real stream. */
function capture(run) {
  const lines = [];
  const streams = { info: 'stdout', warn: 'stdout', error: 'stderr' };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = (text) => (lines.push(text), true);
  process.stderr.write = (text) => (lines.push(text), true);
  try {
    run();
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
  void streams;
  return lines.map((line) => JSON.parse(line));
}

test('emits one JSON line per event with severity, message and timestamp', () => {
  const [line] = capture(() => logger.info('ingest.poll', { shopId: 's1', tickets: 3 }));
  assert.equal(line.level, 'info');
  assert.equal(line.message, 'ingest.poll');
  assert.equal(line.shopId, 's1');
  assert.equal(line.tickets, 3);
  assert.ok(Date.parse(line.ts), 'ts should be an ISO timestamp');
});

test('a caller field named `level` cannot overwrite the log severity', () => {
  // The bug this guards: the categoriser logged a ticket's handling level as
  // `level`, which silently replaced "info" with 2 — so the line stopped
  // matching any severity filter, and nothing failed to say so.
  const [line] = capture(() => logger.info('categorise.ticket', { level: 2, ticketId: 't1' }));
  assert.equal(line.level, 'info');
  assert.equal(line.ticketId, 't1');
});

test('`message` and `ts` are reserved too', () => {
  const [line] = capture(() =>
    logger.warn('categorise.error', { message: 'boom', ts: 'not-a-time', ticketId: 't1' })
  );
  assert.equal(line.level, 'warn');
  assert.equal(line.message, 'categorise.error');
  assert.ok(Date.parse(line.ts));
  assert.equal(line.ticketId, 't1');
});

test('errors go to stderr, everything else to stdout', () => {
  let stdout = 0;
  let stderr = 0;
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = () => (stdout += 1, true);
  process.stderr.write = () => (stderr += 1, true);
  try {
    logger.info('a', {});
    logger.warn('b', {});
    logger.error('c', {});
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
  assert.equal(stdout, 2);
  assert.equal(stderr, 1);
});
