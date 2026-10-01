import assert from 'node:assert/strict';
import test from 'node:test';

import { OUTCOMES, basketFromCheckout, basketFromOrder, combinable, evaluateOutcome } from './promotion-outcome.mjs';

// Rows shaped like the live offers of 2026-10-01; baskets like the real orders
// behind the tickets named in each test.

const P = (n) => `gid://shopify/Product/${n}`;

const SHIPPING = {
  title: '🚚 Frais de port offerts à partir de 70€',
  discount_type: 'DiscountAutomaticFreeShipping',
  discount_classes: ['SHIPPING'],
  combines_with: { order_discounts: true, product_discounts: true, shipping_discounts: false },
  rule_snapshot: {
    minimum_requirement: { type: 'subtotal', amount: '70.0' },
    destination: { scope: 'countries', countries: ['FR'], include_rest_of_world: false }
  }
};
const VITAMINE = {
  title: 'wrap vitaminé Offert dès 65€ d’achat',
  discount_type: 'DiscountAutomaticBxgy',
  discount_classes: ['PRODUCT'],
  combines_with: { order_discounts: true, product_discounts: true, shipping_discounts: true },
  rule_snapshot: {
    customer_buys: { amount: '65.0', items: { scope: 'products', products: [{ id: P(1) }, { id: P(2) }] } },
    customer_gets: { percentage: 1, quantity: 1, items: { scope: 'products', products: [{ id: P(90) }] } }
  }
};
const OR = {
  ...VITAMINE,
  title: 'Masque Or offert',
  rule_snapshot: {
    customer_buys: { amount: '1.0', items: { scope: 'products', products: [{ id: P(1) }, { id: P(2) }] } },
    customer_gets: { percentage: 1, quantity: 1, items: { scope: 'products', products: [{ id: P(91) }] } }
  }
};
const MONODOSE = 'gid://shopify/Collection/474641695002';
const THREE_PLUS_ONE = {
  title: '3+1 Offert : 3 masques achetés le 4ème est offert',
  discount_type: 'DiscountAutomaticBxgy',
  discount_classes: ['PRODUCT'],
  combines_with: { order_discounts: false, product_discounts: false, shipping_discounts: true },
  rule_snapshot: {
    customer_buys: { quantity: '3', items: { scope: 'collections', collections: [{ id: MONODOSE }] } },
    customer_gets: { percentage: 1, quantity: 1, items: { scope: 'collections', collections: [{ id: MONODOSE }] } }
  }
};
const QIRINESS20 = {
  title: 'QIRINESS20',
  codes: [{ code: 'QIRINESS20' }],
  discount_type: 'DiscountCodeBasic',
  discount_classes: ['PRODUCT'],
  combines_with: { order_discounts: false, product_discounts: false, shipping_discounts: true },
  rule_snapshot: {}
};

const line = (n, price, paid = price, quantity = 1) => ({ productId: P(n), title: `p${n}`, quantity, price, paid });
const order = (lines, extra = {}) => ({ source: 'order', at: '2026-07-12T07:00:00Z', countryCode: 'FR', lines, applied: [], codes: [], ...extra });
const members = new Map([[MONODOSE, new Set([P(50), P(51), P(52)])]]);

test('free shipping on 72 € in France with nothing blocking is conditions_met — a person looks', () => {
  const r = evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 72)]) });
  assert.equal(r.outcome, 'conditions_met');
});

test('free shipping on a 260 € basket outside France fails on the destination, not the amount', () => {
  // 39f91aab: « 260 euros mais 5.50 euros de frais de livraison ».
  const r = evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 260)], { countryCode: 'BE' }) });
  assert.equal(r.outcome, 'outside_destination');
  assert.deepEqual(r.checks.find((c) => c.id === 'destination').allowed, ['FR']);
});

test('below the threshold says by how much', () => {
  const r = evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 55.4)]) });
  assert.equal(r.outcome, 'below_threshold');
  assert.equal(r.checks.find((c) => c.id === 'threshold').gap, 14.6);
});

test('a spend that crosses the threshold only before discounts is undetermined, never guessed', () => {
  const r = evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 75, 66)]) });
  assert.equal(r.outcome, 'undetermined');
});

test('an offer recorded on the order is applied, by name', () => {
  const r = evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 80)], { applied: [SHIPPING.title] }) });
  assert.equal(r.outcome, 'applied');
});

