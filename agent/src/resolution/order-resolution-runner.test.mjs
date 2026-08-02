import assert from 'node:assert/strict';
import test from 'node:test';

import { runOrderResolution } from './order-resolution-runner.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function buildStore({ pending = [], orders = [], range = { min: 1001, max: 6300 }, customers = [] } = {}) {
  const written = [];
  return {
    written,
    async findUnresolved() { return pending; },
    async loadOrderNumberRange() { return range; },
    async loadOrders() {
      return {
        byNumber: new Map(orders.map((o) => [o.order_number, o])),
        customersById: new Map(customers.map((c) => [c.id, c]))
      };
    },
    async recordResolution(ticket, resolution) { written.push({ ticket, resolution }); }
  };
}

const TICKET = { id: 't1', subject: 'ma commande', requester_email_hash: HASH_A, metadata: {} };

test('a confirmed match is written with the order name from the database', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'bonjour, ma commande #4854 est incomplète' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_A }]
  });

  const totals = await runOrderResolution({ store, shopId: 's1' });

  assert.equal(totals.confirmed, 1);
  assert.equal(totals.written, 1);
  assert.equal(store.written[0].resolution.orderName, '#4854');
});

test('a number far above the newest order is called out as a likely typo', async () => {
  // The max IS useful for catching typos — an extra digit, a transposition, an
  // invoice reference. 70853 against a newest order of 6300 is not sync lag.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'référence #70853' }],
    orders: [],
    range: { min: 1001, max: 6300 }
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.match(store.written[0].resolution.detail, /most likely a typo/);
});

test('a number just above the newest order blames the sync, not the customer', async () => {
  // `max` is always a little stale — orders are created continuously and the
  // sync runs on a schedule — so a number slightly above it is routinely real
  // and must not be called a typo.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #6320' }],
    orders: [],
    range: { min: 1001, max: 6300 }
  });

  await runOrderResolution({ store, shopId: 's1' });

  const detail = store.written[0].resolution.detail;
  assert.match(detail, /too recent to have synced/);
  assert.doesNotMatch(detail, /typo/);
});

test('the sync-lag margin has an absolute floor for small catalogues', async () => {
  // On a freshly seeded store a proportional margin alone is uselessly tight:
  // 25% of 12 orders is three.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #1300' }],
    orders: [],
    range: { min: 1001, max: 1012 }
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.match(store.written[0].resolution.detail, /too recent to have synced/);
});

test('a number below the oldest held order points at the retention window', async () => {
  // Orders older than about six months are outside what this desk handles, so
  // "older than our records" is both true and sufficient.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #500' }],
    orders: [],
    range: { min: 1001, max: 6300 }
  });

  await runOrderResolution({ store, shopId: 's1' });

  const detail = store.written[0].resolution.detail;
  assert.match(detail, /older than the ~6 months of orders we keep/);
  assert.doesNotMatch(detail, /typo/, 'an old order is not a mistake');
});

test('a number inside the held range is reported as simply absent', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [],
    range: { min: 1001, max: 6300 }
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.match(store.written[0].resolution.detail, /within the orders we hold/);
});

test('an empty catalogue never calls anything out of range', async () => {
  // An empty store has no opinion about what an order number looks like.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [],
    range: null
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.doesNotMatch(store.written[0].resolution.detail, /predate|too recent|we hold/);
});

test('a long order number resolves normally, as stores grow into them', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #1234567' }],
    orders: [{ order_number: 1234567, name: '#1234567', customer_email_hash: HASH_A }],
    range: { min: 1001, max: 2000000 }
  });

  const totals = await runOrderResolution({ store, shopId: 's1' });

  assert.equal(totals.confirmed, 1);
  assert.equal(store.written[0].resolution.orderName, '#1234567');
});

test('an order belonging to someone else is never written', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_B }]
  });

  const totals = await runOrderResolution({ store, shopId: 's1' });

  assert.equal(totals.mismatch, 1);
  assert.equal(totals.written, 0);
  assert.equal(store.written[0].resolution.status, 'mismatch');
});

test('an internal Q00 reference is named in the reason', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'peux-tu vérifier la commande Q00 26200111 ?' }],
    orders: []
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.equal(store.written[0].resolution.status, 'no_candidate');
  assert.match(store.written[0].resolution.detail, /internal_erp/);
});

test('a dry run writes nothing but still counts', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_A }]
  });

  const totals = await runOrderResolution({ store, shopId: 's1', dryRun: true });

  assert.equal(totals.written, 1, 'reports what it would do');
  assert.equal(store.written.length, 0, 'but wrote nothing');
});

test('every outcome is recorded, so a null column is explained', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'aucun numéro ici' }],
    orders: []
  });

  await runOrderResolution({ store, shopId: 's1' });

  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].resolution.status, 'no_candidate');
});
