import assert from 'node:assert/strict';
import test from 'node:test';

import { relabelPatch } from './relabel-subject.mjs';

const target = 'defective_product';
const at = '2026-11-06T12:00:00.000Z';

const ticket = (over = {}) => ({
  category: 'product',
  request_kind: 'problem',
  secondary_category: null,
  secondary_request_kind: null,
  level: 3,
  happiness: 3,
  responsible_team: 'contact',
  metadata: { categorisation: { at: '2026-10-20T08:00:00.000Z', history: [] } },
  overrides: {},
  ...over
});

const reading = (over = {}) => ({
  category: target,
  request_kind: 'problem',
  secondary_category: null,
  secondary_request_kind: null,
  level: 3,
  model: 'm',
  reason: 'pompe hors service',
  ...over
});

test('a product ticket the categoriser now reads as a defect moves, with its history kept', () => {
  const patch = relabelPatch(ticket(), reading(), { target, at, by: 'test' });
  assert.equal(patch.change, 'primary');
  assert.deepEqual(patch.columns, {
    category: target,
    request_kind: 'problem',
    secondary_category: null,
    secondary_request_kind: null,
    level: 3,
    responsible_team: 'contact'
  });
  assert.deepEqual(patch.trail.history[0], {
    category: 'product',
    request_kind: 'problem',
    level: 3,
    happiness: 3,
    at: '2026-10-20T08:00:00.000Z'
  });
  assert.equal(patch.trail.relabelled.to, target);
});

test('a reading that is not the target changes nothing — no unrelated drift is written', () => {
  assert.equal(relabelPatch(ticket(), reading({ category: 'product', request_kind: 'question' }), { target }), null);
  assert.equal(relabelPatch(ticket(), reading({ category: 'delivery' }), { target }), null);
});

test('a former product question becomes a level-3 problem; the level never falls', () => {
  const patch = relabelPatch(ticket({ request_kind: 'question', level: 1 }), reading({ level: 1 }), { target });
  assert.equal(patch.columns.level, 3);
  const high = relabelPatch(ticket({ level: 4 }), reading({ level: 3 }), { target });
  assert.equal(high.columns.level, 4);
});

test('a person\'s subject stays, and a person\'s level is not ratcheted over', () => {
  assert.equal(
    relabelPatch(ticket({ overrides: { category: { value: 'product', ai_value: 'product' } } }), reading(), { target }),
    null
  );
  const patch = relabelPatch(ticket({ level: 2, overrides: { level: { value: 2, ai_value: 3 } } }), reading(), { target });
  assert.ok(!('level' in patch.columns));
});

test('a defect that was the second request moves only the secondary pair', () => {
  const patch = relabelPatch(
    ticket({ category: 'order', request_kind: 'problem', secondary_category: 'product', secondary_request_kind: 'question', level: 2 }),
    reading({ category: 'order', secondary_category: target, secondary_request_kind: 'problem' }),
    { target }
  );
  assert.equal(patch.change, 'secondary');
  assert.deepEqual(patch.columns, { secondary_category: target, secondary_request_kind: 'problem', level: 3 });
});

test('a ticket already on the target is left alone, and a secondary twin is dropped', () => {
  assert.equal(relabelPatch(ticket({ category: target }), reading(), { target }), null);
  assert.equal(relabelPatch(ticket({ secondary_category: target }), reading(), { target }), null);
  const kept = relabelPatch(
    ticket({ secondary_category: 'product_stock', secondary_request_kind: 'question' }),
    reading(),
    { target }
  );
  assert.equal(kept.columns.secondary_category, 'product_stock');
});

test('history is capped at five, newest first', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ category: `c${i}` }));
  const patch = relabelPatch(ticket({ metadata: { categorisation: { history } } }), reading(), { target });
  assert.equal(patch.trail.history.length, 5);
  assert.equal(patch.trail.history[0].category, 'product');
});
