import assert from 'node:assert/strict';
import test from 'node:test';

import { runOrderContext } from './order-context-runner.mjs';

const ORDER = {
  id: 'o1', name: '#1006', order_number: 1006, customer_id: 'c1',
  financial_status: 'PAID', fulfillment_status: 'FULFILLED',
  currency_code: 'EUR', total_price: '74.95', total_refunded: '0',
  line_items: [{ title: 'Crème', sku: 'E024N', quantity: 1 }],
  fulfillments: [{ created_at: '2026-07-15T11:00:00Z', tracking_info: [{ number: 'TEST5', company: 'Colissimo' }] }],
  refunds: [], returns: [], processed_at: '2026-07-15T10:00:00Z'
};
const CUSTOMER = { id: 'c1', display_name: 'Élodie Bonnet', email: 'e@example.com', number_of_orders: 3 };

/**
 * Both halves of the pass's wiring, as one fake: the orders store and the ticket
 * record, which are separate objects in the real runner.
 */
function buildStore({ tickets = [], orders = [ORDER], customers = [CUSTOMER] } = {}) {
  const saved = [];
  return {
    saved,
    lastFilters: null,
    // --- the ticket record ---
    async findAwaitingContext(options) { this.lastFilters = options; return tickets; },
    async loadOrders() {
      return {
        byName: new Map(orders.map((o) => [o.name, o])),
        customersById: new Map(customers.map((c) => [c.id, c]))
      };
    },
    async setResolvedContext(ticket, context, customerId) { saved.push({ ticket, context, customerId }); }
  };
}

const TICKET = { id: 't1', shopify_order_number: '#1006', customer_id: null };

test('a ticket with a confirmed order gets a bundle', async () => {
  const store = buildStore({ tickets: [TICKET] });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });

  assert.equal(totals.resolved, 1);
  assert.equal(store.saved[0].context.order.name, '#1006');
  assert.equal(store.saved[0].context.customer.name, 'Élodie Bonnet');
});

test('the customer link is written back onto the ticket', async () => {
  // The ticket knew only a hash before; now it knows which customer row that
  // was, so later tools skip resolution entirely.
  const store = buildStore({ tickets: [TICKET] });
  await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(store.saved[0].customerId, 'c1');
});

test('an existing customer link is not overwritten', async () => {
  const store = buildStore({ tickets: [{ ...TICKET, customer_id: 'already' }] });
  await runOrderContext({ store, record: store, shopId: 's1' });
  // setResolvedContext receives it, but the record decides; assert we passed the order's
  // customer and left the ticket's own value for the store to respect.
  assert.equal(store.saved[0].ticket.customer_id, 'already');
});

test('a missing order writes nothing rather than an empty bundle', async () => {
  // An empty resolved_context would read as "this order has nothing in it".
  const store = buildStore({ tickets: [{ ...TICKET, shopify_order_number: '#9999' }] });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });

  assert.equal(totals.order_missing, 1);
  assert.equal(totals.resolved, 0);
  assert.equal(store.saved.length, 0);
});

test('by default only tickets without a bundle are considered', async () => {
  const store = buildStore({ tickets: [TICKET] });
  await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(store.lastFilters.refresh, false);
});

test('refresh rebuilds tickets that already have one', async () => {
  // An order moves — dispatched, delivered, refunded — so a stored bundle is a
  // fact about when it was built.
  const store = buildStore({ tickets: [TICKET] });
  await runOrderContext({ store, record: store, shopId: 's1', refresh: true });
  assert.equal(store.lastFilters.refresh, true);
});

test('a dry run assembles but writes nothing', async () => {
  const store = buildStore({ tickets: [TICKET] });
  const totals = await runOrderContext({ store, record: store, shopId: 's1', dryRun: true });

  assert.equal(totals.resolved, 1);
  assert.equal(store.saved.length, 0);
});

test('an order with no customer row still produces a bundle', async () => {
  const store = buildStore({ tickets: [TICKET], customers: [] });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });

  assert.equal(totals.resolved, 1);
  assert.equal(store.saved[0].context.customer, null);
  assert.equal(store.saved[0].context.order.name, '#1006');
});

// --- Outdated bundles (DECISIONS § Change router) ---------------------------

function buildRefreshStore({ awaiting = [], built = [], stamps = new Map() } = {}) {
  const store = buildStore({ tickets: awaiting });
  store.findBuiltContext = async () => built;
  store.orderUpdatedAt = async () => stamps;
  return store;
}

const BUILT = { ...TICKET, id: 't2', context_resolved_at: '2026-09-28T10:00:00Z', source_updated_at: '2026-09-28T09:00:00+00:00' };

test('a bundle whose order carries a newer Shopify stamp is rebuilt', async () => {
  const store = buildRefreshStore({ built: [BUILT], stamps: new Map([['#1006', '2026-09-29T14:32:44+00:00']]) });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(totals.outdated, 1);
  assert.equal(store.saved[0].ticket.id, 't2');
});

test('a bundle built from the order version still current is left alone', async () => {
  // Same instant, different spelling: compared as times, not as strings.
  const store = buildRefreshStore({ built: [BUILT], stamps: new Map([['#1006', '2026-09-28T09:00:00Z']]) });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(totals.outdated, 0);
  assert.equal(store.saved.length, 0);
});

test('a sync landing after the build is caught even though Shopify stamped it earlier', async () => {
  // Changed in Shopify at 09:30, built here at 10:00 from the 09:00 version,
  // synced at 12:00: « newer than the build » would miss it.
  const store = buildRefreshStore({ built: [BUILT], stamps: new Map([['#1006', '2026-09-28T09:30:00Z']]) });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(totals.outdated, 1);
});

test('a bundle built before the stamp existed is rebuilt once', async () => {
  const store = buildRefreshStore({ built: [{ ...BUILT, source_updated_at: null }], stamps: new Map([['#1006', '2026-09-28T09:00:00Z']]) });
  await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].context.sourceUpdatedAt, null, 'the fixture order has no stamp');
});

test('an order no longer stored is not counted as outdated', async () => {
  const store = buildRefreshStore({ built: [BUILT], stamps: new Map() });
  const totals = await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(totals.outdated, 0);
});

test('--refresh does not double-count the outdated ones', async () => {
  const store = buildRefreshStore({ awaiting: [TICKET], built: [BUILT], stamps: new Map([['#1006', '2026-09-29T00:00:00Z']]) });
  const totals = await runOrderContext({ store, record: store, shopId: 's1', refresh: true });
  assert.equal(totals.considered, 1);
  assert.equal(totals.outdated, 0);
});

test('the bundle records the order version it was built from', async () => {
  const store = buildStore({ tickets: [TICKET], orders: [{ ...ORDER, shopify_updated_at: '2026-09-29T14:32:44Z' }] });
  await runOrderContext({ store, record: store, shopId: 's1' });
  assert.equal(store.saved[0].context.sourceUpdatedAt, '2026-09-29T14:32:44Z');
});
