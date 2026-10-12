import assert from 'node:assert/strict';
import test from 'node:test';

import { T } from '../../scripts/lib/tables.mjs';
import { ALL, codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('93_drop_superseded_views'));
const DROPPED = [...CODE.matchAll(/drop view if exists public\.(\w+);/g)].map((m) => m[1]);

test('93 drops sixteen views, each idempotently, and nothing else', () => {
  assert.equal(DROPPED.length, 16);
  assert.equal(new Set(DROPPED).size, 16);
  assert.doesNotMatch(CODE.replace(/drop view if exists public\.\w+;/g, ''), /\S/);
});

test('the baseline no longer creates them, and tables.mjs no longer names them', () => {
  const baseline = codeOnly(ALL);
  const named = new Set(Object.values(T));
  for (const view of DROPPED) {
    assert.doesNotMatch(baseline, new RegExp(`create view public\\.${view}\\b`), view);
    assert.equal(named.has(view), false, view);
  }
});

test('nothing left in the baseline reads a dropped view', () => {
  // Function comments may still NAME one (they describe history); code may not read one.
  const baseline = codeOnly(ALL);
  for (const view of DROPPED) {
    assert.doesNotMatch(baseline, new RegExp(`\\b(from|join)\\s+public\\.${view}\\b`), view);
  }
});

test('the views the ranged functions build on are kept', () => {
  for (const kept of ['order_fulfilment_timing', 'ticket_reply_times', 'support_by_month']) {
    assert.equal(DROPPED.includes(kept), false);
    assert.match(codeOnly(ALL), new RegExp(`create view public\\.${kept}\\b`));
  }
});
