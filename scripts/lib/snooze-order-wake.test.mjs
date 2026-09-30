import assert from 'node:assert/strict';
import test from 'node:test';

import { materialOrderChange } from './snooze-order-wake.mjs';

const ORDER = {
  name: '#6997',
  fulfillment_status: 'FULFILLED',
  financial_status: 'PAID',
  cancelled_at: null,
  tracking_numbers: ['6C20723002488'],
  fulfillments: [{ id: 'f1', status: 'SUCCESS', display_status: 'IN_TRANSIT', delivered_at: null }],
  total_price: '42.00',
  tags: []
};

test('what a partner or carrier would tell us is a material change', () => {
  const delivered = { ...ORDER, fulfillments: [{ ...ORDER.fulfillments[0], display_status: 'DELIVERED', delivered_at: '2026-09-30T08:00:00Z' }] };
  assert.equal(materialOrderChange(ORDER, delivered), true);
  assert.equal(materialOrderChange(ORDER, { ...ORDER, tracking_numbers: ['6C20723002488', '6C99'] }), true);
  assert.equal(materialOrderChange(ORDER, { ...ORDER, financial_status: 'PARTIALLY_REFUNDED' }), true);
  assert.equal(materialOrderChange(ORDER, { ...ORDER, cancelled_at: '2026-09-30T08:00:00Z' }), true);
});

test('a price, a tag or the same parcels in another order change nothing', () => {
  assert.equal(materialOrderChange(ORDER, { ...ORDER, total_price: '40.00', tags: ['vip'] }), false);
  assert.equal(materialOrderChange(ORDER, { ...ORDER, tracking_numbers: [...ORDER.tracking_numbers].reverse() }), false);
});

test('a first sight of an order wakes nothing', () => {
  assert.equal(materialOrderChange(null, ORDER), false);
});
