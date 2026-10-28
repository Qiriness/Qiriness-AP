import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalRoute, contextStrip, references } from './ticket-context-strip.ts';

const message = (bodyClean, subject = null) => ({ bodyClean, subject });
const order = (overrides = {}) => ({
  orderName: '#9876',
  orderStatus: 'Fulfilled',
  trackingStatus: 'In transit',
  tracking: [{ number: '8Y00123456789', carrier: 'Colissimo', url: null }],
  channel: null,
  ...overrides
});
const draft = (overrides = {}) => ({ status: 'pending', sendsOnApprove: false, holdsInDrafts: false, ...overrides });

test('a delivery question leads with the order, its state and the parcel', () => {
  const strip = contextStrip(
    { category: 'delivery', orderNumber: '9876', language: 'fr' },
    { order: order(), results: { action: 'Open a carrier enquiry' } },
    { messages: [], draft: draft({ holdsInDrafts: true }) }
  );
  assert.deepEqual(strip.pieces.map((p) => p.kind), ['order', 'orderStatus', 'delivery', 'parcel']);
  assert.equal(strip.action, 'Open a carrier enquiry');
  assert.equal(strip.approval, 'outlook');
});

test('a return shows the order state but not the parcel', () => {
  const strip = contextStrip({ category: 'return_exchange', orderNumber: '9876', language: 'fr' }, { order: order(), results: null }, null);
  assert.deepEqual(strip.pieces.map((p) => p.kind), ['order', 'orderStatus']);
});

test('a product question with no order says so, with the language', () => {
  const strip = contextStrip({ category: 'product', orderNumber: null, language: 'en' }, { order: null, results: null }, null);
  assert.deepEqual(strip.pieces, [{ kind: 'language', value: 'en' }, { kind: 'noOrder' }]);
});

test('a five-digit order number on the ticket is shown before the order bundle resolves', () => {
  const strip = contextStrip({ category: 'order', orderNumber: '10234', language: 'fr' }, null, null);
  assert.deepEqual(strip.pieces, [{ kind: 'order', value: '#10234' }]);
});

test('a marketplace channel is shown whatever the subject', () => {
  const strip = contextStrip({ category: 'product', orderNumber: '9876', language: 'fr' }, { order: order({ channel: 'Amazon' }), results: null }, null);
  assert.deepEqual(strip.pieces.map((p) => p.kind), ['order', 'channel']);
});

test('references are gathered across the thread, once each, capped', () => {
  const thread = {
    messages: [
      message('Réf Q00 26200111 et facture FA015974'),
      message('Toujours Q0026200111, expédition DS251105', 'RE: CL 59088'),
      message('Q00 11111111 Q00 22222222')
    ]
  };
  assert.deepEqual(references(thread), ['Q00 26200111', 'FA015974', 'CL 59088', 'DS251105']);
});

test('the approval route follows the draft, and a stale draft has none', () => {
  assert.equal(approvalRoute({ draft: draft({ sendsOnApprove: true }) }), 'sends');
  assert.equal(approvalRoute({ draft: draft() }), 'records');
  assert.equal(approvalRoute({ draft: draft({ status: 'stale', sendsOnApprove: true }) }), null);
  assert.equal(approvalRoute({ draft: null }), null);
});
