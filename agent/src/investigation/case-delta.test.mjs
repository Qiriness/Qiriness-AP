import assert from 'node:assert/strict';
import test from 'node:test';

import { caseDeltaFrom, renderCaseDelta } from './case-delta.mjs';

const READING = {
  trigger_message_id: 'm3',
  case_relationship: 'new_information',
  evidence_reuse: {
    order_identity: { need: 'order_identity', tool: 'getOrderContext', finding: 'confirmed', status: 'valid', run_at: '2026-09-02T10:00:00Z' },
    delivery_state: { need: 'delivery_state', tool: 'getOrderContext', finding: 'dispatched_no_scan', status: 'stale', run_at: '2026-09-02T10:00:00Z' },
    refund_state: { need: 'refund_state', tool: 'getOrderContext', finding: 'none', status: 'invalidated' }
  },
  new_facts: ['Le client indique que le colis n’est toujours pas arrivé.'],
  resolved_inputs: ['shopify_order_number', 'not_a_field'],
  pending_customer_inputs: ['photo'],
  commitments: [
    { what: 'Relancer le transporteur', status: 'pending' },
    { what: 'Envoyer le numéro de suivi', status: 'done' }
  ]
};

test('the delta sorts reused evidence by what may be done with it', () => {
  const delta = caseDeltaFrom({ reading: READING, triggerMessageId: 'm3' });
  assert.deepEqual(delta.established.map((r) => r.need), ['order_identity']);
  assert.deepEqual(delta.toRefresh.map((r) => r.need), ['delivery_state']);
  assert.deepEqual(delta.invalidated.map((r) => r.need), ['refund_state']);
  // Unknown question keys are dropped; done promises are not owed.
  assert.deepEqual(delta.answered, ['shopify_order_number']);
  assert.deepEqual(delta.promised, ['Relancer le transporteur']);
});

test('a reading about another message gives no delta, so the run is the one before this existed', () => {
  assert.equal(caseDeltaFrom({ reading: READING, triggerMessageId: 'm4' }), null);
  assert.equal(caseDeltaFrom({ reading: null, triggerMessageId: 'm3' }), null);
});

test('a second request gives no delta: the old evidence answers the old request', () => {
  assert.equal(caseDeltaFrom({ reading: { ...READING, case_relationship: 'new_issue' }, triggerMessageId: 'm3' }), null);
});

test('a reading with nothing in it gives no section rather than an empty one', () => {
  assert.equal(caseDeltaFrom({ reading: { trigger_message_id: 'm3', case_relationship: 'continuation' }, triggerMessageId: 'm3' }), null);
  assert.equal(renderCaseDelta(null), null);
});

test('the section says what stands, what to refresh and what not to reuse, and never a tool result', () => {
  const text = renderCaseDelta(caseDeltaFrom({ reading: READING, triggerMessageId: 'm3' }));
  assert.match(text, /Dossier connu/);
  assert.match(text, /toujours valable — ne relance pas un outil/);
  assert.match(text, /: confirmed \(via getOrderContext, 2026-09-02\)/);
  assert.match(text, /à revérifier :\n- .*\(était : dispatched_no_scan le 2026-09-02\)/);
  assert.match(text, /AUTRE commande/);
  assert.match(text, /n’est toujours pas arrivé/);
  assert.match(text, /Relancer le transporteur/);
  assert.doesNotMatch(text, /Envoyer le numéro de suivi/);
});
