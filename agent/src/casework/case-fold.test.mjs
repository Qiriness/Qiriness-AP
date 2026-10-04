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

// --- stage 5: readings, obligations and who acts next (2026-09-27) ---------

import { applyReading, nextActorAfter } from './case-fold.mjs';

const read = (fields = {}) => ({ resolvedInputs: [], asked: [], obligationsOpened: [], obligationsCleared: [], effect: null, ...fields });

test('a reading strikes off what was answered, adds what we asked, opens and clears checks', () => {
  let state = { pending: ['shopify_order_number'], obligations: [], lastSupportAt: null };
  state = applyReading(state, read({ effect: 'new_information', resolvedInputs: ['shopify_order_number'] }), { actor: 'customer', at: '2026-09-01T10:00:00Z', messageId: 'm1' });
  assert.deepEqual(state.pending, []);
  state = applyReading(state, read({ effect: 'holding', asked: ['photo'], obligationsOpened: [{ owner: 'partner', need: 'delivery_state' }] }), { actor: 'support', at: '2026-09-02T10:00:00Z', messageId: 'm2' });
  assert.deepEqual(state.pending, ['photo']);
  assert.deepEqual(state.obligations.map((o) => [o.id, o.owner, o.status]), [['o-m2-0', 'partner', 'pending']]);
  state = applyReading(state, read({ effect: 'internal_note', obligationsCleared: ['o-m2-0'] }), { actor: 'partner', at: '2026-09-03T10:00:00Z', messageId: 'm3' });
  assert.equal(state.obligations[0].status, 'fulfilled');
  assert.equal(state.obligations[0].cleared_by, 'm3');
});

const stateAfter = (steps) => {
  let state = { pending: [], obligations: [], lastSupportAt: null };
  for (const [actor, fields, at, id] of steps) state = applyReading(state, read(fields), { actor, at, messageId: id });
  return state;
};

test('after us: asking hands it to the customer, a partner check to the partner, a close to nobody', () => {
  assert.equal(nextActorAfter(stateAfter([['support', { effect: 'asks_customer', asked: ['photo'] }, '2026-09-02', 'a']])), 'customer');
  assert.equal(nextActorAfter(stateAfter([['support', { effect: 'holding', obligationsOpened: [{ owner: 'partner', need: 'delivery_state' }] }, '2026-09-02', 'a']])), 'partner');
  assert.equal(nextActorAfter(stateAfter([['support', { effect: 'closes_case' }, '2026-09-02', 'a']])), 'nobody');
  assert.equal(nextActorAfter(stateAfter([['support', { effect: 'answers', obligationsOpened: [{ owner: 'support', need: 'refund_state' }] }, '2026-09-02', 'a']])), 'support');
});

test('a thank-you: nobody when nothing is owed, the owner of an open check otherwise', () => {
  assert.equal(nextActorAfter(stateAfter([['support', { effect: 'answers' }, '2026-09-01', 'a'], ['customer', { effect: 'closes_case' }, '2026-09-02', 'b']])), 'nobody');
  const open = stateAfter([
    ['support', { effect: 'holding', obligationsOpened: [{ owner: 'partner', need: 'delivery_state' }] }, '2026-09-01', 'a'],
    ['customer', { effect: 'closes_case' }, '2026-09-02', 'b']
  ]);
  assert.equal(nextActorAfter(open), 'partner');
});

test('a chase within the holding interval waits on the check owner; past it, we act', () => {
  const chase = (at) =>
    stateAfter([
      ['support', { effect: 'holding', obligationsOpened: [{ owner: 'partner', need: 'delivery_state' }] }, '2026-09-01T10:00:00Z', 'a'],
      ['customer', { effect: 'chase' }, at, 'b']
    ]);
  assert.equal(nextActorAfter(chase('2026-09-04T10:00:00Z'), { holdingDays: 5 }), 'partner', '3 working days');
  assert.equal(nextActorAfter(chase('2026-09-15T10:00:00Z'), { holdingDays: 5 }), 'support', '10 working days');
  assert.equal(nextActorAfter(chase('2026-09-04T10:00:00Z'), { holdingDays: null }), 'support', 'no interval set');
});

test('a partner who settles a check hands it back to us; one who does not keeps it', () => {
  const opened = ['support', { effect: 'internal_request', obligationsOpened: [{ owner: 'partner', need: 'delivery_state' }] }, '2026-09-01', 'a'];
  assert.equal(nextActorAfter(stateAfter([opened, ['partner', { effect: 'internal_note', obligationsCleared: ['o-a-0'] }, '2026-09-02', 'b']])), 'support');
  assert.equal(nextActorAfter(stateAfter([opened, ['partner', { effect: 'internal_note' }, '2026-09-02', 'b']])), 'partner');
});

