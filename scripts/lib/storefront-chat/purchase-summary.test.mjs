import assert from 'node:assert/strict';
import test from 'node:test';

import { ANONYMOUS } from './customer-identity.mjs';
import { MAX_SUMMARY_PRODUCTS, createPurchaseSummaryLookup, toPurchaseSummary } from './purchase-summary.mjs';

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
