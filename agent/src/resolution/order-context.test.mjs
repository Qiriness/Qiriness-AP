import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrderContext, orderStates, toOrderContextText } from './order-context.mjs';
import { findingValues } from '../investigation/evidence-rules.mjs';

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


// --- the model's projection ---------------------------------------------------
//
// The bundle has three audiences: the dashboard reads it structured, the case
// file stores a pointer to it, and the model reads this. Before it existed the
// model got `JSON.stringify(bundle)` — not a chosen format, just whatever the
// builder happened to write.

test('it names the order, the payment and the delivery state in words', () => {
  const text = toOrderContextText(buildOrderContext(ORDER, null, { now: NOW }));

  assert.match(text, /Commande #1006/);
  assert.match(text, /Paiement : réglée/);
  // The enum `FULFILLED` is not a sentence a drafting model should echo.
  assert.ok(!text.includes('FULFILLED'), 'no raw Shopify enum reaches the model');
});

test('join keys never reach the model', () => {
  // `sku` and `productId` exist to join rows, not to be told to anyone. The
  // dashboard may want them; the drafting agent has no use for either.
  const text = toOrderContextText(buildOrderContext(ORDER, null, { now: NOW }));

  assert.ok(!text.includes('E024N'), 'sku withheld');
  assert.ok(!text.includes('gid://shopify'), 'product id withheld');
  assert.match(text, /Crème Nuit Anti-Âge/, 'but the title a customer recognises is kept');
});

test('money appears only when a reply turns on it', () => {
  // Quoting a total at someone asking where their parcel is invites the drafting
  // model to discuss a number nobody raised.
  const plain = toOrderContextText(buildOrderContext(ORDER, null, { now: NOW }));
  assert.ok(!plain.includes('74.95'), 'no total on an ordinary order');

  const refunded = toOrderContextText(
    buildOrderContext({ ...ORDER, total_refunded: '20.00' }, null, { now: NOW })
  );
  assert.match(refunded, /Remboursement/, 'but a refund is stated');
});

test('a cancelled order says so before anything else about it', () => {
  const text = toOrderContextText(
    buildOrderContext(
      { ...ORDER, cancelled_at: '2026-07-20T09:00:00Z', cancel_reason: 'CUSTOMER' },
      null,
      { now: NOW }
    )
  );
  const lines = text.split('\n');
  assert.ok(lines[1].includes('ANNULÉE'), 'the cancellation is the second line, before payment');
  assert.match(text, /CUSTOMER/);
});

test('a bundle with no order renders nothing rather than an empty shell', () => {
  assert.equal(toOrderContextText(null), null);
  assert.equal(toOrderContextText({}), null);
});

test('the masked contact address reaches the bundle but never the model', () => {
  // The asymmetry is the point: a person reviewing an ownership mismatch needs
  // to see which address placed the order; the drafting agent never does.
  const context = buildOrderContext(
    { ...ORDER, customer_email_masked: 'j***l@bluewin.ch' },
    null,
    { now: NOW }
  );

  assert.equal(context.order.contactEmailMasked, 'j***l@bluewin.ch');
  assert.ok(
    !toOrderContextText(context).includes('bluewin'),
    'the model projection withholds it'
  );
});

test('the model is given the parcel number and never its URL', () => {
  // THE COMPANION TO THE TEST ABOVE, and the reason the two sit together: the
  // contact address is withheld because it is not the model's business, and the
  // tracking URL is withheld because the model has no use for it. The reply
  // names the parcel by number; `TrackingText` turns that number into the link
  // wherever the reply is read. Given the URL, the model pastes it into the
  // prose in full — which is what a customer would then receive.
  const context = buildOrderContext(ORDER, null, { now: NOW });
  const text = toOrderContextText(context);

  assert.match(text, /Suivi : TEST5 \(Colissimo\)\./);
  assert.ok(!text.includes('laposte.fr'), 'the URL is on the bundle and not in the projection');
  assert.ok(!/https?:\/\//.test(text), 'no URL of any kind reaches the model');
  // Still on the bundle, because the panel and the linkifier both need it.
  assert.equal(context.order.delivery.tracking[0].url, 'https://laposte.fr/x');
});

test('a parcel with no URL is unchanged by any of this', () => {
  const order = {
    ...ORDER,
    fulfillments: [
      { ...ORDER.fulfillments[0], tracking_info: [{ number: 'TEST5', company: 'Colissimo', url: null }] }
    ]
  };
  const context = buildOrderContext(order, null, { now: NOW });
  assert.match(toOrderContextText(context), /Suivi : TEST5 \(Colissimo\)\./);
  assert.equal(context.order.delivery.tracking[0].url, null);
});

// --- the states a policy rule branches on ------------------------------------

const STALE = 10;
const statesFor = (order, now = NOW) =>
  orderStates(buildOrderContext(order, null, { now }), { staleTransitDays: STALE, now });

const fulfilment = (extra = {}) => ({
  status: 'SUCCESS', display_status: 'FULFILLED', created_at: '2026-07-15T11:53:16Z',
  delivered_at: null, in_transit_at: null, tracking_info: [{ number: 'TEST5' }], ...extra
});

test('an unfulfilled order is not dispatched, on both axes', () => {
  // The state your cancellation rule turns on.
  const states = statesFor({ ...ORDER, fulfillment_status: 'UNFULFILLED', fulfillments: [] });
  assert.equal(states.order_state, 'not_dispatched');
  assert.equal(states.delivery_state, 'not_dispatched');
});

test('dispatched with no carrier scan is its own state, never in_transit', () => {
  // The biggest delivery cluster in the corpus. Calling it `in_transit` would
  // claim movement nothing has evidenced — the same claim `delivery_unscanned`
  // forbids the model from making in prose.
  const states = statesFor({ ...ORDER, fulfillments: [fulfilment()] });
  assert.equal(states.order_state, 'dispatched');
  assert.equal(states.delivery_state, 'dispatched_no_scan');
});

test('a parcel that has not moved for the stale window says so', () => {
  // Same arithmetic `escalationTriggers` already uses to raise the level, so the
  // rule layer and the escalation cannot disagree about what "stuck" means.
  const order = { ...ORDER, fulfillments: [fulfilment({ in_transit_at: '2026-07-16T09:00:00Z' })] };
  assert.equal(statesFor(order, new Date('2026-07-20T12:00:00Z')).delivery_state, 'in_transit');
  assert.equal(statesFor(order, new Date('2026-08-02T12:00:00Z')).delivery_state, 'stale_in_transit');
});

test('delivered is delivered on both axes', () => {
  const states = statesFor({ ...ORDER, fulfillments: [fulfilment({ delivered_at: '2026-07-18T09:00:00Z' })] });
  assert.equal(states.order_state, 'delivered');
  assert.equal(states.delivery_state, 'delivered');
});

test('cancelled outranks every other order state', () => {
  // A cancelled order that never shipped is not awaiting dispatch, and
  // answering it as though it were is the worst reading available.
  const states = statesFor({ ...ORDER, cancelled_at: '2026-07-16T10:00:00Z', fulfillments: [] });
  assert.equal(states.order_state, 'cancelled');
});

test('a fully refunded order does not report as paid', () => {
  // Shopify still says PAID. Testing `isPaid` first would report money we have
  // given back as money we are holding.
  const refunded = statesFor({
    ...ORDER,
    total_refunded: '74.95',
    refunds: [{ amount: '74.95', processed_at: '2026-07-20T10:00:00Z' }]
  });
  assert.equal(refunded.payment_state, 'refunded');

  const partial = statesFor({
    ...ORDER,
    total_refunded: '20.00',
    refunds: [{ amount: '20.00', processed_at: '2026-07-20T10:00:00Z' }]
  });
  assert.equal(partial.payment_state, 'partially_refunded');

  assert.equal(statesFor(ORDER).payment_state, 'paid');
});

test('no bundle, no states — and never a half-filled object', () => {
  assert.equal(orderStates(null), null);
  assert.equal(orderStates({}), null);
});

test('every state is a value the findings vocabulary accepts', () => {
  // The seam between this module and evidence-rules: a value produced here that
  // the enum does not declare would collapse to `unknown` and the rule that
  // wanted it would never fire.
  const states = statesFor({ ...ORDER, fulfillments: [fulfilment()] });
  assert.ok(findingValues('order_state').includes(states.order_state));
  assert.ok(findingValues('delivery_state').includes(states.delivery_state));
  assert.ok(findingValues('payment_state').includes(states.payment_state));
});

// --- the one state that needs a merchant decision ----------------------------

const delivered = (daysAgo) => ({
  ...ORDER,
  fulfillments: [
    {
      status: 'SUCCESS', display_status: 'FULFILLED', created_at: '2026-07-15T11:53:16Z',
      delivered_at: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(),
      in_transit_at: null, tracking_info: [{ number: 'TEST5' }]
    }
  ]
});

const eligibility = (order, windowDays) =>
  orderStates(buildOrderContext(order, null, { now: NOW }), {
    staleTransitDays: STALE,
    returnsWindowDays: windowDays,
    now: NOW
  }).return_eligibility;

test('an undecided returns window resolves unknown, never a default', () => {
  // THE POINT OF THE PARAMETER. A default here would be a policy: 30 would tell
  // customers a window nobody approved, 0 would refuse every return. `unknown`
  // routes to a person, which is the right behaviour for a shop that has not
  // written its returns window down — and this shop's two approved articles
  // disagree, so there is no default to reach for.
  assert.equal(eligibility(delivered(3), null), 'unknown');
  assert.equal(eligibility(delivered(3), undefined), 'unknown');
});

test('inside the window is possible, outside it is out_of_window', () => {
  assert.equal(eligibility(delivered(3), 30), 'possible');
  assert.equal(eligibility(delivered(30), 30), 'possible', 'the last day is still inside');
  assert.equal(eligibility(delivered(31), 30), 'out_of_window');
});

test('the same order flips on the window alone', () => {
  // What makes this a parameter rather than a constant: the merchant's number
  // decides, and the two their articles give disagree about this very order.
  const order = delivered(20);
  assert.equal(eligibility(order, 30), 'possible');
  assert.equal(eligibility(order, 14), 'out_of_window');
});

test('an undelivered order is unknown, not possible', () => {
  // The clock runs from receipt, which is what both articles say. Telling
  // somebody they can return a parcel nobody has received answers a different
  // question.
  const notYet = { ...ORDER, fulfillment_status: 'UNFULFILLED', fulfillments: [] };
  assert.equal(eligibility(notYet, 30), 'unknown');
});

test('the value is one the findings vocabulary accepts', () => {
  assert.ok(findingValues('return_eligibility').includes(eligibility(delivered(3), 30)));
  assert.ok(findingValues('return_eligibility').includes(eligibility(delivered(3), null)));
});

// --- where the refund has got to ---------------------------------------------

test('refund_state answers a different question from payment_state', () => {
  // THE PAIR THAT MUST NOT COLLAPSE. An order with an open return has had no
  // money moved, so `payment_state` calls it `paid` — indistinguishable from a
  // customer who has asked for nothing. « Sous quel délai suis-je remboursé ? »
  // is asked precisely in that gap.
  const withReturn = orderStates({
    order: { refunds: { count: 0 }, delivery: {}, status: { payment: 'PAID' } },
    signals: { isPaid: true, hasOpenReturn: true }
  });
  assert.equal(withReturn.payment_state, 'paid');
  assert.equal(withReturn.refund_state, 'return_open');
});

test('an open return outranks a refund that has already gone out', () => {
  // Checked first on purpose: a customer who has been partially refunded and has
  // a second return open is asking about the second one.
  const states = orderStates({
    order: { refunds: { count: 1 }, delivery: {}, status: { payment: 'PAID' } },
    signals: { isPaid: true, isRefunded: true, hasOpenReturn: true }
  });
  assert.equal(states.refund_state, 'return_open');
});

test('nothing refunded on a real order is `none`, not `unknown`', () => {
  // The difference is whether we looked. `none` rests on a real order with no
  // money moved, which a reply may state; `unknown` is a ticket with no order
  // context at all, which it may not.
  const looked = orderStates({
    order: { refunds: { count: 0 }, delivery: {}, status: { payment: 'PAID' } },
    signals: { isPaid: true }
  });
  assert.equal(looked.refund_state, 'none');

  const noRefundData = orderStates({ order: { delivery: {} }, signals: {} });
  assert.equal(noRefundData.refund_state, 'unknown');
});

test('a full refund is told from a partial one', () => {
  const full = orderStates({
    order: { refunds: { count: 1, isFull: true }, delivery: {} },
    signals: { isRefunded: true, isFullyRefunded: true }
  });
  const partial = orderStates({
    order: { refunds: { count: 1, isFull: false }, delivery: {} },
    signals: { isRefunded: true }
  });
  assert.equal(full.refund_state, 'refunded_full');
  assert.equal(partial.refund_state, 'refunded_partial');
});

test('the dispatch window is measured in working days, and only when the shop has set one', () => {
  // Placed Friday; "now" is the following Tuesday. Three calendar days have
  // passed, but only two of them are working days — so a 3-day window has NOT
  // run out yet.
  const placed = { order: { placedAt: '2026-07-03T10:00:00Z', delivery: {} }, signals: {} };
  const tuesday = new Date('2026-07-07T10:00:00Z');
  assert.equal(
    orderStates(placed, { dispatchDays: 3, now: tuesday }).dispatch_state,
    'within_window',
    'the weekend does not count against the shop'
  );

  // A week later it plainly has.
  assert.equal(
    orderStates(placed, { dispatchDays: 3, now: new Date('2026-07-15T10:00:00Z') }).dispatch_state,
    'overdue'
  );

  // NO PARAMETER, NO CLAIM. `dispatch_days` starts null like every parameter,
  // and defaulting here would invent a delivery promise on the shop's behalf.
  assert.equal(
    orderStates(placed, { now: new Date('2026-07-15T10:00:00Z') }).dispatch_state,
    'unknown'
  );

  // And nothing to measure from is the same answer.
  assert.equal(
    orderStates({ order: { delivery: {} }, signals: {} }, { dispatchDays: 3 }).dispatch_state,
    'unknown'
  );
});