test('the whole fold walks stored stage 5 readings, and ignores rows without an effect', () => {
  const messages = [
    { id: 'a', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T10:00:00Z' },
    { id: 'b', direction: 'outbound', actor: 'support', received_at: '2026-09-02T10:00:00Z' }
  ];
  const stored = [{ trigger_message_id: 'b', effect: 'holding', resolved_inputs: [], asked: [], obligations_opened: [{ owner: 'partner', need: 'delivery_state' }], obligations_cleared: [] }];
  const state = foldCase({ messages, readings: stored });
  assert.equal(state.next_actor, 'partner');
  assert.deepEqual(state.obligations.map((o) => o.owner), ['partner']);
  const old = foldCase({ messages, readings: [{ trigger_message_id: 'b', pending_customer_inputs: [] }] });
  assert.equal(old.next_actor, 'nobody', 'a pre-stage-5 reading folds as stage 4 did');
});

test('an unread reply of ours still leaves an open check with its owner (2aa6604e)', () => {
  const messages = [
    { id: 'a', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T10:00:00Z' },
    { id: 'b', direction: 'outbound', actor: 'support', received_at: '2026-09-02T10:00:00Z' }
  ];
  const readings = [{ trigger_message_id: 'a', effect: 'new_information', resolved_inputs: [], asked: [], obligations_opened: [{ owner: 'support', need: 'product_property' }], obligations_cleared: [] }];
  assert.equal(foldCase({ messages, readings }).next_actor, 'support');
});

// --- stage 5d: a person settles a check from the dashboard (2026-09-27) ----

import { applyActions, obligationAges } from './case-fold.mjs';

test('a check marked done in the dashboard stops being owed, and who acts next follows', () => {
  const messages = [
    { id: 'a', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T10:00:00Z' },
    { id: 'b', direction: 'outbound', actor: 'support', received_at: '2026-09-02T10:00:00Z' }
  ];
  const readings = [{ trigger_message_id: 'b', effect: 'holding', resolved_inputs: [], asked: [], obligations_opened: [{ owner: 'partner', need: 'delivery_state' }], obligations_cleared: [] }];
  assert.equal(foldCase({ messages, readings }).next_actor, 'partner');
  const done = foldCase({ messages, readings, actions: [{ obligation_id: 'o-b-0', action: 'fulfilled', acted_by: 'u1', acted_at: '2026-09-03T10:00:00Z' }] });
  assert.equal(done.obligations[0].status, 'fulfilled');
  assert.deepEqual(done.obligations[0].cleared_by, { kind: 'manual', by: 'u1', at: '2026-09-03T10:00:00Z' });
  assert.equal(done.next_actor, 'nobody');
});

test('the latest action wins, and a settled check does not move again', () => {
  const pending = [{ id: 'x', owner: 'partner', status: 'pending' }, { id: 'y', owner: 'support', status: 'fulfilled' }];
  const moved = applyActions(pending, [
    { obligation_id: 'x', action: 'fulfilled', acted_at: '2026-09-02' },
    { obligation_id: 'x', action: 'cancelled', acted_at: '2026-09-03' },
    { obligation_id: 'y', action: 'cancelled', acted_at: '2026-09-03' }
  ]);
  assert.deepEqual(moved.map((o) => o.status), ['cancelled', 'fulfilled']);
});

test('overdue is counted in working days per owner, and only on pending checks', () => {
  const ages = obligationAges(
    [
      { id: 'p', owner: 'partner', status: 'pending', opened_at: '2026-09-21T10:00:00Z' },
      { id: 'c', owner: 'colleague', status: 'pending', opened_at: '2026-09-24T10:00:00Z' },
      { id: 's', owner: 'support', status: 'pending', opened_at: '2026-09-01T10:00:00Z' },
      { id: 'd', owner: 'partner', status: 'fulfilled', opened_at: '2026-09-01T10:00:00Z' }
    ],
    { now: new Date('2026-09-25T12:00:00Z'), delays: { partner: 3, colleague: 2 } }
  );
  assert.deepEqual(ages.map((o) => [o.id, o.workingDaysOpen, o.overdue]), [['p', 4, true], ['c', 1, false], ['s', 18, false], ['d', null, false]]);
});

test('a person’s correction raises the version; no correction leaves every hash as it was', () => {
  const messages = [{ id: 'm1', direction: 'inbound', actor: 'customer', received_at: '2026-09-29T08:00:00Z' }];
  const plain = foldCase({ messages });
  assert.equal(foldCase({ messages, overrides: {} }).material_hash, plain.material_hash);
  // Workflow fields do not move the case.
  assert.equal(foldCase({ messages, overrides: { priority: { value: 'high' }, responsible_team: { value: 'logistics' } } }).material_hash, plain.material_hash);
  const corrected = foldCase({ messages, overrides: { situation: { value: 'D-05' } } });
  assert.notEqual(corrected.material_hash, plain.material_hash);
  assert.equal(nextVersion({ version: 4, material_hash: plain.material_hash }, corrected), 5);
});

test('a fact drift raises the version once; re-finding it, or none at all, moves nothing', () => {
  const messages = [{ id: 'm1', direction: 'inbound', actor: 'customer', received_at: '2026-09-29T08:00:00Z' }];
  const plain = foldCase({ messages });
  assert.equal(foldCase({ messages, factDrift: null }).material_hash, plain.material_hash);
  assert.equal(foldCase({ messages, factDrift: { changed: {} } }).material_hash, plain.material_hash);
  const drift = {
    changed: { order_state: { from: 'not_dispatched', to: 'dispatched' } },
    outcome: 'redraft',
    case_file_at: '2026-09-28T15:17:59Z',
    checked_at: '2026-10-04T10:00:00Z'
  };
  const drifted = foldCase({ messages, factDrift: drift });
  assert.notEqual(drifted.material_hash, plain.material_hash);
  assert.equal(nextVersion({ version: 6, material_hash: plain.material_hash }, drifted), 7);
  // Only the check time moved: the same version.
  const again = foldCase({ messages, factDrift: { ...drift, checked_at: '2026-10-04T10:05:00Z' } });
  assert.equal(again.material_hash, drifted.material_hash);
});
