import assert from 'node:assert/strict';
import test from 'node:test';

import { caseKey, compatibleFamilies, decideLink, familyOf } from './case-link-rules.mjs';

const TRANSITIONS = [
  ['ORDER_CHANGE', 'DELIVERY'],
  ['DELIVERY', 'ORDER_CHANGE'],
  ['DELIVERY', 'REFUND_RETURN'],
  ['ORDER_CHANGE', 'REFUND_RETURN']
];
const thread = (extra = {}) => ({ excluded: false, hasPriorCases: true, orderNumber: null, trackingNumbers: [], family: 'DELIVERY', ...extra });
const candidate = (caseId, extra = {}) => ({ caseId, orderNumbers: [], trackingNumbers: [], family: 'DELIVERY', reasons: [], ...extra });

test('a customer with no other case opens a new one, and nothing else is asked', () => {
  assert.deepEqual(decideLink({ thread: thread({ hasPriorCases: false }), candidates: [candidate('k1')] }), {
    decision: 'new_case',
    method: 'first_contact'
  });
});

test('a listed sender or one of our own threads is never linked', () => {
  assert.deepEqual(decideLink({ thread: thread({ excluded: true, orderNumber: '#5832' }), candidates: [candidate('k1', { orderNumbers: ['#5832'] })] }), {
    decision: 'new_case',
    method: 'excluded_sender'
  });
});

test('the same parcel links to the case about that parcel', () => {
  const outcome = decideLink({
    thread: thread({ trackingNumbers: ['6C20723002488'] }),
    candidates: [candidate('k1', { trackingNumbers: ['6C20723002488'] }), candidate('k2')],
    transitions: TRANSITIONS
  });
  assert.deepEqual(outcome, { decision: 'link', caseId: 'k1', method: 'tracking' });
});

test('a parcel shared with a case about ANOTHER order is contradicted, not linked on tracking', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '#6000', trackingNumbers: ['6C20723002488'] }),
    candidates: [candidate('k1', { trackingNumbers: ['6C20723002488'], orderNumbers: ['#5832'] })],
    transitions: TRANSITIONS
  });
  assert.equal(outcome.decision, 'ambiguous');
});

test('late delivery then not received, same order: one case', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '5832', family: 'DELIVERY' }),
    candidates: [candidate('k1', { orderNumbers: ['#5832'], family: 'DELIVERY' })],
    transitions: TRANSITIONS
  });
  assert.deepEqual(outcome, { decision: 'link', caseId: 'k1', method: 'order_family' });
});

test('a delivery case continuing as a refund is the same case (configured transition)', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '#5832', family: 'REFUND_RETURN' }),
    candidates: [candidate('k1', { orderNumbers: ['#5832'], family: 'DELIVERY' })],
    transitions: TRANSITIONS
  });
  assert.deepEqual(outcome, { decision: 'link', caseId: 'k1', method: 'order_family' });
});

test('a product question on the same order is a second problem, never linked by a rule', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '#5832', family: 'PRODUCT' }),
    candidates: [candidate('k1', { orderNumbers: ['#5832'], family: 'DELIVERY' })],
    transitions: TRANSITIONS
  });
  assert.equal(outcome.decision, 'ambiguous');
});

test('two compatible cases on one order cannot be told apart by a rule', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '#5832' }),
    candidates: [candidate('k1', { orderNumbers: ['#5832'] }), candidate('k2', { orderNumbers: ['#5832'] })],
    transitions: TRANSITIONS
  });
  assert.equal(outcome.decision, 'ambiguous');
  assert.equal(outcome.candidates.length, 2);
});

test('the only case on this order links when a family is unknown on one side', () => {
  const outcome = decideLink({
    thread: thread({ orderNumber: '#5832', family: null }),
    candidates: [candidate('k1', { orderNumbers: ['#5832'], family: 'DELIVERY' }), candidate('k2', { orderNumbers: ['#4000'] })],
    transitions: TRANSITIONS
  });
  assert.deepEqual(outcome, { decision: 'link', caseId: 'k1', method: 'unique_match' });
});

test('no identifier at all: plausible candidates are ambiguous, none is a new case', () => {
  assert.equal(decideLink({ thread: thread(), candidates: [candidate('k1')], transitions: TRANSITIONS }).decision, 'ambiguous');
  assert.deepEqual(decideLink({ thread: thread(), candidates: [], transitions: TRANSITIONS }), {
    decision: 'new_case',
    method: 'no_candidates'
  });
});

test('families: self is compatible, transitions are directed, unknown is nothing', () => {
  assert.equal(compatibleFamilies('DELIVERY', 'DELIVERY', []), true);
  assert.equal(compatibleFamilies('DELIVERY', 'REFUND_RETURN', TRANSITIONS), true);
  assert.equal(compatibleFamilies('REFUND_RETURN', 'DELIVERY', TRANSITIONS), false);
  assert.equal(compatibleFamilies(null, 'DELIVERY', TRANSITIONS), false);
});

test('a situation outranks the subject when it has a family', () => {
  const families = { subjects: { order: 'ORDER_CHANGE' }, situations: { 'O-09': 'DELIVERY' } };
  assert.equal(familyOf({ subject: 'order', situation: 'O-09' }, families), 'DELIVERY');
  assert.equal(familyOf({ subject: 'order', situation: 'X-99' }, families), 'ORDER_CHANGE');
  assert.equal(familyOf({ subject: 'b2b' }, families), null);
});

test('the case key needs all three parts', () => {
  assert.equal(caseKey({ customerKey: 'h', orderNumber: '#5832', family: 'DELIVERY' }), 'h|5832|DELIVERY');
  assert.equal(caseKey({ customerKey: 'h', orderNumber: null, family: 'DELIVERY' }), null);
});
