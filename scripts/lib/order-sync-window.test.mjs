import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_SYNC_DEFAULT_MONTHS,
  orderSyncQuery
} from './shopify-admin-client.mjs';
import { parseArgs } from './sync-config.mjs';

const NOW = new Date('2026-08-08T12:00:00.000Z');

test('the default window covers the longest retention rule, with margin', () => {
  // Retention keeps an unresolved order 6 months; anything shorter than that
  // would skip orders the database is meant to hold.
  assert.ok(ORDER_SYNC_DEFAULT_MONTHS >= 6);
  assert.equal(orderSyncQuery(undefined, NOW), 'updated_at:>=2026-01-08');
});

test('the filter is on updated_at, not created_at', () => {
  // Load-bearing: an order placed two years ago whose return opened last month
  // is retained six months FROM THE RETURN. A created_at window would miss
  // exactly the unresolved cases support gets emails about.
  const q = orderSyncQuery(7, NOW);
  assert.match(q, /^updated_at:>=/);
  assert.doesNotMatch(q, /created_at/);
});

test('a custom window is honoured', () => {
  assert.equal(orderSyncQuery(1, NOW), 'updated_at:>=2026-07-08');
  assert.equal(orderSyncQuery(12, NOW), 'updated_at:>=2025-08-08');
});

test('null months means no filter at all', () => {
  // The deliberate full backfill. `undefined` must NOT mean this — that is the
  // default path, and defaulting to unbounded is the behaviour being fixed.
  assert.equal(orderSyncQuery(null, NOW), undefined);
  assert.notEqual(orderSyncQuery(undefined, NOW), undefined);
});

test('--since-months and --all-orders parse', () => {
  assert.equal(parseArgs([]).orderSinceMonths, undefined);
  assert.equal(parseArgs(['--since-months=3']).orderSinceMonths, 3);
  assert.equal(parseArgs(['--since-months', '3']).orderSinceMonths, 3);
  assert.equal(parseArgs(['--all-orders']).orderSinceMonths, null);
});

test('a nonsense window is rejected rather than silently ignored', () => {
  assert.throws(() => parseArgs(['--since-months=0']), /positive integer/);
  assert.throws(() => parseArgs(['--since-months=-2']), /positive integer/);
  assert.throws(() => parseArgs(['--since-months=abc']), /positive integer/);
});

test('the window rolls with the clock', () => {
  // Not a fixed date baked in at first run: a sync in six months must still
  // fetch the last seven months, not the same window it used today.
  const later = new Date('2027-03-01T00:00:00.000Z');
  assert.equal(orderSyncQuery(7, later), 'updated_at:>=2026-08-01');
});

test('the window does not depend on the timezone of whatever runs the sync', () => {
  // setMonth/getMonth are local-time while toISOString is UTC; mixing them
  // shifted the window by a day on a UTC+2 machine. A scheduler in UTC and a
  // laptop in Paris must produce the same filter.
  const tz = process.env.TZ;
  const results = new Set();
  for (const zone of ['UTC', 'Europe/Paris', 'America/Los_Angeles', 'Pacific/Auckland']) {
    process.env.TZ = zone;
    results.add(orderSyncQuery(7, new Date('2027-03-01T00:00:00.000Z')));
  }
  process.env.TZ = tz;
  assert.equal(results.size, 1, `window differed by timezone: ${[...results].join(' vs ')}`);
});
