import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_PAGE_SIZE,
  SEARCH_MAX_LENGTH,
  delayDays,
  normaliseSearch,
  enumLabel,
  fulfillmentDisplay,
  fulfillmentStatusLabel,
  orderListArgs,
  orderNumberKey,
  parseOrderListQuery,
  ticketMarksByOrder
} from './order-list-query.mjs';

test('an empty query is the unfiltered first page', () => {
  assert.deepEqual(parseOrderListQuery({}), { status: null, country: null, vip: false, search: null, page: 1 });
});

test('the filters are read, normalised and bounded', () => {
  assert.deepEqual(parseOrderListQuery({ status: 'unfulfilled', country: 'be', vip: 'true', q: ' #7008 ', page: '3' }), {
    status: 'UNFULFILLED',
    country: 'BE',
    vip: true,
    search: '#7008',
    page: 3
  });
  assert.equal(parseOrderListQuery({ country: '??' }).country, '??');
  assert.equal(parseOrderListQuery({ vip: '1' }).vip, true);
  assert.equal(parseOrderListQuery({ page: ['2', '9'] }).page, 2);
  assert.equal(parseOrderListQuery({ page: '99999999' }).page, 10_000);
});

test('malformed values fall back to no filter rather than failing', () => {
  const query = parseOrderListQuery({ status: "FULFILLED'; drop", country: 'France', vip: 'yes', page: '-2' });
  assert.deepEqual(query, { status: null, country: null, vip: false, search: null, page: 1 });
  assert.equal(parseOrderListQuery({ page: '2.5' }).page, 1);
});

test('the page becomes a limit and an offset, and the search travels with it', () => {
  assert.deepEqual(orderListArgs({ status: 'FULFILLED', country: null, vip: true, search: 'martin', page: 3 }), {
    p_fulfillment_status: 'FULFILLED',
    p_country: null,
    p_vip_only: true,
    p_search: 'martin',
    p_limit: ORDER_PAGE_SIZE,
    p_offset: 2 * ORDER_PAGE_SIZE
  });
});

test('a search loses its LIKE wildcards, extra spaces and excess length', () => {
  assert.equal(normaliseSearch('  jean   dupont '), 'jean dupont');
  assert.equal(normaliseSearch('100%_off\\'), '100 off');
  assert.equal(normaliseSearch('%%'), null);
  assert.equal(normaliseSearch(['6C 2072 3002 488', 'x']), '6C 2072 3002 488');
  assert.equal(normaliseSearch('a'.repeat(200)).length, SEARCH_MAX_LENGTH);
  assert.equal(normaliseSearch(undefined), null);
});

test('delay counts whole days, and only for an order still waiting', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  assert.equal(delayDays('2026-09-11T13:00:00Z', true, now), 2);
  assert.equal(delayDays('2026-09-11T11:00:00Z', true, now), 3);
  assert.equal(delayDays('2026-09-14T08:00:00Z', true, now), 0);
  assert.equal(delayDays('2026-09-01T08:00:00Z', false, now), null);
  assert.equal(delayDays(null, true, now), null);
  assert.equal(delayDays('2026-09-15T08:00:00Z', true, now), 0);
});

test('an order name and an order number share one key', () => {
  assert.equal(orderNumberKey('#7008'), '7008');
  assert.equal(orderNumberKey(' # 7008 '), '7008');
  assert.equal(orderNumberKey(7008), '7008');
  assert.equal(orderNumberKey('7008'), orderNumberKey('#7008'));
});

test('a reference that is not a Shopify number matches nothing', () => {
  assert.equal(orderNumberKey('Q00 26200111'), null);
  assert.equal(orderNumberKey('#7008-2'), null);
  assert.equal(orderNumberKey(''), null);
  assert.equal(orderNumberKey(null), null);
});

test('an order is marked by its most urgent open ticket', () => {
  const marks = ticketMarksByOrder([
    { orderNumber: '#7008', open: true, band: 'low' },
    { orderNumber: '#7008', open: true, band: 'high' },
    { orderNumber: '#7008', open: true, band: 'medium' },
    { orderNumber: '#6990', open: true, band: 'medium' }
  ]);
  assert.deepEqual(marks.get('7008'), { band: 'high', openTickets: 3 });
  assert.deepEqual(marks.get('6990'), { band: 'medium', openTickets: 1 });
});

test('closed tickets and tickets without an order leave no mark', () => {
  const marks = ticketMarksByOrder([
    { orderNumber: '#7008', open: false, band: 'high' },
    { orderNumber: null, open: true, band: 'high' },
    { orderNumber: 'Q00 26200111', open: true, band: 'high' },
    { orderNumber: '#6990', open: true, band: 'unknown' }
  ]);
  assert.equal(marks.size, 0);
});

test('a closed ticket does not raise the colour an open one set', () => {
  const marks = ticketMarksByOrder([
    { orderNumber: '#7008', open: true, band: 'low' },
    { orderNumber: '#7008', open: false, band: 'high' }
  ]);
  assert.deepEqual(marks.get('7008'), { band: 'low', openTickets: 1 });
});

test('Shopify enums read as words', () => {
  assert.equal(enumLabel('PARTIALLY_REFUNDED'), 'Partially refunded');
  assert.equal(fulfillmentStatusLabel('UNFULFILLED'), 'Unfulfilled');
  assert.equal(fulfillmentStatusLabel('UNKNOWN'), 'No status');
  assert.equal(fulfillmentStatusLabel(null), 'No status');
});

test('an order with nothing left to ship says why, not "Unfulfilled"', () => {
  // The two shapes all 14 UNFULFILLED orders took on 2026-09-18 (#4727, #4886).
  assert.deepEqual(
    fulfillmentDisplay({ status: 'UNFULFILLED', units: 0, cancelled: true, financialStatus: 'REFUNDED' }),
    { status: 'CANCELLED', label: 'Cancelled' }
  );
  assert.deepEqual(
    fulfillmentDisplay({ status: 'UNFULFILLED', units: 0, cancelled: true, financialStatus: 'VOIDED' }),
    { status: 'CANCELLED', label: 'Cancelled' }
  );
  assert.deepEqual(
    fulfillmentDisplay({ status: 'UNFULFILLED', units: 0, cancelled: false, financialStatus: 'REFUNDED' }),
    { status: 'REFUNDED', label: 'Refunded' }
  );
});

test('an order that still has items, or already shipped, keeps Shopify\'s status', () => {
  assert.deepEqual(
    fulfillmentDisplay({ status: 'UNFULFILLED', units: 2, cancelled: false, financialStatus: 'PARTIALLY_REFUNDED' }),
    { status: 'UNFULFILLED', label: 'Unfulfilled' }
  );
  // Shipped, then returned and refunded: it was fulfilled, and still says so.
  assert.deepEqual(
    fulfillmentDisplay({ status: 'FULFILLED', units: 0, cancelled: false, financialStatus: 'REFUNDED' }),
    { status: 'FULFILLED', label: 'Fulfilled' }
  );
  // Empty, but neither cancelled nor refunded: nothing better to say.
  assert.deepEqual(
    fulfillmentDisplay({ status: 'UNFULFILLED', units: 0, cancelled: false, financialStatus: 'PAID' }),
    { status: 'UNFULFILLED', label: 'Unfulfilled' }
  );
  assert.deepEqual(fulfillmentDisplay({ status: null, units: 1, cancelled: false, financialStatus: null }), {
    status: 'UNKNOWN',
    label: 'No status'
  });
});
