import assert from 'node:assert/strict';
import test from 'node:test';

import { ANONYMOUS } from './customer-identity.mjs';
import { MAX_SUMMARY_PRODUCTS, createPurchaseSummaryLookup, summarisePurchases, toPurchaseSummary } from './purchase-summary.mjs';

// Invented data: no real customer, product or order.
const row = (over = {}) => ({
  product_id: 'p-1',
  title: 'Sérum Exemple',
  first_purchased_on: '2026-03-02T10:00:00Z',
  last_purchased_on: '2026-09-14T08:30:00Z',
  times_purchased: 2,
  returned: false,
  free_gift: false,
  ...over,
});

test('only the allowed fields leave, whatever the reader adds', () => {
  const summary = toPurchaseSummary({
    email: 'jane@example.com',
    products: [row({ order_number: '#1001', amount_paid: 39, shipping_address: '1 rue X', discount_code: 'BIENVENUE', email: 'jane@example.com' })],
  });
  assert.deepEqual(summary, {
    products: [{
      product_id: 'p-1',
      title: 'Sérum Exemple',
      first_purchased_on: '2026-03-02',
      last_purchased_on: '2026-09-14',
      times_purchased: 2,
      returned: false,
      free_gift: false,
    }],
  });
  assert.doesNotMatch(JSON.stringify(summary), /jane|1001|39|rue|BIENVENUE/);
});

test('flags are true only when the reader says exactly true', () => {
  const [p] = toPurchaseSummary({ products: [row({ returned: 'yes', free_gift: 1 })] }).products;
  assert.equal(p.returned, false);
  assert.equal(p.free_gift, false);
  assert.equal(toPurchaseSummary({ products: [row({ free_gift: true })] }).products[0].free_gift, true);
});

test('rows without a product or a title are dropped; nothing usable is null', () => {
  assert.equal(toPurchaseSummary(null), null);
  assert.equal(toPurchaseSummary({ products: [] }), null);
  assert.equal(toPurchaseSummary({ products: [row({ product_id: '' }), row({ title: null })] }), null);
});

test('most recent first, capped', () => {
  const products = Array.from({ length: MAX_SUMMARY_PRODUCTS + 5 }, (_, i) =>
    row({ product_id: `p-${i}`, last_purchased_on: `2026-01-${String(i + 1).padStart(2, '0')}` }));
  const summary = toPurchaseSummary({ products });
  assert.equal(summary.products.length, MAX_SUMMARY_PRODUCTS);
  assert.equal(summary.products[0].product_id, `p-${MAX_SUMMARY_PRODUCTS + 4}`);
});

test('summarisePurchases: own-store orders only, gifts and returns flagged, counted by order', () => {
  const orders = [
    { id: 'o1', processed_at: '2026-02-01T10:00:00Z', sales_channel_handle: 'web' },
    { id: 'o2', processed_at: '2026-08-15T10:00:00Z', sales_channel_handle: 'web' },
    { id: 'o3', processed_at: '2026-09-01T10:00:00Z', sales_channel_handle: 'amazon' },
    { id: 'o4', processed_at: '2026-09-02T10:00:00Z', sales_channel_handle: 'web', cancelled_at: '2026-09-02T11:00:00Z' },
  ];
  const line = (order_id, product_id, over = {}) => ({ order_id, product_id, title: `T ${product_id}`, quantity: '1', current_quantity: '1', discounted_total: '30.00', ...over });
  const { products } = summarisePurchases(orders, [
    line('o1', 'serum'),
    line('o2', 'serum', { title: 'Serum renamed', quantity: '2', current_quantity: '2' }),
    line('o2', 'wrap', { discounted_total: '0.00' }),
    line('o1', 'cream', { current_quantity: '0' }),
    line('o3', 'amazon-only'),
    line('o4', 'cancelled-only'),
    line('o2', null),
  ], { marketplaceHandles: ['amazon'] });
  const by = Object.fromEntries(products.map((p) => [p.product_id, p]));
  assert.deepEqual(Object.keys(by).sort(), ['cream', 'serum', 'wrap']);
  assert.deepEqual(by.serum, { product_id: 'serum', title: 'Serum renamed', first_purchased_on: '2026-02-01', last_purchased_on: '2026-08-15', times_purchased: 2, returned: false, free_gift: false });
  assert.equal(by.wrap.free_gift, true);
  assert.equal(by.cream.returned, true);
});

test('the lookup asks the reader for the signed customer only, and never for an anonymous visitor', async () => {
  const asked = [];
  const lookup = createPurchaseSummaryLookup(async (query) => { asked.push(query); return { products: [row()] }; });
  assert.equal(await lookup(ANONYMOUS, 'dev-store.myshopify.com'), null);
  assert.equal(asked.length, 0);
  const summary = await lookup({ kind: 'customer', shopifyCustomerId: '7001', ref: 'r' }, 'dev-store.myshopify.com');
  assert.deepEqual(asked, [{ shopDomain: 'dev-store.myshopify.com', shopifyCustomerId: '7001' }]);
  assert.equal(summary.products.length, 1);
  assert.equal(await createPurchaseSummaryLookup(null)({ kind: 'customer', shopifyCustomerId: '7001', ref: 'r' }, 'x'), null);
});
