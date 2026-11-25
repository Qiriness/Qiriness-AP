import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarker,
  campaignId,
  diffSaleCollection,
  flattenVariants,
  fromCents,
  groupByProduct,
  groupSales,
  parseMarker,
  parsePercent,
  planApply,
  planRestore,
  salePriceCents,
  selectCollectionSaleRows,
  toCents
} from './pricing.mjs';

const APPLIED_AT = '2026-11-26T20:00:00.000Z';
const SALE = { handle: 'black-friday', percent: 20, campaign: 'black-friday-20-2026-11-26', appliedAt: APPLIED_AT };

function row(overrides = {}) {
  return {
    productId: 'gid://shopify/Product/1',
    productTitle: 'Sérum',
    productStatus: 'ACTIVE',
    variantId: 'gid://shopify/ProductVariant/11',
    variantTitle: '30 ml',
    price: '114.90',
    compareAtPrice: null,
    markerId: null,
    markerValue: null,
    ...overrides
  };
}

function markerFor({ original = 11490, compare = null, sale = 9192, handle = 'black-friday', percent = 20 } = {}) {
  return buildMarker({
    campaign: `${handle}-${percent}-2026-11-26`,
    handle,
    percent,
    originalCents: original,
    originalCompareCents: compare,
    saleCents: sale,
    appliedAt: APPLIED_AT
  });
}

test('cents conversion is exact both ways', () => {
  assert.equal(toCents('114.90'), 11490);
  assert.equal(toCents('0.29'), 29);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(null), null);
  assert.equal(fromCents(11490), '114.90');
  assert.equal(fromCents(5), '0.05');
  assert.equal(fromCents(null), null);
  assert.throws(() => toCents('abc'));
  assert.throws(() => toCents('-1'));
});

test('sale price uses the theme promo rounding: price - round(price * X / 100)', () => {
  assert.equal(salePriceCents(11490, 20), 9192);
  assert.equal(salePriceCents(11490, 30), 8043); // 114.90 at 30 % -> 80.43 (Alpha Sale's figure)
  assert.equal(salePriceCents(4990, 15), 4241); // 748.5 rounds up to 749
  assert.equal(salePriceCents(1000, 50), 500);
});

test('percent must be a whole number from 1 to 90', () => {
  assert.equal(parsePercent('20'), 20);
  for (const bad of ['0', '91', '12.5', 'abc', '']) assert.throws(() => parsePercent(bad));
});

test('campaign id is handle-percent-date', () => {
  assert.equal(
    campaignId({ handle: 'black-friday', percent: 20, date: new Date('2026-11-26T22:00:00Z') }),
    'black-friday-20-2026-11-26'
  );
});

test('apply: price drops, compare-at becomes the old price, marker keeps both originals', () => {
  const { changes, skipped } = planApply([row()], SALE);
  assert.equal(skipped.length, 0);
  assert.equal(changes.length, 1);
  const [change] = changes;
  assert.equal(change.priceCents, 11490);
  assert.equal(change.saleCents, 9192);
  assert.equal(change.compareCents, null);
  const marker = parseMarker(change.marker);
  assert.equal(marker.originalCents, 11490);
  assert.equal(marker.originalCompareCents, null);
  assert.equal(marker.saleCents, 9192);
  assert.equal(marker.collection, 'black-friday');
  assert.equal(marker.percent, 20);
});

test('apply: a compare-at equal to the price is kept as the original and not treated as reduced', () => {
  const { changes } = planApply([row({ compareAtPrice: '114.90' })], SALE);
  assert.equal(changes.length, 1);
  assert.equal(parseMarker(changes[0].marker).originalCompareCents, 11490);
});

test('apply: skips with a reason, never stacks a second reduction', () => {
  const rows = [
    row({ variantId: 'v-reduced', compareAtPrice: '150.00' }),
    row({ variantId: 'v-draft', productStatus: 'DRAFT' }),
    row({ variantId: 'v-zero', price: '0.00' }),
    row({ variantId: 'v-this', markerValue: markerFor() }),
    row({ variantId: 'v-other', markerValue: markerFor({ handle: 'soldes', percent: 30 }) }),
    row({ variantId: 'v-broken', markerValue: '{not json' }),
    row({ variantId: 'v-tiny', price: '0.01' })
  ];
  const { changes, skipped } = planApply(rows, SALE);
  assert.equal(changes.length, 0);
  assert.deepEqual(
    Object.fromEntries(skipped.map((s) => [s.variantId, s.reason])),
    {
      'v-reduced': 'already_reduced',
      'v-draft': 'not_active',
      'v-zero': 'zero_price',
      'v-this': 'on_this_sale',
      'v-other': 'on_other_sale',
      'v-broken': 'unreadable_marker',
      'v-tiny': 'no_change'
    }
  );
});

