import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCollectionRow } from './shopify-collection-mapper.mjs';

const NODE = {
  id: 'gid://shopify/Collection/1',
  handle: 'diag-rides-et-ridules',
  title: 'Diag - Rides et ridules',
  updatedAt: '2026-09-01T00:00:00Z',
  productsCount: { count: 19 }
};

test('it maps the columns Shopify owns', () => {
  const row = mapCollectionRow(NODE, 'shop-1', '2026-09-16T10:00:00Z');
  assert.equal(row.shop_id, 'shop-1');
  assert.equal(row.shopify_collection_id, 'gid://shopify/Collection/1');
  assert.equal(row.handle, 'diag-rides-et-ridules');
  assert.equal(row.title, 'Diag - Rides et ridules');
  assert.equal(row.products_count, 19);
  assert.equal(row.synced_at, '2026-09-16T10:00:00Z');
});

test('the mapper never writes the columns the team owns', () => {
  // THE REGRESSION THIS EXISTS FOR. The upsert merges on
  // (shop_id, shopify_collection_id) and leaves absent columns alone, so these
  // survive a sync only by never appearing in the payload. A nightly run that
  // reset them would un-activate every curated collection and quietly stop the
  // agent recommending anything — nothing would fail, and nobody would be told.
  //
  // Same assertion `shopify-product-mapper-legacy.test.mjs` makes for
  // `recommended_for_concerns`, for the same reason.
  const row = mapCollectionRow(NODE, 'shop-1', '2026-09-16T10:00:00Z');
  for (const column of ['is_active', 'axis', 'note', 'product_ids', 'products_synced_at']) {
    assert.ok(!(column in row), `the sync would overwrite ${column}`);
  }
});

test('a collection that came back is not deleted', () => {
  // Set explicitly rather than omitted: a collection restored in Shopify has to
  // come back here too, and an omitted column would leave the tombstone on.
  assert.equal(mapCollectionRow(NODE, 'shop-1', 'now').deleted_at, null);
});

test('a missing count is null, never zero', () => {
  // Zero is a claim — "this collection is empty" — and an absent `productsCount`
  // is not that claim. The curation screen shows the count to help somebody
  // judge whether a collection is worth switching on.
  assert.equal(mapCollectionRow({ ...NODE, productsCount: null }, 's', 'now').products_count, null);
  assert.equal(mapCollectionRow({ ...NODE, productsCount: {} }, 's', 'now').products_count, null);
  assert.equal(mapCollectionRow({ ...NODE, productsCount: { count: 0 } }, 's', 'now').products_count, 0);
});
