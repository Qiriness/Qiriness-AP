import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateOffers } from './offer-solver.mjs';
import { createShoppingTurn } from './shopping-tools.mjs';

// The dev-store case of docs/shopify-discount-rules.md § 3. Dummy ids.
const NOW = Date.parse('2026-10-06T12:00:00Z');
const CREAM = 'gid://shopify/Product/1', EAU = 'gid://shopify/Product/2', ROSE = 'gid://shopify/Collection/3';
const all = { order_discounts: true, product_discounts: true, shipping_discounts: true };
const offer = (extra) => ({ status: 'ACTIVE', starts_at: '2020-01-01T00:00:00Z', ends_at: null, method: 'automatic', codes: [], describable_in_replies: true, offerable_in_replies: false, combines_with: all, ...extra });
function source() {
  return { status: 'ok', shopDomain: 'test.myshopify.com', loadedAt: NOW, members: new Map([[ROSE, new Set([CREAM, EAU])]]),
    products: [
      { id: 'cream', shopify_product_id: CREAM, title: 'Caresse Temps Sublime', status: 'active', published_at: '2020-01-01', variants: [{ id: 'gid://shopify/ProductVariant/11', price: '68.95' }] },
      { id: 'eau', shopify_product_id: EAU, title: 'Eau Qi', status: 'active', published_at: '2020-01-01', variants: [{ id: 'gid://shopify/ProductVariant/22', price: '37.80' }] }
    ],
    promotions: [
      offer({ id: 'rose', title: 'September Rose', discount_type: 'DiscountAutomaticBasic', discount_classes: ['PRODUCT'], rule_snapshot: { customer_selection: { scope: 'all' }, customer_gets: { percentage: 0.3, items: { scope: 'collections', collections: [{ id: ROSE }] } }, minimum_requirement: null } }),
      offer({ id: 'test02', title: 'TEST02', discount_type: 'DiscountAutomaticBxgy', discount_classes: ['PRODUCT'], rule_snapshot: { customer_selection: { scope: 'all' }, customer_buys: { quantity: 1, items: { scope: 'products', products: [{ id: CREAM }] } }, customer_gets: { quantity: 1, percentage: 1, items: { scope: 'products', products: [{ id: EAU }] } }, minimum_requirement: null } }),
      offer({ id: 'welcome', title: 'Bienvenue', method: 'code', codes: [{ code: 'WELCOME10' }], offerable_in_replies: true, describable_in_replies: false, discount_type: 'DiscountCodeBasic', discount_classes: ['ORDER'], rule_snapshot: { customer_selection: { scope: 'all' }, customer_gets: { percentage: 0.1, items: { scope: 'all' } }, minimum_requirement: { type: 'subtotal', amount: '40', currency: 'EUR' } } })
    ], cartCodeRows: [] };
}
const line = (productId, variantId, price, quantity = 1) => ({ productId, variantId, quantity, unitPrice: price, originalTotal: price * quantity, finalTotal: price * quantity });
const cartOf = (lines, extra = {}) => {
  const subtotal = lines.reduce((n, l) => n + l.originalTotal, 0);
  return { currency: 'EUR', originalSubtotal: subtotal, subtotal, total: subtotal, lines, discounts: [], codes: [], ...extra };
};
const creamLine = line(CREAM, 'gid://shopify/ProductVariant/11', 6895);
const eauLine = line(EAU, 'gid://shopify/ProductVariant/22', 3780);
const ids = (r) => r.best.offers.map((o) => o.promotion_id);

test('the best saving wins: TEST02 (Eau Qi free) beats September Rose on both items', () => {
  const r = simulateOffers(cartOf([creamLine, eauLine]), source(), {}, { now: NOW });
  assert.deepEqual(ids(r), ['test02']);
  assert.equal(r.best.saving_total, 37.8);
  assert.equal(r.best.total_after, 68.95, 'the cream stays at full price: TEST02 holds both lines');
  assert.deepEqual(r.alternatives[0].offers.map((o) => o.promotion_id), ['rose']);
  assert.equal(r.alternatives[0].saving_total, 32.03);
  assert.deepEqual(r.excluded, [{ promotion_id: 'welcome', name: 'Bienvenue', reason: 'code_not_entered' }]);
});

