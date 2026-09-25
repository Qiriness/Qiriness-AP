import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES } from '../src/investigation/investigation-rules.mjs';
import { needsSatisfiedBy } from '../src/investigation/evidence-rules.mjs';

import { ranWithDelta, scoreDeltaRun } from './score-delta.mjs';

// Any tool that settles `order_identity` and `delivery_state`, taken from the
// vocabulary rather than named here, so a remapped tool cannot silently make
// this test vacuous.
const ORDER_TOOL = Object.values(TOOL_NAMES).find(
  (tool) => needsSatisfiedBy(tool).includes('order_identity') && needsSatisfiedBy(tool).includes('delivery_state')
);

test('the fixture tool settles both needs', () => {
  assert.ok(ORDER_TOOL);
});

test('a model call on an established need is a re-fetch; an opening move is not', () => {
  const delta = { established: [{ need: 'order_identity' }], toRefresh: [] };
  assert.deepEqual(scoreDeltaRun({ delta, toolCalls: [{ tool: ORDER_TOOL, source: 'opening_move' }] }).refetchedEstablished, []);
  assert.deepEqual(scoreDeltaRun({ delta, toolCalls: [{ tool: ORDER_TOOL, source: 'model' }] }).refetchedEstablished, ['order_identity']);
});

test('a stale need looked at by any source is refreshed; one nobody looked at is missed', () => {
  const delta = { established: [], toRefresh: [{ need: 'delivery_state' }] };
  assert.deepEqual(scoreDeltaRun({ delta, toolCalls: [{ tool: ORDER_TOOL, source: 'opening_move' }] }).staleRefreshed, ['delivery_state']);
  assert.deepEqual(scoreDeltaRun({ delta, toolCalls: [] }).staleMissed, ['delivery_state']);
});

test('calls are counted by who asked for them, and rows from before the source was stored say unknown', () => {
  const scored = scoreDeltaRun({ delta: null, toolCalls: [{ tool: ORDER_TOOL, source: 'model' }, { tool: ORDER_TOOL }] });
  assert.deepEqual(scored.bySource, { model: 1, unknown: 1 });
});

test('a run had a delta only if the reading is about its trigger and came first', () => {
  const investigation = { trigger_message_id: 'm2', investigated_at: '2026-09-25T10:00:00Z' };
  assert.equal(ranWithDelta({ investigation, reading: { trigger_message_id: 'm2', read_at: '2026-09-25T09:59:00Z' } }), true);
  assert.equal(ranWithDelta({ investigation, reading: { trigger_message_id: 'm2', read_at: '2026-09-25T10:01:00Z' } }), false);
  assert.equal(ranWithDelta({ investigation, reading: { trigger_message_id: 'm1', read_at: '2026-09-25T09:00:00Z' } }), false);
});
