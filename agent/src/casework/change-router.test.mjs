import assert from 'node:assert/strict';
import test from 'node:test';

import { answerFromRow } from '../investigation/answer-selection.mjs';
import {
  changedStates,
  driftCurrentFor,
  driftDiffers,
  factDrift,
  orderSourcedClaims,
  routeChange,
  statesSeen
} from './change-router.mjs';

// The rulebook, as rows. `orders` branches on the order's state; `products`
// names none of them, like an ingredient question.
const ORDERS = [
  { answer_key: 'non_expediee', when_conditions: { order_state: ['not_dispatched'] } },
  { answer_key: 'expediee_sans_scan', when_conditions: { order_state: ['dispatched'] } },
  { answer_key: 'commande_annulee', when_conditions: { order_state: ['cancelled'] }, priority: 5 },
  { answer_key: 'modification_commande', situation_key: 'O-12', when_conditions: { order_state: ['not_dispatched', 'dispatched', 'delivered', 'cancelled', 'unknown'] } }
].map(answerFromRow);
const PRODUCTS = [{ answer_key: 'ingredients', when_conditions: { product_identity: ['resolved'] } }].map(answerFromRow);
const ANSWERS = new Map([['orders', ORDERS], ['products', PRODUCTS]]);

const STATES = {
  order_state: 'not_dispatched',
  delivery_state: 'not_dispatched',
  dispatch_state: 'within_window',
  delivery_delay_state: 'unknown',
  payment_state: 'paid',
  refund_state: 'none',
  return_eligibility: 'unknown'
};
const SHIPPED = { ...STATES, order_state: 'dispatched', delivery_state: 'dispatched_no_scan' };

const TICKET = { status: 'open', needs_investigation: false, needs_categorisation: false, shopify_order_number: '#7093' };
const OUR_TURN = { next_actor: 'support' };

function caseFile({ answerSet = 'orders', answerKey = 'non_expediee', situationKey = null, claims = [], perRequest = null, findings = STATES } = {}) {
  return {
    investigated_at: '2026-09-28T15:17:59Z',
    context_ref: { orderName: '#7093' },
    tool_calls: [
      { id: 't1', tool: 'getOrderContext' },
      { id: 't2', tool: 'searchKnowledge' }
    ],
    established: claims,
    findings_trace: [{ call: 't1', tool: 'getOrderContext', findings: { ...findings, product_identity: 'unknown' } }],
    exemplar_match: {
      policy: {
        answer_set: answerSet,
        situation_key: situationKey,
        answer_key: answerKey,
        verdict: 'selected',
        findings: answerSet === 'orders' ? { order_state: findings.order_state } : { product_identity: 'resolved' },
        ...(perRequest ? { per_request: perRequest } : {})
      }
    }
  };
}

const route = (overrides = {}) =>
  routeChange({ ticket: TICKET, caseCurrent: OUR_TURN, investigation: caseFile(), statesNow: SHIPPED, answersBySet: ANSWERS, ...overrides });

test('fulfilled on a « not yet shipped » case: the rule changes, so it re-investigates', () => {
  const result = route();
  assert.equal(result.outcome, 'reinvestigate');
  assert.equal(result.reason, 'rule_changed');
  assert.deepEqual(result.changed.order_state, { from: 'not_dispatched', to: 'dispatched' });
});

test('waiting on the customer, a colleague or a partner: nothing, even when the rule would change', () => {
  for (const actor of ['customer', 'colleague', 'partner', 'nobody']) {
    assert.equal(route({ caseCurrent: { next_actor: actor } }).outcome, 'none', actor);
  }
  assert.equal(route({ caseCurrent: null }).reason, 'not_our_turn');
});

test('awaiting the customer, resolved or closed: nothing', () => {
  for (const status of ['awaiting_customer', 'resolved', 'closed', 'forwarded']) {
    assert.equal(route({ ticket: { ...TICKET, status } }).reason, 'not_open', status);
  }
});

test('held for a person: a moved rule is redrafted, never re-investigated, so the status is never reopened', () => {
  const held = { ...TICKET, status: 'awaiting_human' };
  const moved = route({ ticket: held });
  assert.equal(moved.outcome, 'redraft');
  assert.equal(moved.reason, 'rule_changed:held_for_person');
  // No stored rule either.
  const bare = route({ ticket: held, investigation: { ...caseFile(), exemplar_match: null } });
  assert.deepEqual([bare.outcome, bare.reason], ['redraft', 'order_state_without_rule:held_for_person']);
  // The rule holds: the same redraft an open ticket gets.
  const holds = route({ ticket: held, investigation: caseFile({ answerKey: 'modification_commande', situationKey: 'O-12' }) });
  assert.deepEqual([holds.outcome, holds.reason], ['redraft', 'facts_changed']);
  // Irrelevant, or not our turn: nothing, as for an open ticket.
  assert.equal(route({ ticket: held, investigation: caseFile({ answerSet: 'products', answerKey: 'ingredients' }) }).outcome, 'none');
  assert.equal(route({ ticket: held, caseCurrent: { next_actor: 'partner' } }).outcome, 'none');
});

test('a pass already queued reads the fresh copy itself', () => {
  assert.equal(route({ ticket: { ...TICKET, needs_investigation: true } }).reason, 'pass_pending');
  assert.equal(route({ ticket: { ...TICKET, needs_categorisation: true } }).reason, 'pass_pending');
});

