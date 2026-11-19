import assert from 'node:assert/strict';
import test from 'node:test';

import { planApply, planRestore } from './pricing.mjs';
import { runApply, runRestore } from './runner.mjs';

/** A fake Shopify: records each call, answers like productVariantsBulkUpdate / metafieldsDelete. */
function fakeShopify({ failProduct = null, failMarkers = false } = {}) {
  const calls = [];
  const graphql = async (query, variables) => {
    if (query.includes('productVariantsBulkUpdate')) {
      calls.push({ kind: 'prices', productId: variables.productId, variants: variables.variants });
      if (variables.productId === failProduct) {
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: ['variants'], message: 'nope' }] } };
      }
      return {
        productVariantsBulkUpdate: {
          productVariants: variables.variants.map((v) => ({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice })),
          userErrors: []
        }
      };
    }
    if (query.includes('metafieldsDelete')) {
      calls.push({ kind: 'markers', ids: variables.metafields.map((m) => m.ownerId) });
      return { metafieldsDelete: { deletedMetafields: [], userErrors: failMarkers ? [{ field: null, message: 'busy' }] : [] } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  };
  return { graphql, calls };
}

const row = (productId, variantId, price, extra = {}) => ({
  productId,
  productTitle: productId,
  productStatus: 'ACTIVE',
  variantId,
  variantTitle: variantId,
  price,
  compareAtPrice: null,
  markerId: null,
  markerValue: null,
  ...extra
});

const SALE = { handle: 'bf', percent: 20, campaign: 'bf-20-2026-11-26', appliedAt: '2026-11-26T20:00:00Z' };

test('apply: one call per product, price + compare-at + marker together; a failed product is counted, not partial', async () => {
  const { changes } = planApply([row('p1', 'a', '10.00'), row('p1', 'b', '20.00'), row('p2', 'c', '30.00')], SALE);
  const { graphql, calls } = fakeShopify({ failProduct: 'p2' });
  const seen = [];
  const tally = await runApply({ graphql, changes, onProduct: (p) => seen.push([p.productId, p.ok, p.done, p.total]) });

  assert.deepEqual(tally, { applied: 2, failed: 1 });
  assert.deepEqual(seen, [['p1', true, 1, 2], ['p2', false, 2, 2]]);
  const [first] = calls;
  assert.equal(first.variants.length, 2);
  assert.deepEqual(first.variants[0].price, '8.00');
  assert.deepEqual(first.variants[0].compareAtPrice, '10.00');
  assert.equal(first.variants[0].metafields[0].namespace, 'qiriness_sale');
});

test('restore: prices first, then markers; cleanups only lose their marker', async () => {
  const applied = planApply([row('p1', 'a', '10.00'), row('p2', 'b', '50.00')], SALE).changes;
  const onSale = row('p1', 'a', '8.00', { compareAtPrice: '10.00', markerValue: applied[0].marker });
  const alreadyBack = row('p2', 'b', '50.00', { markerValue: applied[1].marker });
  const { restores, cleanups } = planRestore([onSale, alreadyBack]);

  const { graphql, calls } = fakeShopify();
  const tally = await runRestore({ graphql, restores, cleanups });

  assert.deepEqual(tally, { restored: 2, failed: 0, markersLeft: 0 });
  assert.deepEqual(calls.map((c) => c.kind), ['prices', 'markers', 'markers']);
  assert.equal(calls[0].variants[0].price, '10.00');
  assert.equal(calls[0].variants[0].compareAtPrice, null);
  assert.deepEqual(calls[2].ids, ['b']);
});

test('restore: a failed price write keeps the marker; a failed marker delete is reported as left', async () => {
  const applied = planApply([row('p1', 'a', '10.00')], SALE).changes;
  const onSale = row('p1', 'a', '8.00', { compareAtPrice: '10.00', markerValue: applied[0].marker });
  const { restores, cleanups } = planRestore([onSale]);

  const failing = fakeShopify({ failProduct: 'p1' });
  assert.deepEqual(await runRestore({ graphql: failing.graphql, restores, cleanups }), { restored: 0, failed: 1, markersLeft: 0 });
  assert.deepEqual(failing.calls.map((c) => c.kind), ['prices']);

  const stuck = fakeShopify({ failMarkers: true });
  assert.deepEqual(await runRestore({ graphql: stuck.graphql, restores, cleanups }), { restored: 1, failed: 0, markersLeft: 1 });
});
