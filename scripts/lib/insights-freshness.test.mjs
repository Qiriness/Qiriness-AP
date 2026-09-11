import assert from 'node:assert/strict';
import test from 'node:test';

import { describeFreshness, formatAgo } from './insights-freshness.mjs';

const NOW = new Date('2026-09-11T14:00:00Z');

// The live row on the day this was written: orders fresh, mail three weeks old,
// the first scheduled sync still running.
const ROW = {
  orders_synced_at: '2026-09-11T11:42:52Z',
  mail_synced_through: '2026-08-20T15:07:27Z',
  topic_map_built_at: '2026-08-16T12:55:30Z',
  nightly_sync_status: 'processing',
  nightly_sync_started_at: '2026-09-11T11:51:09Z',
  nightly_sync_finished_at: null
};

const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

test('a mailbox nobody has read for three weeks is a warning, not a quiet chart', () => {
  const items = byId(describeFreshness(ROW, NOW));
  assert.equal(items.mail.tone, 'warn');
  assert.equal(items.mail.text, 'last message 22 days ago');
  assert.equal(items.orders.tone, 'ok');
});

test('a sync still running is information; one that never finished is an error', () => {
  assert.equal(byId(describeFreshness(ROW, NOW)).sync.tone, 'info');
  const later = new Date('2026-09-12T03:00:00Z');
  const stuck = byId(describeFreshness(ROW, later)).sync;
  assert.equal(stuck.tone, 'error');
  assert.match(stuck.text, /never finished/);
});

test('a missed night makes the orders stale', () => {
  const twoDays = new Date('2026-09-13T00:00:00Z');
  assert.equal(byId(describeFreshness(ROW, twoDays)).orders.tone, 'warn');
});

test('no row, no strip', () => {
  assert.deepEqual(describeFreshness(null, NOW), []);
});

test('ages read the way a person says them', () => {
  assert.equal(formatAgo('2026-09-11T13:59:30Z', NOW), 'just now');
  assert.equal(formatAgo('2026-09-11T13:20:00Z', NOW), '40 min ago');
  assert.equal(formatAgo('2026-09-11T09:00:00Z', NOW), '5 h ago');
  assert.equal(formatAgo(null, NOW), 'never');
});
