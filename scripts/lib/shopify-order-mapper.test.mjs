import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateOrderRetention, deriveOrderStatus, mapOrder } from './shopify-order-mapper.mjs';

const BASE_ORDER = {
  id: 'gid://shopify/Order/1',
  legacyResourceId: '1',
  name: '#1001',
  number: 1001,
  sourceName: 'web',
  attribution: {
    displayName: 'Online Store',
    handle: 'online_store'
  },
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  returnStatus: 'NO_RETURN',
  currencyCode: 'EUR',
  presentmentCurrencyCode: 'EUR',
  tags: ['vip'],
  email: 'jane@example.com',
  phone: '+33123456789',
  shippingAddress: {
    address1: '1 Rue Example',
    zip: '75001',
    city: 'Paris',
    province: 'Ile-de-France',
    country: 'France',
    countryCodeV2: 'FR',
    formattedArea: 'Paris, France'
  },
  subtotalPriceSet: money('100.00'),
  totalDiscountsSet: money('10.00'),
  totalShippingPriceSet: money('5.00'),
  totalTaxSet: money('20.00'),
  totalPriceSet: money('115.00'),
  totalRefundedSet: money('0.00'),
  totalOutstandingSet: money('0.00'),
  totalWeight: 250,
  processedAt: '2026-01-01T10:00:00Z',
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-03T10:00:00Z',
  lineItems: {
    nodes: [{
      id: 'gid://shopify/LineItem/1',
      name: 'Creme Hydratante',
      title: 'Creme Hydratante',
      sku: 'SKU-1',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 0,
      refundableQuantity: 1,
      requiresShipping: true,
      discountedTotalSet: money('90.00'),
      originalTotalSet: money('100.00'),
      product: { id: 'gid://shopify/Product/1' },
      variant: { id: 'gid://shopify/ProductVariant/1' }
    }]
  },
  fulfillments: [{
    id: 'gid://shopify/Fulfillment/1',
    name: '#1001.1',
    status: 'SUCCESS',
    displayStatus: 'DELIVERED',
    totalQuantity: 1,
    createdAt: '2026-01-02T10:00:00Z',
    updatedAt: '2026-01-04T10:00:00Z',
    deliveredAt: '2026-01-04T10:00:00Z',
    trackingInfo: [{
      company: 'La Poste',
      number: 'TRACK123',
      url: 'https://example.test/track'
    }]
  }],
  returns: { nodes: [] },
  refunds: [],
  customer: {
    id: 'gid://shopify/Customer/1'
  }
};

test('mapOrder stores channel labels and avoids raw contact/address duplication', () => {
  const row = mapOrder(
    BASE_ORDER,
    'shop-id',
    '2026-07-20T00:00:00Z',
    new Map([['gid://shopify/Customer/1', 'customer-id']])
  );

  assert.equal(row.customer_id, 'customer-id');
  assert.equal(row.source_name, 'web');
  assert.equal(row.sales_channel, 'Online Store');
  assert.equal(row.sales_channel_handle, 'online_store');
  assert.equal(row.order_status, 'delivered');
  assert.equal(row.email, undefined);
  assert.equal(row.phone, undefined);
  assert.equal(row.customer_email_hash.length, 64);
  assert.equal(row.customer_phone_hash.length, 64);
  assert.equal(row.shipping_destination.city, 'Paris');
  assert.equal(row.shipping_destination.zip, undefined);
  assert.equal(row.raw_shopify_payload.email, undefined);
  assert.equal(row.raw_shopify_payload.shippingAddress.address1, undefined);
});

test('calculateOrderRetention deletes delivered orders three months after delivery', () => {
  const retention = calculateOrderRetention(BASE_ORDER);

  assert.equal(retention.retentionRule, 'delivered_plus_3_months');
  assert.equal(retention.deliveredAt, '2026-01-04T10:00:00.000Z');
  assert.equal(retention.retentionDeleteAfter, '2026-04-04T10:00:00.000Z');
});

test('calculateOrderRetention keeps unresolved returns for six months after opening', () => {
  const retention = calculateOrderRetention({
    ...BASE_ORDER,
    returnStatus: 'IN_PROGRESS',
    returns: {
      nodes: [{
        id: 'gid://shopify/Return/1',
        name: '#1001-R1',
        status: 'OPEN',
        createdAt: '2026-02-01T12:00:00Z',
        requestApprovedAt: '2026-02-02T12:00:00Z'
      }]
    }
  });

  assert.equal(retention.retentionRule, 'return_refund_open_plus_6_months');
  assert.equal(retention.returnRefundOpenedAt, '2026-02-01T12:00:00.000Z');
  assert.equal(retention.retentionDeleteAfter, '2026-08-01T12:00:00.000Z');
});