test('apply: --include-drafts lets draft products through', () => {
  const { changes } = planApply([row({ productStatus: 'DRAFT' })], { ...SALE, includeDrafts: true });
  assert.equal(changes.length, 1);
});

test('apply re-run after an interruption: marked variants are skipped, unmarked ones applied once', () => {
  const first = planApply([row({ variantId: 'a' }), row({ variantId: 'b' })], SALE);
  // Simulate: "a" was written (now on sale price with marker), "b" was not.
  const afterCrash = [
    row({ variantId: 'a', price: '91.92', compareAtPrice: '114.90', markerValue: first.changes[0].marker }),
    row({ variantId: 'b' })
  ];
  const second = planApply(afterCrash, SALE);
  assert.deepEqual(second.changes.map((c) => c.variantId), ['b']);
  assert.equal(second.changes[0].saleCents, 9192);
  assert.deepEqual(second.skipped.map((s) => s.reason), ['on_this_sale']);
});

test('restore: unchanged sale price goes back exactly, including "no compare-at"', () => {
  const { restores, conflicts, cleanups } = planRestore([
    row({ price: '91.92', compareAtPrice: '114.90', markerId: 'm1', markerValue: markerFor() })
  ]);
  assert.equal(conflicts.length, 0);
  assert.equal(cleanups.length, 0);
  assert.equal(restores.length, 1);
  assert.equal(restores[0].targetCents, 11490);
  assert.equal(restores[0].targetCompareCents, null);
});

test('restore: an original compare-at is put back too', () => {
  const marker = markerFor({ original: 10000, compare: 10000, sale: 8000 });
  const { restores } = planRestore([row({ price: '80.00', compareAtPrice: '100.00', markerValue: marker })]);
  assert.equal(restores[0].targetCents, 10000);
  assert.equal(restores[0].targetCompareCents, 10000);
});

test('restore: a price edited by hand is a conflict, and only --force restores it', () => {
  const edited = row({ price: '85.00', compareAtPrice: '114.90', markerValue: markerFor() });
  const normal = planRestore([edited]);
  assert.equal(normal.restores.length, 0);
  assert.equal(normal.conflicts.length, 1);
  assert.equal(normal.conflicts[0].currentCents, 8500);

  const forced = planRestore([edited], { force: true });
  assert.equal(forced.conflicts.length, 0);
  assert.equal(forced.restores.length, 1);
  assert.equal(forced.restores[0].forced, true);
  assert.equal(forced.restores[0].targetCents, 11490);
});

test('restore: already back at the original price only needs the marker removed', () => {
  const { cleanups, restores } = planRestore([row({ price: '114.90', compareAtPrice: null, markerValue: markerFor() })]);
  assert.equal(restores.length, 0);
  assert.equal(cleanups.length, 1);
});

test('restore: unmarked variants are ignored and unreadable markers are never touched', () => {
  const plan = planRestore([row(), row({ variantId: 'x', markerValue: '"oops"' })]);
  assert.equal(plan.restores.length + plan.cleanups.length + plan.conflicts.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['unreadable_marker']);
});

test('flatten + group: one row per variant, grouped by product in order', () => {
  const rows = flattenVariants([
    { id: 'p1', title: 'A', status: 'ACTIVE', variants: [{ id: 'v1', title: 'S', price: '10.00', compareAtPrice: null, metafield: null }, { id: 'v2', title: 'M', price: '12.00', compareAtPrice: null, metafield: { id: 'm', value: '{}' } }] },
    { id: 'p2', title: 'B', status: 'DRAFT', variants: [{ id: 'v3', title: 'Default', price: '5.00', compareAtPrice: '6.00', metafield: null }] }
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].markerId, 'm');
  const groups = groupByProduct(rows);
  assert.deepEqual([...groups.keys()], ['p1', 'p2']);
  assert.equal(groups.get('p1').length, 2);
});

// --- a sale = collection + percent -----------------------------------------------

function markerOn({ handle = 'black-friday', percent = 20, original = 11490, sale = 9192, appliedAt = APPLIED_AT } = {}) {
  return buildMarker({
    campaign: `${handle}-${percent}-${appliedAt.slice(0, 10)}`,
    handle,
    percent,
    originalCents: original,
    originalCompareCents: null,
    saleCents: sale,
    appliedAt
  });
}

