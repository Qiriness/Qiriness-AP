import assert from 'node:assert/strict';
import test from 'node:test';

import { createPurchaseSummaryReader } from './purchase-summary-repository.mjs';

// A fake database: invented rows, every query recorded.
function fakeDb({ shop = { id: 'shop-1' }, orders = [], lines = [], channels = [{ handles: ['amazon'] }], logFails = false } = {}) {
  const queries = [];
  const logged = [];
  return {
    queries,
    logged,
    async select(table, filters, columns, options) {
      queries.push({ table, filters, columns, options });
      if (table === 'shops') return shop ? [shop] : [];
      if (table === 'sales_channels') return channels;
      if (table === 'orders') return orders;
      if (table === 'order_lines') return lines;
      throw new Error(`unexpected table ${table}`);
    },
    async logAccess(row) {
      if (logFails) throw new Error('audit down');
      logged.push(row);
    },
  };
}

const ORDERS = [{ id: 'o1', processed_at: '2026-09-01T10:00:00Z', sales_channel_handle: 'web' }];
const LINES = [{ order_id: 'o1', product_id: 'gid://shopify/Product/1', title: 'Sérum', quantity: '1', current_quantity: '1', discounted_total: '30' }];
const read = (db, id = '7001') => createPurchaseSummaryReader(db)({ shopDomain: 'dev-store.myshopify.com', shopifyCustomerId: id });

test('scoped to the signed shop and customer, by Shopify GraphQL id', async () => {
  const db = fakeDb({ orders: ORDERS, lines: LINES });
  const summary = await read(db);
  assert.equal(summary.products.length, 1);
  assert.deepEqual(db.queries.find((q) => q.table === 'shops').filters, { shop_domain: 'dev-store.myshopify.com' });
  const orders = db.queries.find((q) => q.table === 'orders');
  assert.equal(orders.filters.shop_id, 'shop-1');
  assert.equal(orders.filters.shopify_customer_id, 'gid://shopify/Customer/7001');
  assert.deepEqual(orders.filters.cancelled_at, { operator: 'is', value: 'null' });
  assert.deepEqual(db.queries.find((q) => q.table === 'order_lines').filters, { shop_id: 'shop-1', order_id: { operator: 'in', value: '(o1)' } });
});

test('selects no personal or order-money column', async () => {
  const db = fakeDb({ orders: ORDERS, lines: LINES });
  await read(db);
  for (const c of db.queries.flatMap((q) => q.columns.split(','))) {
    assert.doesNotMatch(c, /email|phone|^name$|address|destination|total_price|subtotal|refunds|raw|tracking|discount_codes|tags/, c);
  }
});

test('every read is logged with a hashed customer id and counts only', async () => {
  const db = fakeDb({ orders: ORDERS, lines: LINES });
  await read(db);
  assert.equal(db.logged.length, 1);
  const [row] = db.logged;
  assert.equal(row.action, 'purchase_summary_read');
  assert.equal(row.actor_id, 'storefront-advisor');
  assert.match(row.resource_id_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(row.metadata, { orders: 1, lines: 1, products: 1 });
  assert.doesNotMatch(JSON.stringify(row), /7001|Sérum/);
});

test('an unlogged read is not used: the audit failing fails the read', async () => {
  await assert.rejects(read(fakeDb({ orders: ORDERS, lines: LINES, logFails: true })), /audit down/);
});

test('no shop, a malformed id, or no orders: nothing read beyond what is needed', async () => {
  const none = fakeDb({ shop: null });
  assert.equal(await read(none), null);
  assert.deepEqual(none.queries.map((q) => q.table), ['shops']);
  const bad = fakeDb();
  assert.equal(await read(bad, 'gid://shopify/Customer/1'), null);
  assert.equal(bad.queries.length, 0);
  const empty = fakeDb({ orders: [] });
  assert.deepEqual(await read(empty), { products: [] });
  assert.ok(!empty.queries.some((q) => q.table === 'order_lines'));
});

test("marketplace orders are dropped by the shop's own channel list", async () => {
  const db = fakeDb({
    orders: [...ORDERS, { id: 'o2', processed_at: '2026-09-05T10:00:00Z', sales_channel_handle: 'amazon' }],
    lines: [...LINES, { ...LINES[0], order_id: 'o2', product_id: 'gid://shopify/Product/9' }],
  });
  const summary = await read(db);
  assert.deepEqual(summary.products.map((p) => p.product_id), ['gid://shopify/Product/1']);
});
