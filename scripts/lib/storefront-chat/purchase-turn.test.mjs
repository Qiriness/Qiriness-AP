import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanPurchaseState,
  describePurchases,
  emptyPurchaseState,
  mentionsPastPurchase,
  purchaseItems,
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

test('state from the log is re-checked; a session from before reads « still using » as « around »', () => {
  assert.deepEqual(cleanPurchaseState({ asked: [ID(1), 'x', 3, ID(1)], around: 'nope' }), { asked: [ID(1)], around: [], running_low: [], focus: [] });
  assert.deepEqual(cleanPurchaseState({ asked: [ID(2)], using: [ID(2)], finished: [ID(3)] }), { asked: [ID(2)], around: [ID(2)], running_low: [], focus: [] });
  assert.deepEqual(cleanPurchaseState(null), emptyPurchaseState());
});

test('the prompt view holds names, days, counts and flags only, never a price; a session from before keeps its answer', () => {
  const items = purchaseItems(summary([1], [2, { free_gift: true }], [9]), CATALOGUE);
  const view = describePurchases(items, { ...emptyPurchaseState(), around: [ID(1)] });
  assert.deepEqual(view, {
    purchases: [
      { name: 'Produit 1', last_purchased_on: '2026-09-01', times_purchased: 1, customer_said: 'build_around' },
      { name: 'Produit 2', last_purchased_on: '2026-09-01', times_purchased: 1, free_gift: true },
      { name: 'Ligne 9', last_purchased_on: '2026-09-01', times_purchased: 1, no_longer_sold: true },
    ],
  });
});