test('an ingredient question whose order shipped: irrelevant, nothing', () => {
  const result = route({ investigation: caseFile({ answerSet: 'products', answerKey: 'ingredients' }) });
  assert.equal(result.outcome, 'none');
  assert.equal(result.reason, 'irrelevant');
});

test('…unless the case file stated an order fact: then the reply rests on it, redraft', () => {
  const claims = [{ claim: 'La commande n’est pas encore expédiée.', evidence_ids: ['t1'] }];
  const result = route({ investigation: caseFile({ answerSet: 'products', answerKey: 'ingredients', claims }) });
  assert.equal(result.outcome, 'redraft');
});

test('a rule that holds whatever the state, read by the set: redraft, not re-investigate', () => {
  const result = route({ investigation: caseFile({ answerKey: 'modification_commande', situationKey: 'O-12' }) });
  assert.equal(result.outcome, 'redraft');
  assert.equal(result.reason, 'facts_changed');
});

test('a cancellation reaches the general rule, so it re-investigates', () => {
  const result = route({ statesNow: { ...STATES, order_state: 'cancelled' } });
  assert.equal(result.outcome, 'reinvestigate');
});

test('no change in any state: nothing', () => {
  assert.equal(route({ statesNow: STATES }).reason, 'unchanged');
});

test('a different order than the case file ran on is the linker’s, not a state change', () => {
  assert.equal(route({ ticket: { ...TICKET, shopify_order_number: '#9999' } }).reason, 'order_relinked');
});

test('multi-request: one request’s rule moving is enough', () => {
  const perRequest = [
    { answer_set: 'products', situation_key: null, answer_key: 'ingredients' },
    { answer_set: 'orders', situation_key: null, answer_key: 'non_expediee' }
  ];
  const result = route({ investigation: caseFile({ answerSet: 'products', answerKey: 'ingredients', perRequest }) });
  assert.equal(result.outcome, 'reinvestigate');
});

test('no stored rule: an order-state change re-investigates, another state does not', () => {
  const bare = { ...caseFile(), exemplar_match: null };
  assert.equal(route({ investigation: bare }).outcome, 'reinvestigate');
  const refunded = route({ investigation: bare, statesNow: { ...STATES, payment_state: 'partially_refunded' } });
  assert.equal(refunded.outcome, 'none');
});

test('a rule set that did not load cannot decide, and falls back the same way', () => {
  assert.equal(route({ answersBySet: new Map() }).reason, 'order_state_without_rule');
});

test('time alone: crossing the dispatch window is a changed state like any other', () => {
  const late = { ...STATES, dispatch_state: 'overdue' };
  const result = route({ investigation: caseFile({ answerKey: 'modification_commande', situationKey: 'O-12' }), statesNow: late });
  // No rule here reads dispatch_state and nothing was stated: irrelevant.
  assert.equal(result.outcome, 'none');
  const dispatchRule = [
    ...ORDERS,
    answerFromRow({ answer_key: 'non_expediee_en_retard', when_conditions: { order_state: ['not_dispatched'], dispatch_state: ['overdue'] } })
  ];
  const moved = route({ statesNow: late, answersBySet: new Map([['orders', dispatchRule]]) });
  assert.equal(moved.outcome, 'reinvestigate');
});

test('statesSeen reads the last trace entry, order states only', () => {
  const seen = statesSeen(caseFile());
  assert.equal(seen.order_state, 'not_dispatched');
  assert.equal(seen.product_identity, undefined);
  assert.equal(statesSeen({}), null);
});

test('a state becoming unknown is not a change; leaving unknown is', () => {
  assert.deepEqual(changedStates({ dispatch_state: 'within_window' }, { dispatch_state: 'unknown' }), {});
  assert.deepEqual(changedStates({ dispatch_state: 'unknown' }, { dispatch_state: 'overdue' }), { dispatch_state: { from: 'unknown', to: 'overdue' } });
});

test('changedStates skips states the case file never recorded', () => {
  assert.deepEqual(changedStates({ order_state: 'not_dispatched' }, SHIPPED), { order_state: { from: 'not_dispatched', to: 'dispatched' } });
});

test('orderSourcedClaims keeps a claim that also cites another tool', () => {
  const claims = [
    { claim: 'a', evidence_ids: ['t1'] },
    { claim: 'b', evidence_ids: ['t1', 't2'] },
    { claim: 'c', evidence_ids: [] }
  ];
  assert.deepEqual(orderSourcedClaims(caseFile({ claims })).map((c) => c.claim), ['a']);
});

test('the same drift is written once', () => {
  const investigation = caseFile();
  const { changed, outcome, reason } = route();
  const first = factDrift({ changed, outcome, reason, investigation, at: '2026-10-04T10:00:00Z' });
  const again = factDrift({ changed, outcome, reason, investigation, at: '2026-10-04T10:05:00Z' });
  assert.equal(driftDiffers(null, first), true);
  assert.equal(driftDiffers(first, again), false, 'only the check time moved');
  assert.equal(driftDiffers(first, { ...again, case_file_at: '2026-10-05T00:00:00Z' }), true);
});

test('a drift applies to the case file it was measured against, not a newer one', () => {
  const drift = { case_file_at: '2026-09-28T15:17:59Z' };
  assert.equal(driftCurrentFor(drift, { investigated_at: '2026-09-28T15:17:59Z' }), true);
  assert.equal(driftCurrentFor(drift, { investigated_at: '2026-10-04T17:00:00Z' }), false);
  assert.equal(driftCurrentFor(null, { investigated_at: '2026-09-28T15:17:59Z' }), false);
});
