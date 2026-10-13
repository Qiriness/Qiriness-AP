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

test('only a paid, kept, still-sold purchase is asked about, and one per conversation', () => {
  const items = purchaseItems(summary([1, { free_gift: true }], [2, { returned: true }], [9], [3]), CATALOGUE);
  assert.equal(purchaseToAsk(items, emptyPurchaseState()).product_id, ID(3));
  assert.equal(MAX_PURCHASE_QUESTIONS, 1);
  assert.equal(purchaseToAsk(items, { ...emptyPurchaseState(), asked: [ID(1)] }), null);
});

test('same day: the one bought most often, then the more expensive', () => {
  const priced = { products: CATALOGUE.products.map((p, i) => ({ ...p, variants: [{ price: [20, 45, 30][i] }, { price: 99 }] })) };
  const items = purchaseItems(summary([1, { times_purchased: 2 }], [2, { times_purchased: 2 }], [3, { times_purchased: 1 }]), priced);
  assert.equal(purchaseToAsk(items, emptyPurchaseState()).product_id, ID(2));
  assert.equal(purchaseToAsk(items.filter((i) => i.product_id !== ID(2)), emptyPurchaseState()).product_id, ID(1));
  const sameCount = purchaseItems(summary([1], [3]), priced);
  assert.equal(purchaseToAsk(sameCount, emptyPurchaseState()).product_id, ID(3));
  const newer = purchaseItems(summary([1, { last_purchased_on: '2026-09-20' }], [2, { times_purchased: 5 }]), priced);
  assert.equal(purchaseToAsk(newer, emptyPurchaseState()).product_id, ID(1));
  assert.ok(!('price' in describePurchases(items, emptyPurchaseState()).purchases[0]));
});

test('the three builder choices in the customer language, values the agent can parse back', () => {
  const [item] = purchaseItems(summary([1]), CATALOGUE);
  assert.deepEqual(purchaseChoices(item, 'fr').map((c) => c.label), ['Construire ma routine autour', "Il m'en reste peu", 'Me concentrer sur ma préoccupation']);
  assert.deepEqual(purchaseChoices(item, 'en').map((c) => c.label), ['Build my routine around it', "I'm running low", 'Focus on my concern']);
  assert.deepEqual(parsePurchaseChoice(purchaseChoices(item, 'en')[1].value), { answer: 'running_low', productId: ID(1) });
  assert.equal(parsePurchaseChoice('purchase:using:' + ID(1)), null);
  assert.equal(parsePurchaseChoice('profile:skin_type:dry'), null);
});

test('an answer moves a product to one list and marks it asked', () => {
  let s = recordAnswer(emptyPurchaseState(), { answer: 'around', productId: ID(1) });
  s = recordAnswer(s, { answer: 'running_low', productId: ID(1) });
  assert.deepEqual(s, { asked: [ID(1)], around: [], running_low: [ID(1)], focus: [] });
});

test('state from the log is re-checked; a session from before reads « still using » as « around »', () => {
  assert.deepEqual(cleanPurchaseState({ asked: [ID(1), 'x', 3, ID(1)], around: 'nope' }), { asked: [ID(1)], around: [], running_low: [], focus: [] });
  assert.deepEqual(cleanPurchaseState({ asked: [ID(2)], using: [ID(2)], finished: [ID(3)] }), { asked: [ID(2)], around: [ID(2)], running_low: [], focus: [] });
  assert.deepEqual(cleanPurchaseState(null), emptyPurchaseState());
});

test('the prompt view holds names, days, counts and flags only; the question is not in it', () => {
  const items = purchaseItems(summary([1], [2, { free_gift: true }], [9]), CATALOGUE);
  const view = describePurchases(items, { ...emptyPurchaseState(), around: [ID(1)] }, { answered: items[0] });
  assert.deepEqual(view, {
    purchases: [
      { name: 'Produit 1', last_purchased_on: '2026-09-01', times_purchased: 1, customer_said: 'build_around' },
      { name: 'Produit 2', last_purchased_on: '2026-09-01', times_purchased: 1, free_gift: true },
      { name: 'Ligne 9', last_purchased_on: '2026-09-01', times_purchased: 1, no_longer_sold: true },
    ],
    just_answered: { name: 'Produit 1', customer_said: 'build_around' },
  });
});