test('calculateOrderRetention deletes completed returns three months after completion', () => {
  const retention = calculateOrderRetention({
    ...BASE_ORDER,
    returnStatus: 'RETURNED',
    returns: {
      nodes: [{
        id: 'gid://shopify/Return/1',
        name: '#1001-R1',
        status: 'CLOSED',
        createdAt: '2026-02-01T12:00:00Z',
        closedAt: '2026-02-05T12:00:00Z'
      }]
    }
  });

  assert.equal(retention.retentionRule, 'return_refund_completed_plus_3_months');
  assert.equal(retention.returnRefundCompletedAt, '2026-02-05T12:00:00.000Z');
  assert.equal(retention.retentionDeleteAfter, '2026-05-05T12:00:00.000Z');
});

test('tracking numbers are lifted out of fulfillments into their own column', () => {
  const row = mapOrder(BASE_ORDER, 'shop-1', '2026-01-05T00:00:00Z');
  assert.deepEqual(row.tracking_numbers, ['TRACK123']);
  // The jsonb stays the record; the column is only the searchable copy.
  assert.equal(row.fulfillments[0].tracking_info[0].number, 'TRACK123');
});

test('a tracking number is normalised so a customer typing it can match it', () => {
  // Shopify hands back punctuation attached to the number — '6A06497617561.' is
  // in this store's data — and carriers print the digits in groups.
  const row = mapOrder(
    {
      ...BASE_ORDER,
      fulfillments: [{
        ...BASE_ORDER.fulfillments[0],
        trackingInfo: [{ company: 'Colissimo', number: ' 6a0649-7617 561. ' }]
      }]
    },
    'shop-1',
    '2026-01-05T00:00:00Z'
  );
  assert.deepEqual(row.tracking_numbers, ['6A06497617561']);
});

test('an order with nothing dispatched carries an empty array, never null', () => {
  // The column is `not null default '{}'`: a fulfillment with no carrier
  // reference yet is normal and must not produce a null the resolver has to
  // guard against.
  const row = mapOrder(
    { ...BASE_ORDER, fulfillments: [] },
    'shop-1',
    '2026-01-05T00:00:00Z'
  );
  assert.deepEqual(row.tracking_numbers, []);
});

test('the same parcel listed twice yields one entry', () => {
  const fulfillment = BASE_ORDER.fulfillments[0];
  const row = mapOrder(
    {
      ...BASE_ORDER,
      fulfillments: [fulfillment, { ...fulfillment, id: 'gid://shopify/Fulfillment/2' }]
    },
    'shop-1',
    '2026-01-05T00:00:00Z'
  );
  assert.deepEqual(row.tracking_numbers, ['TRACK123']);
});

test('calculateOrderRetention deletes undelivered orders six months after processing', () => {
  const retention = calculateOrderRetention({
    ...BASE_ORDER,
    displayFulfillmentStatus: 'UNFULFILLED',
    fulfillments: []
  });

  assert.equal(retention.retentionRule, 'undelivered_plus_6_months');
  assert.equal(retention.retentionDeleteAfter, '2026-07-01T10:00:00.000Z');
});

test('deriveOrderStatus prioritizes cancellation and active return state', () => {
  assert.equal(
    deriveOrderStatus({
      ...BASE_ORDER,
      cancelledAt: '2026-01-03T10:00:00Z',
      cancelReason: 'CUSTOMER',
      returns: { nodes: [] },
      refunds: []
    }),
    'cancelled'
  );

  assert.equal(
    deriveOrderStatus({
      ...BASE_ORDER,
      returnStatus: 'IN_PROGRESS',
      returns: {
        nodes: [{
          id: 'gid://shopify/Return/1',
          status: 'OPEN',
          createdAt: '2026-02-01T12:00:00Z'
        }]
      }
    }),
    'return_refund_in_progress'
  );
});

test('deriveOrderStatus maps fulfillment progress into simple dashboard stages', () => {
  assert.equal(
    deriveOrderStatus({
      ...BASE_ORDER,
      displayFulfillmentStatus: 'IN_TRANSIT',
      fulfillments: [{
        id: 'gid://shopify/Fulfillment/1',
        inTransitAt: '2026-01-03T10:00:00Z'
      }],
      returns: { nodes: [] },
      refunds: []
    }),
    'in_transit'
  );

  assert.equal(
    deriveOrderStatus({
      ...BASE_ORDER,
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      fulfillments: [],
      returns: { nodes: [] },
      refunds: []
    }),
    'partially_fulfilled'
  );
});

function money(amount) {
  return {
    shopMoney: {
      amount,
      currencyCode: 'EUR'
    },
    presentmentMoney: {
      amount,
      currencyCode: 'EUR'
    }
  };
}
