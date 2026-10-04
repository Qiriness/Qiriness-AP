import assert from 'node:assert/strict';
import test from 'node:test';

import { orderSignature, orderSignatureHash } from './order-signature.mjs';

const ORDER = {
  name: '#7093',
  fulfillment_status: 'UNFULFILLED',
  financial_status: 'PAID',
  cancelled_at: null,
  tracking_numbers: [],
  fulfillments: [],
  tags: ['a']
};

test('a fulfilment, a parcel number, a refund or a cancellation moves the signature', () => {
  const base = orderSignatureHash(ORDER);
  assert.notEqual(orderSignatureHash({ ...ORDER, fulfillment_status: 'FULFILLED' }), base);
  assert.notEqual(orderSignatureHash({ ...ORDER, tracking_numbers: ['6C21247957209'] }), base);
  assert.notEqual(orderSignatureHash({ ...ORDER, financial_status: 'PARTIALLY_REFUNDED' }), base);
  assert.notEqual(orderSignatureHash({ ...ORDER, cancelled_at: '2026-10-01T00:00:00Z' }), base);
});

test('a tag or a price edit does not', () => {
  const base = orderSignatureHash(ORDER);
  assert.equal(orderSignatureHash({ ...ORDER, tags: ['b'], total_price: '10' }), base);
});

test('order of parcels and tracking numbers does not matter; no order has no signature', () => {
  const a = { ...ORDER, tracking_numbers: ['x', 'y'], fulfillments: [{ id: 1, status: 'SUCCESS' }, { id: 2, status: 'SUCCESS' }] };
  const b = { ...ORDER, tracking_numbers: ['y', 'x'], fulfillments: [{ id: 2, status: 'SUCCESS' }, { id: 1, status: 'SUCCESS' }] };
  assert.equal(orderSignature(a), orderSignature(b));
  assert.equal(orderSignatureHash(null), null);
});
