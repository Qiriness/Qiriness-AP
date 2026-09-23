import assert from 'node:assert/strict';
import test from 'node:test';

import { SALES_COLLECTIONS, SALES_COLLECTION_HANDLES, isSalesCollection } from './sales-collections.mjs';

test('the six ranges the owner named, by handle', () => {
  assert.equal(SALES_COLLECTIONS.length, 6);
  assert.deepEqual(
    SALES_COLLECTIONS.map((c) => c.title),
    ['Temps Sublime', 'Source d’Eau', 'Exception', 'Active Énergie', 'Eclat Parfait', 'Rituel Spa']
  );
  // The parent, not one of the four `Rituel Spa <theme>` children: it carries 24
  // products against their 5-7.
  assert.ok(SALES_COLLECTION_HANDLES.includes('rituel-spa'));
  assert.ok(!SALES_COLLECTION_HANDLES.some((h) => h.startsWith('rituel-spa-')));
});

test('handles are the key, because a title is edited and a handle is the URL', () => {
  for (const collection of SALES_COLLECTIONS) {
    assert.match(collection.handle, /^[a-z0-9-]+$/, collection.handle);
    assert.ok(collection.title.length > 0);
  }
  assert.equal(new Set(SALES_COLLECTION_HANDLES).size, SALES_COLLECTIONS.length);
});

test('membership is asked by handle, and anything else is not a sales collection', () => {
  assert.equal(isSalesCollection('rituel-spa'), true);
  assert.equal(isSalesCollection('source-deau'), true);
  // The diagnostic machinery the advice layer uses stays out of the sales card.
  assert.equal(isSalesCollection('diag-soins-hebdomadaires-rituels-7'), false);
  assert.equal(isSalesCollection(''), false);
  assert.equal(isSalesCollection(null), false);
  assert.equal(isSalesCollection(undefined), false);
});
