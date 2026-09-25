import assert from 'node:assert/strict';
import test from 'node:test';

import { compare, expectedRelationship, isTouched, pipelineNextAction, tally } from './score-casework.mjs';

test('a suggestion left alone is not a label', () => {
  assert.equal(isTouched({ effect: 'continuation', fromPrefill: true, answered: [], waitingCustomer: [], waitingInternal: [] }), false);
});

test('an effect the labeller chose, or any other field set, is a label', () => {
  assert.equal(isTouched({ effect: 'holding', fromPrefill: false }), true);
  assert.equal(isTouched({ effect: 'continuation', fromPrefill: true, caseState: 'open' }), true);
  assert.equal(isTouched({ fromPrefill: true, waitingInternal: ['order_state'] }), true);
});

test('a chase is what the pipeline calls continuation; an internal note it cannot say', () => {
  assert.equal(expectedRelationship('chase'), 'continuation');
  assert.equal(expectedRelationship('internal_note'), null);
  assert.equal(expectedRelationship('closes_case'), null);
});

test('a thread a colleague opened is not drafted; a colleague writing on a customer thread is', () => {
  assert.equal(pipelineNextAction({ ticket: { sender_label: 'internal' } }).action, 'no_reply');
  assert.equal(pipelineNextAction({ ticket: { sender_label: null } }).action, 'full_reply');
});

test('a closure closes only through the gate; with no case file the gate is taken as open', () => {
  assert.equal(pipelineNextAction({ ticket: {}, closes: true, gateOpen: null }).action, 'closing_reply');
  assert.equal(pipelineNextAction({ ticket: {}, closes: true, gateOpen: true }).action, 'closing_reply');
  assert.equal(pipelineNextAction({ ticket: {}, closes: true, gateOpen: false }).action, 'full_reply');
  assert.equal(pipelineNextAction({ ticket: { duplicate_of_ticket_id: 'x' }, closes: true }).why, 'doublon lié');
});

test('an unset label is unlabelled, an unsayable one inexpressible, and sets compare unordered', () => {
  assert.equal(compare(null, 'x'), 'unlabelled');
  assert.equal(compare('no_reply_person_acts', 'full_reply', { expressible: false }), 'inexpressible');
  assert.equal(compare(['a', 'b'], ['b', 'a']), 'agree');
  assert.equal(compare('closing_reply', 'full_reply'), 'disagree');
});

test('the tally keeps the four outcomes apart per field', () => {
  assert.deepEqual(tally([{ effect: 'agree' }, { effect: 'inexpressible' }, { effect: 'agree', nextAction: 'disagree' }]), {
    effect: { agree: 2, disagree: 0, inexpressible: 1, unlabelled: 0 },
    nextAction: { agree: 0, disagree: 1, inexpressible: 0, unlabelled: 0 }
  });
});