test('groupSales: re-applying the same collection and % on another day is ONE sale', () => {
  const sales = groupSales([
    row({ variantId: 'a', price: '91.92', markerValue: markerOn({ appliedAt: '2026-11-26T20:00:00.000Z' }) }),
    row({ variantId: 'b', price: '91.92', markerValue: markerOn({ appliedAt: '2026-11-27T09:00:00.000Z' }) }),
    row({ variantId: 'c', price: '80.43', markerValue: markerOn({ percent: 30, sale: 8043 }) }),
    row({ variantId: 'd', price: '85.00', markerValue: markerOn() }),
    row({ variantId: 'e', price: '114.90', markerValue: markerOn() }),
    row({ variantId: 'f', price: '10.00', markerValue: 'not json' }),
    row({ variantId: 'g' })
  ]);
  const bf20 = sales.find((s) => s.key === 'black-friday::20');
  assert.equal(bf20.rows.length, 4);
  assert.deepEqual(bf20.campaigns, ['black-friday-20-2026-11-26', 'black-friday-20-2026-11-27']);
  assert.equal(bf20.firstAppliedAt, '2026-11-26T20:00:00.000Z');
  assert.equal(bf20.lastAppliedAt, '2026-11-27T09:00:00.000Z');
  assert.deepEqual(bf20.counts, { onSale: 2, edited: 1, back: 1 });
  assert.ok(sales.find((s) => s.key === 'black-friday::30'), 'a different % is a different sale');
  assert.equal(sales.find((s) => s.key === '(unreadable)').rows.length, 1);
  assert.equal(sales.length, 3, 'unmarked rows are ignored');
  assert.equal(sales[0].key, 'black-friday::20', 'newest first');
});

test('selectCollectionSaleRows: restore by collection follows the markers, not the members', () => {
  const rows = [
    row({ productId: 'p-in', variantId: 'in', markerValue: markerOn() }),
    row({ productId: 'p-left', variantId: 'left', markerValue: markerOn() }),
    row({ productId: 'p-other', variantId: 'other', markerValue: markerOn({ handle: 'soldes-hiver', percent: 30 }) }),
    row({ productId: 'p-elsewhere', variantId: 'elsewhere', markerValue: markerOn({ handle: 'soldes-hiver' }) })
  ];
  const { ofCollection, otherSales } = selectCollectionSaleRows(rows, {
    handle: 'black-friday',
    collectionProductIds: ['p-in', 'p-other']
  });
  assert.deepEqual(ofCollection.map((r) => [r.variantId, r.removedFromCollection]), [['in', false], ['left', true]]);
  assert.deepEqual(otherSales.map((r) => [r.variantId, r.otherSale]), [['other', 'soldes-hiver (-30 %)']]);
});

test('diffSaleCollection: products added since the sale are planned, products removed are listed', () => {
  const sale = groupSales([
    row({ productId: 'p1', variantId: 'v1', price: '91.92', markerValue: markerOn() }),
    row({ productId: 'p-gone', variantId: 'v-gone', price: '91.92', markerValue: markerOn() })
  ])[0];
  const collectionProducts = [
    { id: 'p1', title: 'Old', status: 'ACTIVE', variants: [{ id: 'v1', title: 'S', price: '91.92', compareAtPrice: '114.90', metafield: { id: 'm', value: markerOn() } }] },
    { id: 'p-new', title: 'New', status: 'ACTIVE', variants: [{ id: 'v-new', title: 'S', price: '50.00', compareAtPrice: null, metafield: null }] },
    { id: 'p-draft', title: 'Draft', status: 'DRAFT', variants: [{ id: 'v-draft', title: 'S', price: '20.00', compareAtPrice: null, metafield: null }] }
  ];
  const diff = diffSaleCollection({ sale, collectionProducts, appliedAt: APPLIED_AT, date: new Date('2026-11-27T10:00:00Z') });
  assert.equal(diff.collectionMissing, false);
  assert.deepEqual(diff.added.changes.map((c) => [c.variantId, c.saleCents]), [['v-new', 4000]]);
  assert.equal(parseMarker(diff.added.changes[0].marker).campaign, 'black-friday-20-2026-11-27');
  assert.deepEqual(diff.added.skipped.map((s) => [s.variantId, s.reason]), [['v-draft', 'not_active']]);
  assert.deepEqual(diff.removed.map((r) => r.variantId), ['v-gone']);
});

test('diffSaleCollection: a deleted collection leaves every product of the sale as removed', () => {
  const sale = groupSales([row({ variantId: 'v1', price: '91.92', markerValue: markerOn() })])[0];
  const diff = diffSaleCollection({ sale, collectionProducts: null, appliedAt: APPLIED_AT });
  assert.equal(diff.collectionMissing, true);
  assert.equal(diff.added.changes.length, 0);
  assert.deepEqual(diff.removed.map((r) => r.variantId), ['v1']);
});
