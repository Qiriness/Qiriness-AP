import assert from 'node:assert/strict';
import test from 'node:test';

import { foldCase, materialHash, nextActorFor, nextVersion, orderedThread } from './case-fold.mjs';

const msg = (id, actor, at, direction = actor === 'support' ? 'outbound' : 'inbound') => ({
  id, actor, direction, received_at: `2026-09-${String(at).padStart(2, '0')}T10:00:00Z`
});

test('the thread is folded in date order, whatever order it was stored in', () => {
  const thread = orderedThread([msg('b', 'support', 2), msg('a', 'customer', 1), msg('c', 'customer', 3)]);
  assert.deepEqual(thread.map((m) => m.id), ['a', 'b', 'c']);
  const late = foldCase({ messages: [msg('c', 'customer', 3), msg('a', 'customer', 1), msg('b', 'support', 2)] });
  assert.equal(late.as_of_message_id, 'c');
  assert.equal(late.last_actor, 'customer');
});

test('whoever other than us spoke last, we act next', () => {
  for (const actor of ['customer', 'colleague', 'partner']) {
    assert.equal(foldCase({ messages: [msg('a', 'customer', 1), msg('b', actor, 2)] }).next_actor, 'support', actor);
  }
});

test('a question counts as pending once we have asked it, not when the case file decided to', () => {
  const caseFile = { trigger_message_id: 'a', verdict: 'needs_customer_input', missing: [{ field: 'shopify_order_number' }] };
  const before = foldCase({ messages: [msg('a', 'customer', 1)], caseFiles: [caseFile] });
  assert.deepEqual(before.pending_customer_inputs, []);
  assert.equal(before.next_actor, 'support');

  const asked = foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2)], caseFiles: [caseFile] });
  assert.deepEqual(asked.pending_customer_inputs, ['shopify_order_number']);
  assert.equal(asked.next_actor, 'customer');
});

test('a newer reading wins over an older case file, having struck off what was answered', () => {
  const caseFile = { trigger_message_id: 'a', verdict: 'needs_customer_input', missing: [{ field: 'shopify_order_number' }, { field: 'photo' }] };
  const reading = { trigger_message_id: 'c', pending_customer_inputs: ['photo'], commitments: [{ what: 'rappel' }], contradictions: [] };
  const state = foldCase({
    messages: [msg('a', 'customer', 1), msg('b', 'support', 2), msg('c', 'customer', 3), msg('d', 'support', 4)],
    caseFiles: [caseFile],
    readings: [reading]
  });
  assert.deepEqual(state.pending_customer_inputs, ['photo']);
  assert.deepEqual(state.commitments, [{ what: 'rappel' }]);
  assert.equal(state.next_actor, 'customer');
});

test('after our reply with nothing asked, nobody owes anything, even on a needs_human case file', () => {
  // Measured: keeping « support » for a needs_human case file cost 5 cuts of 132,
  // because the verdict was usually older than the reply that settled it.
  const human = { trigger_message_id: 'a', verdict: 'needs_human', missing: [] };
  assert.equal(foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2)], caseFiles: [human] }).next_actor, 'nobody');
  const done = foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2)], caseFiles: [{ ...human, verdict: 'answerable' }] });
  assert.equal(done.next_actor, 'nobody');
  assert.equal(done.resolved, true);
});

test('rows about messages outside the thread are ignored', () => {
  const stray = { trigger_message_id: 'zz', verdict: 'needs_customer_input', missing: [{ field: 'photo' }] };
  assert.deepEqual(foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2)], caseFiles: [stray] }).pending_customer_inputs, []);
});

test('an empty thread has no next actor', () => {
  assert.equal(nextActorFor({ lastActor: null }), null);
  assert.equal(foldCase({ messages: [] }).next_actor, null);
});

test('the version moves only when something material changes', () => {
  const a = foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2)] });
  const b = foldCase({ messages: [msg('a', 'customer', 1), msg('b2', 'support', 5)] });
  assert.equal(a.material_hash, b.material_hash, 'a later message that changes nothing keeps the hash');
  assert.equal(nextVersion({ version: 3, material_hash: a.material_hash }, b), 3);
  const c = foldCase({ messages: [msg('a', 'customer', 1), msg('b', 'support', 2), msg('c', 'customer', 3)] });
  assert.notEqual(c.material_hash, a.material_hash);
  assert.equal(nextVersion({ version: 3, material_hash: a.material_hash }, c), 4);
  assert.equal(nextVersion(null, c), 1);
  assert.equal(materialHash({ pending_customer_inputs: ['b', 'a'] }), materialHash({ pending_customer_inputs: ['a', 'b'] }));
});

test('without a stored actor, direction alone decides', () => {
  const state = foldCase({ messages: [{ id: 'a', direction: 'inbound', received_at: '2026-09-01' }, { id: 'b', direction: 'outbound', received_at: '2026-09-02' }] });
  assert.equal(state.last_actor, 'support');
});
