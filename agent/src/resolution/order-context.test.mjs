import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrderContext } from './order-context.mjs';

const NOW = new Date('2026-08-02T12:00:00Z');

// Shaped on the real #1006 row.
const ORDER = {
  name: '#1006',
  order_number: 1006,
  processed_at: '2026-07-15T10:00:00Z',
  financial_status: 'PAID',
  fulfillment_status: 'FULFILLED',
  return_status: 'NO_RETURN',
  order_status: 'fulfilled',
  currency_code: 'EUR',
  subtotal_price: '68.95',
  total_price: '74.95',
  total_refunded: '0',
  line_items: [
    { title: 'Crème Nuit Anti-Âge', name: 'Crème Nuit Anti-Âge - 50 ml', sku: 'E024N', quantity: 1, product_id: 'gid://shopify/Product/1' }
  ],
  fulfillments: [
    {
      status: 'SUCCESS', display_status: 'FULFILLED', created_at: '2026-07-15T11:53:16Z',
      delivered_at: null, in_transit_at: null,
      tracking_info: [{ number: 'TEST5', company: 'Colissimo', url: 'https://laposte.fr/x' }]
    }
  ],
  refunds: [],
  returns: [],
  shipping_destination: { city: 'Rouen', country: 'France', country_code: 'FR', province: null }
};

const CUSTOMER = {
  display_name: 'Élodie Bonnet', email: 'elodie@example.com', locale: 'fr',
  number_of_orders: 3, amount_spent: '210.50', amount_spent_currency: 'EUR',
  on_email_marketing_list: true, default_address_city: 'Rouen', default_address_country: 'France',
  last_order_name: '#1006', last_order_at: '2026-07-15T10:00:00Z', last_order_total: '74.95', tags: ['vip']
};

test('the delivery state is derived, not copied from one column', () => {
  // No single column holds it: `fulfillment_status` says the warehouse
  // dispatched; only the fulfillment timestamps say whether the carrier moved
  // it. Those are different answers to "where is my parcel?".
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.equal(c.order.delivery.state, 'dispatched');
  assert.equal(c.signals.isDispatched, true);
  assert.equal(c.signals.isDelivered, false);
  assert.equal(c.signals.awaitingCarrierScan, true, 'the largest delivery cluster');
});

test('a delivered order reads as delivered', () => {
  const c = buildOrderContext(
    { ...ORDER, fulfillments: [{ ...ORDER.fulfillments[0], delivered_at: '2026-07-18T09:00:00Z' }] },
    CUSTOMER, { now: NOW }
  );
  assert.equal(c.order.delivery.state, 'delivered');
  assert.equal(c.signals.awaitingCarrierScan, false);
});

test('an unfulfilled order is not dispatched', () => {
  const c = buildOrderContext({ ...ORDER, fulfillments: [] }, CUSTOMER, { now: NOW });
  assert.equal(c.order.delivery.state, 'not_dispatched');
  assert.equal(c.signals.hasTracking, false);
});

test('tracking numbers come through with carrier and link', () => {
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.deepEqual(c.order.delivery.tracking, [
    { number: 'TEST5', carrier: 'Colissimo', url: 'https://laposte.fr/x', fulfillmentStatus: 'FULFILLED' }
  ]);
});

test('age and days since dispatch are computed, since "late" needs them', () => {
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.equal(c.order.ageDays, 18);
  assert.equal(c.order.delivery.daysSinceDispatch, 18);
});

test('a partial refund is not reported as a full one', () => {
  // "You were refunded" reads very differently at 12 € of 89 €.
  const partial = buildOrderContext({ ...ORDER, total_refunded: '12.00', refunds: [{ processed_at: '2026-07-20T00:00:00Z' }] }, CUSTOMER, { now: NOW });
  assert.equal(partial.signals.isRefunded, true);
  assert.equal(partial.signals.isFullyRefunded, false);

  const full = buildOrderContext({ ...ORDER, total_refunded: '74.95', refunds: [{}] }, CUSTOMER, { now: NOW });
  assert.equal(full.signals.isFullyRefunded, true);
});

test('no street address is ever included', () => {
  // The sync stores a coarse city/country and nothing here reaches for more.
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.deepEqual(c.order.shipTo, { city: 'Rouen', province: null, country: 'France', countryCode: 'FR' });
  assert.doesNotMatch(JSON.stringify(c), /address1|street|zip|postal/i);
});

test('no phone number is carried, on an email desk', () => {
  const c = buildOrderContext(ORDER, { ...CUSTOMER, phone: '+33612345678' }, { now: NOW });
  assert.doesNotMatch(JSON.stringify(c), /33612345678|phone/i);
});

test('the buyer name and email ARE carried, since support cannot answer without them', () => {
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.equal(c.customer.name, 'Élodie Bonnet');
  assert.equal(c.customer.email, 'elodie@example.com');
  assert.equal(c.customer.ordersCount, 3);
});

test('a missing customer degrades to null rather than throwing', () => {
  const c = buildOrderContext(ORDER, null, { now: NOW });
  assert.equal(c.customer, null);
  assert.equal(c.order.name, '#1006');
});

test('a missing order yields null, never an empty bundle', () => {
  // An empty bundle would read as "this order has nothing in it".
  assert.equal(buildOrderContext(null), null);
});

test('money is numeric, so nothing downstream compares strings', () => {
  const c = buildOrderContext(ORDER, CUSTOMER, { now: NOW });
  assert.equal(c.order.totals.total, 74.95);
  assert.equal(c.customer.amountSpent, 210.5);
});
