import assert from 'node:assert/strict';
import test from 'node:test';

import { CASE_RELATIONSHIPS } from '../../../scripts/lib/case-state-record.mjs';

import {
  REUSE_STATES,
  evidenceReuseFrom,
  orderChangedSince,
  pendingAfter,
  reuseState,
  shouldRecategorise,
  situationFor,
  situationPlan
} from './case-manager-rules.mjs';

// --- whether the categoriser re-runs ------------------------------------------

test('only a continuation keeps the labels; the other three re-read them', () => {
  // Re-categorisation is deliberate and measured, and it maintains
  // `secondary_category` — the axis that opens a second rulebook on 21% of
  // investigable tickets. Suppressing it anywhere but the safest case would
  // trade a real signal for the cheapest call in the poll.
  assert.equal(shouldRecategorise('continuation'), false);
  for (const relationship of ['new_information', 'new_issue', 'unclear']) {
    assert.equal(shouldRecategorise(relationship), true, relationship);
  }
});

test('an unknown relationship re-categorises, because that is the old behaviour', () => {
  assert.equal(shouldRecategorise('something_else'), true);
  assert.equal(shouldRecategorise(undefined), true);
});

// --- which situation the case is in -------------------------------------------

test('a situation is carried forward rather than re-matched', () => {
  // Closes the question DECISIONS left open. The matcher reads the OPENING
  // message, so re-matching on a follow-up re-derives the same answer and pays
  // an embedding for it.
  assert.equal(situationFor({ caseRelationship: 'continuation', previousSituationKey: 'D-36' }), 'D-36');
  assert.equal(situationFor({ caseRelationship: 'new_information', previousSituationKey: 'D-36' }), 'D-36');
  assert.equal(situationFor({ caseRelationship: 'unclear', previousSituationKey: 'D-36' }), 'D-36');
});

test('a second request in the thread drops it, so the classifier can do its job', () => {
  assert.equal(situationFor({ caseRelationship: 'new_issue', previousSituationKey: 'D-36' }), null);
});

test('with nothing carried, nothing is invented', () => {
  assert.equal(situationFor({ caseRelationship: 'continuation' }), null);
  assert.equal(situationFor({}), null);
});

// --- what is still outstanding ------------------------------------------------

test('an answered question is struck off and the rest are carried', () => {
  assert.deepEqual(
    pendingAfter({
      previousPending: ['shopify_order_number', 'photo'],
      resolvedInputs: ['shopify_order_number']
    }),
    ['photo']
  );
});

test('a key nothing recognises is dropped from both sides', () => {
  // The model may not mint questions: a key downstream does not know would
  // silently fail to suppress anything, and one struck off that nobody asked
  // would suppress a question for ever.
  assert.deepEqual(
    pendingAfter({ previousPending: ['photo', 'invented_key'], resolvedInputs: ['also_invented'] }),
    ['photo']
  );
});

test('a newly named question joins the list, unless this message answered it', () => {
  assert.deepEqual(
    pendingAfter({ previousPending: [], resolvedInputs: [], newlyMissing: [{ field: 'photo' }] }),
    ['photo']
  );
  assert.deepEqual(
    pendingAfter({ previousPending: [], resolvedInputs: ['photo'], newlyMissing: ['photo'] }),
    []
  );
});

test('the same question twice is listed once', () => {
  assert.deepEqual(
    pendingAfter({ previousPending: ['photo'], newlyMissing: ['photo'] }),
    ['photo']
  );
});

// --- whether a prior answer may stand -----------------------------------------

test('a changed argument hash invalidates the answer derived from it', () => {
  // The customer corrects an order number: everything derived from the old one
  // is about a different order. A comparison, not an inference.
  assert.equal(
    reuseState({ entry: { tool: 'getOrderContext', argsHash: 'a', need: 'order_state' }, currentArgsHash: 'b' }),
    'invalidated'
  );
});

test('a different order invalidates every order-derived need', () => {
  for (const need of ['order_state', 'delivery_state', 'refund_state', 'return_eligibility']) {
    assert.equal(
      reuseState({ entry: { tool: 'getOrderContext', need }, orderChanged: true }),
      'invalidated',
      need
    );
  }
  // And leaves alone what the order has nothing to do with.
  assert.equal(reuseState({ entry: { tool: 'searchKnowledge', need: 'policy_answer' }, orderChanged: true }), 'valid');
});

test('a fact that moves on its own is stale; one that does not is valid', () => {
  assert.equal(reuseState({ entry: { tool: 'getOrderContext', need: 'delivery_state' } }), 'stale');
  assert.equal(reuseState({ entry: { tool: 'checkPhotoEvidence', need: 'photo_evidence' } }), 'valid');
});

test('nothing to reuse reads as missing, never as valid', () => {
  assert.equal(reuseState({}), 'missing');
  assert.equal(reuseState({ entry: null }), 'missing');
  assert.equal(reuseState({ entry: { need: 'order_state' } }), 'missing');
});

