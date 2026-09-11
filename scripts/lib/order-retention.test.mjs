import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RETENTION_POLICY,
  FALLBACK_RETENTION_MONTHS,
  SYNC_WINDOW_MARGIN_MONTHS,
  describeRetentionPolicy,
  isIndefinite,
  orderSyncMonths,
  readRetentionPolicy,
  retentionDeleteAfter
} from './order-retention.mjs';

const ANCHOR = '2026-03-15T10:00:00.000Z';

// --- reading the setting -----------------------------------------------------

test('a months setting is read as written', () => {
  const policy = readRetentionPolicy({
    order_retention_mode: 'months',
    order_retention_months: 12
  });
  assert.equal(policy.mode, 'months');
  assert.equal(policy.months, 12);
});

test('indefinite is read as indefinite', () => {
  const policy = readRetentionPolicy({
    order_retention_mode: 'indefinite',
    order_retention_months: null
  });
  assert.equal(policy.mode, 'indefinite');
  assert.ok(isIndefinite(policy));
});

test('a shop row from before the setting existed reads as the default', () => {
  // The sync must not stop because a column is new.
  assert.deepEqual({ ...readRetentionPolicy({}) }, { ...DEFAULT_RETENTION_POLICY });
});

// --- failing safe, which is the whole point ---------------------------------

test('an unreadable setting falls back to a period, never to indefinite', () => {
  // THE ONE BEHAVIOUR THIS MODULE EXISTS TO GUARANTEE. A support parameter that
  // cannot be read makes a reply decline to quote a number. A retention setting
  // that cannot be read must not silently become permanent retention of personal
  // data -- nobody would notice, and everybody would have to answer for it.
  for (const row of [
    { order_retention_mode: 'forever' },
    { order_retention_mode: 'months', order_retention_months: 0 },
    { order_retention_mode: 'months', order_retention_months: -3 },
    { order_retention_mode: 'months', order_retention_months: 'twelve' },
    { order_retention_mode: 'months', order_retention_months: 1.5 },
    { order_retention_mode: 'months', order_retention_months: null }
  ]) {
    const policy = readRetentionPolicy(row);
    assert.equal(policy.mode, 'months', `${JSON.stringify(row)} must not read as indefinite`);
    assert.equal(policy.months, FALLBACK_RETENTION_MONTHS);
  }
});

test('the fallback is what the code did before the switch existed', () => {
  // So an unreadable setting behaves like the version that had no setting.
  assert.equal(FALLBACK_RETENTION_MONTHS, 6);
});

// --- the delete date ---------------------------------------------------------

test('a period adds months to the anchor in UTC', () => {
  const at = retentionDeleteAfter(ANCHOR, { mode: 'months', months: 12 });
  assert.equal(at, '2027-03-15T10:00:00.000Z');
});

test('indefinite produces null, which is what the purge never matches', () => {
  assert.equal(retentionDeleteAfter(ANCHOR, { mode: 'indefinite', months: null }), null);
});

test('a missing anchor produces null rather than an invalid date', () => {
  assert.equal(retentionDeleteAfter(null, { mode: 'months', months: 6 }), null);
  assert.equal(retentionDeleteAfter('not a date', { mode: 'months', months: 6 }), null);
});

// --- the fetch window, derived rather than set beside it ---------------------

test('the sync window is retention plus a margin', () => {
  assert.equal(orderSyncMonths({ mode: 'months', months: 12 }), 12 + SYNC_WINDOW_MARGIN_MONTHS);
  assert.equal(orderSyncMonths({ mode: 'months', months: 24 }), 24 + SYNC_WINDOW_MARGIN_MONTHS);
});

test('indefinite retention fetches with no date bound at all', () => {
  // Otherwise "keep for ever" would still only ever hold the default window,
  // because nothing older is ever asked for.
  assert.equal(orderSyncMonths({ mode: 'indefinite', months: null }), null);
});

test('the window is always longer than retention', () => {
  // A fetch window shorter than retention is a table that can never fill: the
  // setting would look broken rather than misconfigured.
  for (const months of [1, 6, 12, 24, 60]) {
    assert.ok(orderSyncMonths({ mode: 'months', months }) > months);
  }
});

// --- callers cannot pass the wrong object ------------------------------------

test('a raw shops row works anywhere a policy does', () => {
  const row = { order_retention_mode: 'indefinite', order_retention_months: null };
  assert.equal(retentionDeleteAfter(ANCHOR, row), null);
  assert.equal(orderSyncMonths(row), null);
  assert.ok(isIndefinite(row));
});

test('the log line states the policy the run is under', () => {
  assert.match(describeRetentionPolicy({ mode: 'indefinite', months: null }), /indefinitely/);
  assert.match(describeRetentionPolicy({ mode: 'months', months: 12 }), /12 months/);
});