test('the gift charged on #6452: every condition held, nothing explains it — conditions_met', () => {
  // Lotion and lait (qualifying), the Wrap d'Or at 6,23 € charged, « wrap
  // vitaminé » applied beside it, and the two are set to combine.
  const basket = order([line(91, 6.23), line(90, 6.23, 0), line(1, 20), line(2, 53.1)], { applied: [VITAMINE.title] });
  const r = evaluateOutcome({ promotion: OR, basket, others: [VITAMINE] });
  assert.equal(r.outcome, 'conditions_met');
  assert.equal(r.checks.find((c) => c.id === 'reward').charged, true);
});

test('the gift itself never counts towards the spend that earns it', () => {
  const basket = order([line(90, 6.23), line(1, 60)]);
  const r = evaluateOutcome({ promotion: VITAMINE, basket });
  assert.equal(r.outcome, 'below_threshold');
});

test('a gift that was never put in the basket is the cause', () => {
  const r = evaluateOutcome({ promotion: VITAMINE, basket: order([line(1, 80)]) });
  assert.equal(r.outcome, 'reward_not_in_basket');
});

test('3 masks ordered is 3 masks paid: the fourth has to be in the basket', () => {
  // 1d5445ac: « WRAP PURIFIANT commandé 3 - reçu 3 et non 4 ».
  const r = evaluateOutcome({ promotion: THREE_PLUS_ONE, basket: order([line(50, 18, 18, 3)]), members });
  assert.equal(r.outcome, 'reward_not_in_basket');
});

test('a basket with nothing from the collection does not qualify', () => {
  const r = evaluateOutcome({ promotion: THREE_PLUS_ONE, basket: order([line(1, 30, 30, 4)]), members });
  assert.equal(r.outcome, 'items_not_qualifying');
});

test('a collection whose membership was never synced is undetermined', () => {
  const r = evaluateOutcome({ promotion: THREE_PLUS_ONE, basket: order([line(50, 18, 18, 4)]) });
  assert.equal(r.outcome, 'undetermined');
});

test('3+1 beside a code that refuses product discounts is not_combinable, and names it', () => {
  // 4e91c2df / 3b64e768: a sitewide code plus the 3+1.
  const basket = order([line(50, 18, 18, 4)], { applied: ['QIRINESS20'] });
  const r = evaluateOutcome({ promotion: THREE_PLUS_ONE, basket, others: [QIRINESS20], members });
  assert.equal(r.outcome, 'not_combinable');
  assert.equal(r.checks.find((c) => c.id === 'combination').with, 'QIRINESS20');
});

test('combination needs both sides to allow the other', () => {
  assert.equal(combinable(VITAMINE, OR), true);
  assert.equal(combinable(QIRINESS20, OR), false, 'the 20 % code refuses product discounts, and gifts are product discounts');
  assert.equal(combinable(SHIPPING, QIRINESS20), true);
});

test('an offer that had ended before the basket is expired, whatever else holds', () => {
  const ended = { ...SHIPPING, ends_at: '2026-06-01T00:00:00Z' };
  const r = evaluateOutcome({ promotion: ended, basket: order([line(1, 10)], { countryCode: 'BE' }) });
  assert.equal(r.outcome, 'expired');
});

test('no basket is undetermined', () => {
  assert.equal(evaluateOutcome({ promotion: SHIPPING, basket: null }).outcome, 'undetermined');
});

test('an abandoned checkout cannot say what was applied, and has no destination', () => {
  const basket = basketFromCheckout({
    updatedAt: '2026-09-01T10:00:00Z',
    discountCodes: ['QIRINESS20'],
    lineItems: [{ productId: P(1), title: 'x', quantity: 1, originalTotal: 80, discountedTotal: 64 }]
  });
  assert.equal(basket.applied, null);
  assert.equal(evaluateOutcome({ promotion: SHIPPING, basket }).outcome, 'undetermined');
});

test('an order bundle maps onto a basket', () => {
  const basket = basketFromOrder({
    placedAt: '2026-07-12T07:02:36Z',
    shipTo: { countryCode: 'FR' },
    items: [{ productId: P(91), title: "Wrap d'Or", quantity: 1, price: 6.23, paid: 6.23 }],
    promotions: { applied: [{ name: 'wrap vitaminé Offert dès 65€ d’achat' }], codes: [] }
  });
  assert.equal(basket.countryCode, 'FR');
  assert.deepEqual(basket.applied, ['wrap vitaminé Offert dès 65€ d’achat']);
  assert.equal(basket.lines[0].paid, 6.23);
});

test('every outcome is in the closed vocabulary', () => {
  for (const r of [
    evaluateOutcome({ promotion: SHIPPING, basket: null }),
    evaluateOutcome({ promotion: SHIPPING, basket: order([line(1, 72)]) })
  ]) {
    assert.ok(OUTCOMES.includes(r.outcome));
  }
});
