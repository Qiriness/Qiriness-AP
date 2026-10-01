import assert from 'node:assert/strict';
import test from 'node:test';

import { collectionIdsOfPromotions } from './sync-shopify-collections.mjs';

test('the collections an active promotion is scoped to, on either leg, once each', () => {
  // « 3+1 Offert » buys and gets from « Masques Monodose »: one collection, listed once.
  const monodose = 'gid://shopify/Collection/474641695002';
  const ids = collectionIdsOfPromotions([
    {
      rule_snapshot: {
        customer_buys: { items: { scope: 'collections', collections: [{ id: monodose }] } },
        customer_gets: { items: { scope: 'collections', collections: [{ id: monodose }] } }
      }
    },
    { rule_snapshot: { customer_gets: { items: { scope: 'products', products: [{ id: 'gid://shopify/Product/1' }] } } } },
    { rule_snapshot: {} },
    null
  ]);
  assert.deepEqual(ids, [monodose]);
});
