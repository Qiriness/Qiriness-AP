import assert from 'node:assert/strict';
import test from 'node:test';

import { reinvestigationColumns, runOrderResolution } from './order-resolution-runner.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/**
 * Both halves of the pass's wiring, as one fake.
 *
 * The orders store and the ticket record are separate objects in the real
 * runner: the store owns `orders` and `customers`, the record owns `tickets` and
 * reads the customer's opening words from the `ticket_first_inbound` view.
 * `written` captures the resolution the runner decided on, which is what every
 * assertion below is about.
 */
function buildStore({
  pending = [],
  orders = [],
  range = { min: 1001, max: 6300 },
  customers = [],
  trackedOrders = []
} = {}) {
  const written = [];
  const trackingQueries = [];
  return {
    written,
    trackingQueries,
    // --- the orders store ---
    async loadOrderNumberRange() { return range; },
    async loadOrders() {
      return {
        byNumber: new Map(orders.map((o) => [o.order_number, o])),
        customersById: new Map(customers.map((c) => [c.id, c]))
      };
    },
    async loadOrdersByTracking(shopId, numbers) {
      trackingQueries.push(numbers);
      const byTracking = new Map();
      for (const order of trackedOrders) {
        for (const number of order.tracking_numbers || []) {
          if (numbers.includes(number)) byTracking.set(number, order);
        }
      }
      return { byTracking, customersById: new Map(customers.map((c) => [c.id, c])) };
    },
    buildResolutionColumns(ticket, resolution) {
      written.push({ ticket, resolution });
      return {};
    },
    // --- the ticket record ---
    async findAwaitingOrderNumber() { return pending.map((p) => p.ticket); },
    async firstInboundByTicket() { return new Map(pending.map((p) => [p.ticket.id, p.text])); },
    async linkOrder() {}
  };
}

const TICKET = { id: 't1', subject: 'ma commande', requester_email_hash: HASH_A, metadata: {} };

test('a confirmed match is written with the order name from the database', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'bonjour, ma commande #4854 est incomplète' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_A }]
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1' });

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

  await runOrderResolution({ store, record: store, shopId: 's1' });

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

  await runOrderResolution({ store, record: store, shopId: 's1' });

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

  await runOrderResolution({ store, record: store, shopId: 's1' });

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

  await runOrderResolution({ store, record: store, shopId: 's1' });

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

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.match(store.written[0].resolution.detail, /within the orders we hold/);
});

test('an empty catalogue never calls anything out of range', async () => {
  // An empty store has no opinion about what an order number looks like.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [],
    range: null
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.doesNotMatch(store.written[0].resolution.detail, /predate|too recent|we hold/);
});

test('a long order number resolves normally, as stores grow into them', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #1234567' }],
    orders: [{ order_number: 1234567, name: '#1234567', customer_email_hash: HASH_A }],
    range: { min: 1001, max: 2000000 }
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(totals.confirmed, 1);
  assert.equal(store.written[0].resolution.orderName, '#1234567');
});

test('an order belonging to someone else is never written', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_B }]
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(totals.mismatch, 1);
  assert.equal(totals.written, 0);
  assert.equal(store.written[0].resolution.status, 'mismatch');
});

test('an internal Q00 reference is named in the reason', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'peux-tu vérifier la commande Q00 26200111 ?' }],
    orders: []
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(store.written[0].resolution.status, 'no_candidate');
  assert.match(store.written[0].resolution.detail, /internal_erp/);
});

test('a dry run writes nothing but still counts', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'ma commande #4854' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_A }]
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1', dryRun: true });

  assert.equal(totals.written, 1, 'reports what it would do');
  assert.equal(store.written.length, 0, 'but wrote nothing');
});

test('every outcome is recorded, so a null column is explained', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'aucun numéro ici' }],
    orders: []
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].resolution.status, 'no_candidate');
});

// --- resolving from a tracking number ----------------------------------------
// The second way into an order, for the customer chasing a parcel who has the
// carrier's number to hand and not the order number.

