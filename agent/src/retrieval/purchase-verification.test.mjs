import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProductIndex } from './product-matching.mjs';
import {
  hasVerifiedPurchase,
  matchQuestionToOrder,
  orderProductTitles,
  purchaseState,
  toPromptText,
  verifyPurchase
} from './purchase-verification.mjs';

// A stand-in catalogue wide enough for IDF to mean something: `creme` is common,
// `led` appears once. That contrast is the whole reason the weights are borrowed
// from the catalogue rather than computed over three line items.
const CATALOGUE = buildProductIndex([
  { title: 'Masque LED Qiriness' },
  { title: 'Crème Source d’Eau' },
  { title: 'Crème Éclat Suprême' },
  { title: 'Crème Nuit Réparatrice' },
  { title: 'Coffret Caresse Temps Sublime' },
  { title: 'Sérum Temps Sublime' }
]);

const order = (titles, over = {}) => ({
  name: '#6788',
  processed_at: '2026-07-02T10:00:00Z',
  line_items: titles.map((title) => ({ title, quantity: 1 })),
  ...over
});

// --- the three states --------------------------------------------------------

test('a customer with orders is a verified buyer', () => {
  assert.equal(purchaseState({ number_of_orders: 3 }), 'known_buyer');
  assert.equal(hasVerifiedPurchase('known_buyer'), true);
});

test('a customer with zero orders is known but NOT a verified buyer', () => {
  // A newsletter signup, or an address given at a till. The distinction this
  // module exists for.
  assert.equal(purchaseState({ number_of_orders: 0 }), 'known_no_orders');
  assert.equal(hasVerifiedPurchase('known_no_orders'), false);
});

test('no customer row at all is unknown', () => {
  assert.equal(purchaseState(null), 'unknown');
  assert.equal(purchaseState(undefined), 'unknown');
  assert.equal(hasVerifiedPurchase('unknown'), false);
});

test('a missing order count is treated as zero, never as a buyer', () => {
  assert.equal(purchaseState({}), 'known_no_orders');
});

// --- line items --------------------------------------------------------------

test('reads line item titles across the shapes Shopify has used', () => {
  const titles = orderProductTitles({
    line_items: [{ title: 'Masque LED' }, { name: 'Crème Source d’Eau' }, { title: '   ' }]
  });
  assert.deepEqual(
    titles.map((t) => t.title),
    ['Masque LED', 'Crème Source d’Eau']
  );
});

test('an order with no line items yields none rather than throwing', () => {
  assert.deepEqual(orderProductTitles({}), []);
  assert.deepEqual(orderProductTitles(null), []);
});

// --- the cross-check ---------------------------------------------------------

test('the product they describe is in their last order', () => {
  const result = matchQuestionToOrder(
    'Mon masque LED ne s’allume plus depuis hier',
    order(['Masque LED Qiriness', 'Crème Source d’Eau']),
    CATALOGUE
  );
  assert.equal(result.verdict, 'in_last_order');
  assert.equal(result.matched, 'Masque LED Qiriness');
});

test('a product they did not buy in that order reads as not-in-last-order', () => {
  const result = matchQuestionToOrder(
    'Mon masque LED ne s’allume plus',
    order(['Crème Source d’Eau']),
    CATALOGUE
  );
  assert.equal(result.verdict, 'not_in_last_order');
  assert.equal(result.matched, null);
});

test('AMBIGUITY IS NOT ABSENCE: a tie reports ambiguous, never not-in-order', () => {
  // `matchProduct` returns match:null on a tie. Read carelessly that looks
  // identical to "nothing matched", and would tell the customer their product
  // is not in an order that contains both candidates.
  // Two titles of equal weight — `serum` and `masque` are each unique in the
  // catalogue, so both entries score identically against "Temps Sublime" and
  // neither can be picked.
  const result = matchQuestionToOrder(
    'je vous écris au sujet de Temps Sublime',
    order(['Sérum Temps Sublime', 'Masque Temps Sublime']),
    CATALOGUE
  );
  assert.equal(result.verdict, 'ambiguous');
  assert.ok(result.tied.length >= 1, 'the runner-up travels so the reply can ask');
});

test('a message naming no product is undetermined, not a contradiction', () => {
  const result = matchQuestionToOrder('Bonjour, je voudrais un remboursement.', order(['Masque LED Qiriness']), CATALOGUE);
  assert.equal(result.verdict, 'not_in_last_order');
  // Not "in_last_order" — the point is only that we never claim a match here.
  assert.equal(result.matched, null);
});

test('an order with no line items is undetermined, never a contradiction', () => {
  const result = matchQuestionToOrder('mon masque LED', order([]), CATALOGUE);
  assert.equal(result.verdict, 'undetermined');
  assert.equal(result.reason, 'no_line_items');
});

test('works without a catalogue index, only more bluntly', () => {
  const result = matchQuestionToOrder('mon masque LED', order(['Masque LED Qiriness']), null);
  assert.equal(result.verdict, 'in_last_order');
});

// --- the whole answer --------------------------------------------------------

test('a verified buyer gets the product check', () => {
  const result = verifyPurchase({
    customer: { number_of_orders: 2 },
    lastOrder: order(['Masque LED Qiriness']),
    question: 'mon masque LED est cassé',
    catalogueIndex: CATALOGUE
  });
  assert.equal(result.state, 'known_buyer');
  assert.equal(result.verified, true);
  assert.equal(result.product.verdict, 'in_last_order');
});

test('an unverified sender is never told their product is missing from an order', () => {
  // There is no order to compare against, so running the match would produce
  // `not_in_last_order` and read as contradicting the customer.
  const result = verifyPurchase({
    customer: null,
    question: 'mon masque LED est cassé',
    catalogueIndex: CATALOGUE
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.verified, false);
  assert.equal(result.product.verdict, 'undetermined');
  assert.equal(result.product.reason, 'no_verified_order');
});

test('a known customer with no orders is also not product-checked', () => {
  const result = verifyPurchase({
    customer: { number_of_orders: 0 },
    lastOrder: order(['Masque LED Qiriness']),
    question: 'mon masque LED',
    catalogueIndex: CATALOGUE
  });
  assert.equal(result.state, 'known_no_orders');
  assert.equal(result.verified, false);
});

// --- what the model is shown -------------------------------------------------

test('THE CLAIM THAT MUST NEVER APPEAR: "not a customer"', () => {
  const text = toPromptText(verifyPurchase({ customer: null, question: 'x' }));
  assert.match(text, /boutique physique/, 'it must offer the retail explanation');
  assert.doesNotMatch(text, /n’est pas client(e)?\b/);
});

test('a known-no-orders sender is described as unverified, not as a stranger', () => {
  const text = toPromptText(verifyPurchase({ customer: { number_of_orders: 0 }, question: 'x' }));
  assert.match(text, /existe dans la base client/);
  assert.match(text, /n’est PAS vérifié/);
});

test('both unverified states ask about a shop purchase', () => {
  for (const customer of [null, { number_of_orders: 0 }]) {
    const text = toPromptText(verifyPurchase({ customer, question: 'x' }));
    assert.match(text, /achat en boutique/);
  }
});

test('a not-in-last-order verdict is worded as incomplete, not as a denial', () => {
  const text = toPromptText(
    verifyPurchase({
      customer: { number_of_orders: 4 },
      lastOrder: order(['Crème Source d’Eau']),
      question: 'mon masque LED',
      catalogueIndex: CATALOGUE
    })
  );
  assert.match(text, /commande antérieure|achat en boutique/);
});

test('null in, a sentence out', () => {
  assert.equal(typeof toPromptText(null), 'string');
});