test('without the « gets » item, the Buy X Get Y cannot apply and September Rose does', () => {
  const r = simulateOffers(cartOf([creamLine]), source(), {}, { now: NOW });
  assert.deepEqual(ids(r), ['rose']);
  assert.equal(r.best.total_after, 48.26);
});

test('« what if I add the Eau Qi? » prices the hypothetical cart', () => {
  const r = simulateOffers(cartOf([creamLine]), source(), { add: [{ product_id: 'eau', quantity: 1 }] }, { now: NOW });
  assert.equal(r.cart_priced, 'current_cart_with_additions');
  assert.deepEqual(r.additions, [{ product_id: 'eau', name: 'Eau Qi', quantity: 1, unit_price: 37.8 }]);
  assert.deepEqual(ids(r), ['test02']);
  assert.equal(r.matches_current_cart, null, 'nothing to compare a hypothetical cart with');
});

test('an entered order code stacks on the subtotal after product discounts; its minimum is met before and after', () => {
  const r = simulateOffers(cartOf([creamLine], { codes: ['WELCOME10'] }), source(), {}, { now: NOW });
  assert.deepEqual(ids(r), ['rose', 'welcome']);
  const welcome = r.best.offers.find((o) => o.promotion_id === 'welcome');
  assert.equal(welcome.saving, 4.83, '10 % of 48,26 €, not of 68,95 €');
  assert.equal(welcome.code, 'WELCOME10');
  const low = simulateOffers(cartOf([line(CREAM, 'gid://shopify/ProductVariant/11', 5000)], { codes: ['WELCOME10'] }), source(), {}, { now: NOW });
  assert.deepEqual(ids(low), ['rose'], '50 € → 35 € after September Rose: below the 40 € minimum, so the two cannot both apply and the bigger single saving wins');
  assert.deepEqual(low.alternatives.map((a) => ids({ best: a })), [['welcome']]);
});

test('flags that refuse each other split the sets; the cart is the authority on a real cart', () => {
  const s = source();
  s.promotions[0].combines_with = { ...all, order_discounts: false };
  const r = simulateOffers(cartOf([creamLine], { codes: ['WELCOME10'], discounts: [{ title: 'September Rose', type: 'automatic', amount: 2069 }] }), s, {}, { now: NOW });
  assert.deepEqual(ids(r), ['rose']);
  assert.equal(r.matches_current_cart, true);
  const differs = simulateOffers(cartOf([creamLine, eauLine], { discounts: [{ title: 'September Rose', type: 'automatic', amount: 3203 }] }), source(), {}, { now: NOW });
  assert.equal(differs.matches_current_cart, false);
  assert.ok(differs.caveats.includes('prediction_differs_from_cart_cart_is_authoritative'));
});

test('simulate_offers only adds products resolved this turn', async () => {
  const s = source();
  const turn = createShoppingTurn({ readShopping: async () => s, shopDomain: s.shopDomain, cart: cartOf([creamLine]), resolvedProducts: [{ id: 'eau', shopifyId: EAU, handle: 'eau-qi' }] });
  assert.equal((await turn.run('simulate_offers', { add: [{ product_id: 'cream' }] })).reason, 'product_not_resolved');
  const r = await turn.run('simulate_offers', { add: [{ product_id: 'eau' }] });
  assert.equal(r.status, 'ok');
});

test('free delivery missed because the best saving lowers the total below its minimum', () => {
  const s = source();
  s.promotions.push(offer({ id: 'ship', title: 'Livraison gratuite', discount_type: 'DiscountAutomaticFreeShipping', discount_classes: ['SHIPPING'], combines_with: { order_discounts: true, product_discounts: true, shipping_discounts: false }, rule_snapshot: { customer_selection: { scope: 'all' }, minimum_requirement: { type: 'subtotal', amount: '70', currency: 'EUR' } } }));
  const r = simulateOffers(cartOf([creamLine, eauLine]), s, {}, { now: NOW });
  assert.deepEqual(ids(r), ['test02'], 'Shopify keeps the bigger product saving');
  assert.deepEqual(r.free_delivery_missed, [{ promotion_id: 'ship', name: 'Livraison gratuite', missing: 1.05, before_discounts: true }]);
  assert.deepEqual(r.alternatives[0].offers.map((o) => o.promotion_id), ['rose', 'ship']);
});