const TRACKED_ORDER = {
  id: 'o1',
  order_number: 6500,
  name: '#6500',
  customer_email_hash: HASH_A,
  tracking_numbers: ['6C21070620301']
};

test('a tracking number resolves the order when no order number was given', async () => {
  const store = buildStore({
    pending: [{
      ticket: TICKET,
      text: "Bonjour, mon colis 6C21070620301 n'est toujours pas arrivé."
    }],
    trackedOrders: [TRACKED_ORDER]
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(totals.confirmed, 1);
  assert.equal(totals.written, 1);
  assert.equal(store.written[0].resolution.orderName, '#6500');
  assert.equal(store.written[0].resolution.matchedBy, 'tracking_number');
});

test('the tracking number is matched however the customer spaced it', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'suivi 6C 2107 0620 301' }],
    trackedOrders: [TRACKED_ORDER]
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(store.written[0].resolution.orderName, '#6500');
});

test('a tracking match does NOT vouch for the sender', async () => {
  // The whole point of keeping verification unchanged. Measured on the live
  // mailbox, 6 of 8 tickets quoting a real tracking number were staff threads
  // about somebody else's parcel; confirming on possession alone would have
  // written six wrong order numbers.
  const store = buildStore({
    pending: [{
      ticket: { ...TICKET, requester_email_hash: HASH_B },
      text: 'le colis 6C21070620301 du client est en retard'
    }],
    trackedOrders: [TRACKED_ORDER]
  });

  const totals = await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(totals.written, 0, 'nothing written for a sender who does not own the order');
  assert.equal(store.written[0].resolution.status, 'mismatch');
  assert.equal(store.written[0].resolution.matchedBy, 'tracking_number');
});

test('an order number in the message wins, and no tracking lookup is made', async () => {
  // Cost control as much as precedence: the order number is the reference the
  // rest of the pipeline is built on, and a message carrying both must not
  // spend a second lookup.
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'commande #4854, suivi 6C21070620301' }],
    orders: [{ order_number: 4854, name: '#4854', customer_email_hash: HASH_A }],
    trackedOrders: [TRACKED_ORDER]
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(store.written[0].resolution.orderName, '#4854');
  assert.deepEqual(store.trackingQueries, [[]], 'no tracking numbers were collected');
});

test('a tracking number we hold no order for is explained, not silently empty', async () => {
  const store = buildStore({
    pending: [{ ticket: TICKET, text: 'mon colis 6C29999999999 est perdu' }],
    trackedOrders: [TRACKED_ORDER]
  });

  await runOrderResolution({ store, record: store, shopId: 's1' });

  assert.equal(store.written[0].resolution.status, 'no_candidate');
  assert.match(store.written[0].resolution.detail, /matches no order we hold/);
});

// --- a confirmed order on a ticket already investigated -----------------------

test('an order confirmed after the investigation queues it again and reopens an agent status', () => {
  // Ticket fcf4ca11: refused against a colleague's address, repaired later,
  // and left with a case file and draft that asked for the number.
  const at = '2026-09-13T23:54:13Z';
  assert.deepEqual(reinvestigationColumns({ status: 'awaiting_human', investigated_at: at }), {
    needs_investigation: true,
    status: 'open'
  });
  assert.deepEqual(reinvestigationColumns({ status: 'awaiting_customer', investigated_at: at }), {
    needs_investigation: true,
    status: 'open'
  });
  assert.deepEqual(reinvestigationColumns({ status: 'open', investigated_at: at }), { needs_investigation: true });
});

test('a person’s status is never reopened, and an uninvestigated ticket needs nothing', () => {
  const at = '2026-09-13T23:54:13Z';
  for (const status of ['resolved', 'closed', 'forwarded', 'spam']) {
    assert.deepEqual(reinvestigationColumns({ status, investigated_at: at }), {}, status);
  }
  assert.deepEqual(reinvestigationColumns({ status: 'open', investigated_at: null }), {});
});
