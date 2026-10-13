import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PURCHASE_QUESTIONS,
  cleanPurchaseState,
  describePurchases,
  emptyPurchaseState,
  mentionsPastPurchase,
  parsePurchaseChoice,
  purchaseChoices,
  purchaseItems,
  purchaseToAsk,
  recordAnswer,
} from './purchase-turn.mjs';

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const CATALOGUE = { products: [1, 2, 3].map((n) => ({ id: ID(n), shopifyId: `gid://shopify/Product/${n}`, name: `Produit ${n}` })) };
const summary = (...rows) => ({ products: rows.map(([n, over = {}]) => ({ product_id: `gid://shopify/Product/${n}`, title: `Ligne ${n}`, last_purchased_on: '2026-09-01', first_purchased_on: '2026-09-01', times_purchased: 1, free_gift: false, returned: false, ...over })) });

test('a message about past purchases is recognised in French and English; others are not', () => {
  for (const m of ["J'ai acheté le sérum le mois dernier", 'Je voudrais racheter mon sérum', 'ma dernière commande', 'I bought the cream last time', 'Can I reorder my serum?', 'my previous orders']) {
    assert.ok(mentionsPastPurchase(m), m);
  }
  for (const m of ['Livrez-vous en Belgique ?', 'Do you ship to Belgium?', 'Quel sérum pour peau sèche ?', 'What serum for dry skin?']) {
    assert.ok(!mentionsPastPurchase(m), m);
  }
});

test('items take the catalogue name and id when the product is still sold', () => {
  const items = purchaseItems(summary([1], [9]), CATALOGUE);
  assert.deepEqual(items.map((i) => [i.product_id, i.name, i.in_catalogue]), [[ID(1), 'Produit 1', true], [null, 'Ligne 9', false]]);
});

test('only a paid, kept, still-sold purchase is asked about; never twice; at most two per conversation', () => {
  const items = purchaseItems(summary([1, { free_gift: true }], [2, { returned: true }], [9], [3]), CATALOGUE);
  assert.equal(purchaseToAsk(items, emptyPurchaseState()).product_id, ID(3));
  assert.equal(purchaseToAsk(items, { ...emptyPurchaseState(), asked: [ID(3)] }), null);
  const many = purchaseItems(summary([1], [2], [3]), CATALOGUE);
  assert.equal(purchaseToAsk(many, { ...emptyPurchaseState(), asked: [ID(1)] }).product_id, ID(2));
  assert.equal(purchaseToAsk(many, { ...emptyPurchaseState(), asked: [ID(1), ID(2)].slice(0, MAX_PURCHASE_QUESTIONS) }), null);
});

test('chips in the customer language, values the agent can parse back', () => {
  const [item] = purchaseItems(summary([1]), CATALOGUE);
  assert.deepEqual(purchaseChoices(item, 'fr').map((c) => c.label), ["Je l'utilise encore", "Je l'ai terminé", "C'était un cadeau"]);
  assert.deepEqual(purchaseChoices(item, 'en').map((c) => c.label), ['Still using it', "I've finished it", 'It was a gift']);
  assert.deepEqual(parsePurchaseChoice(purchaseChoices(item, 'en')[0].value), { answer: 'using', productId: ID(1) });
  assert.equal(parsePurchaseChoice('purchase:love:' + ID(1)), null);
  assert.equal(parsePurchaseChoice('profile:skin_type:dry'), null);
});

test('an answer moves a product to one list and marks it asked', () => {
  let s = recordAnswer(emptyPurchaseState(), { answer: 'using', productId: ID(1) });
  s = recordAnswer(s, { answer: 'finished', productId: ID(1) });
  assert.deepEqual(s, { asked: [ID(1)], using: [], finished: [ID(1)], gift: [] });
});

test('state from the log is re-checked', () => {
  assert.deepEqual(cleanPurchaseState({ asked: [ID(1), 'x', 3, ID(1)], using: 'nope' }), { asked: [ID(1)], using: [], finished: [], gift: [] });
  assert.deepEqual(cleanPurchaseState(null), emptyPurchaseState());
});

test('the prompt view holds names, days, counts and flags only', () => {
  const items = purchaseItems(summary([1], [2, { free_gift: true }], [9]), CATALOGUE);
  const view = describePurchases(items, { ...emptyPurchaseState(), using: [ID(1)] }, { ask: items[0] });
  assert.deepEqual(view, {
    purchases: [
      { name: 'Produit 1', last_purchased_on: '2026-09-01', times_purchased: 1, customer_said: 'still_using' },
      { name: 'Produit 2', last_purchased_on: '2026-09-01', times_purchased: 1, free_gift: true },
      { name: 'Ligne 9', last_purchased_on: '2026-09-01', times_purchased: 1, no_longer_sold: true },
    ],
    ask_about: 'Produit 1',
  });
});