test('every state it can return is one it declares', () => {
  const produced = [
    reuseState({}),
    reuseState({ entry: { tool: 't', need: 'delivery_state' } }),
    reuseState({ entry: { tool: 't', need: 'photo_evidence' } }),
    reuseState({ entry: { tool: 't', need: 'order_state' }, orderChanged: true })
  ];
  for (const state of produced) assert.ok(REUSE_STATES.includes(state), state);
});

// --- what is carried forward --------------------------------------------------

test('a call is matched to a need through the evidence vocabulary, not the ledger', () => {
  // FIRST MEASURED AS A BUG on four real tickets: every need read `missing`,
  // because a stored ledger entry is `{id, tool, argsHash, outcome}` and carries
  // no need to join on. `needsSatisfiedBy` already knows which tools settle
  // which need, so the mapping is derived rather than expected.
  const reuse = evidenceReuseFrom({
    toolCalls: [{ id: 'c1', tool: 'getOrderContext', argsHash: 'h1', outcome: 'found',
      data: { customer: 'Marie Dupont', address: '12 rue de Paris' } }],
    findings: { order_state: 'dispatched' },
    runAt: '2026-09-21T09:00:00Z'
  });

  assert.equal(reuse.order_state.tool, 'getOrderContext');
  assert.equal(reuse.order_state.outcome, 'found');
  assert.equal(reuse.order_state.finding, 'dispatched');
  // THE BOUNDARY. `tool_calls` drops `data` on purpose and `context_ref` points
  // at `resolved_context` rather than copying it; this does not reopen either.
  assert.equal(JSON.stringify(reuse).includes('Marie Dupont'), false);
  assert.equal(JSON.stringify(reuse).includes('rue de Paris'), false);
});

test('`unknown` is not carried, because it is not an answer', () => {
  // The run looked and could not settle it. Inheriting that as though it were a
  // finding would stop the next run looking again.
  const reuse = evidenceReuseFrom({
    toolCalls: [{ tool: 'getOrderContext' }, { tool: 'searchKnowledge' }],
    findings: { order_state: 'unknown', policy_answer: 'answered' }
  });
  assert.equal(reuse.order_state, undefined);
  assert.ok(reuse.policy_answer);
});

test('the relationship vocabulary is shared with the writer, not restated', () => {
  assert.deepEqual([...CASE_RELATIONSHIPS].sort(), ['continuation', 'new_information', 'new_issue', 'unclear']);
});

test('the plan: no case state matches the opening message', () => {
  assert.deepEqual(situationPlan({}), { match: 'opening' });
});

test('the plan: a new request read on THIS message is matched on it', () => {
  const reading = { case_relationship: 'new_issue', trigger_message_id: 'm2', situation_key: null };
  assert.deepEqual(situationPlan({ reading, triggerMessageId: 'm2' }), { match: 'trigger' });
});

test('the plan: an older new_issue reading does not re-match a later message', () => {
  const reading = { case_relationship: 'new_issue', trigger_message_id: 'm2', situation_key: null };
  assert.deepEqual(situationPlan({ reading, triggerMessageId: 'm3' }), { match: 'opening' });
});

test('the plan: a carried key keeps the previous match whole when it is the same situation', () => {
  const reading = { case_relationship: 'continuation', trigger_message_id: 'm2', situation_key: 'D-36' };
  const previousMatch = { verdict: 'matched', exemplar_key: 'D-36', similarity: 0.8, requirement_needs: ['order_identity'], tied: [] };
  assert.deepEqual(situationPlan({ reading, triggerMessageId: 'm2', previousMatch }).carry, {
    verdict: 'matched',
    exemplar_key: 'D-36',
    similarity: 0.8,
    requirement_needs: ['order_identity']
  });
});

test('the plan: a key the previous match does not share carries no needs rather than the wrong ones', () => {
  const reading = { case_relationship: 'continuation', trigger_message_id: 'm2', situation_key: 'R-23' };
  const previousMatch = { verdict: 'matched', exemplar_key: 'D-36', requirement_needs: ['order_identity'] };
  assert.deepEqual(situationPlan({ reading, triggerMessageId: 'm2', previousMatch }).carry, {
    verdict: 'carried',
    exemplar_key: 'R-23',
    requirement_needs: []
  });
});

test('the order changed when the confirmed number differs from the one the last run used', () => {
  assert.equal(orderChangedSince({ contextRef: { orderName: '#6059' }, currentOrderName: '#6059' }), false);
  assert.equal(orderChangedSince({ contextRef: { orderName: '#6059' }, currentOrderName: '#6060' }), true);
  // Confirmed after the run: the earlier order facts were about a candidate at best.
  assert.equal(orderChangedSince({ contextRef: { orderName: null }, currentOrderName: '#6059' }), true);
  assert.equal(orderChangedSince({ contextRef: {}, currentOrderName: null }), false);
});
