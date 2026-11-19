import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarker,
  campaignId,
  flattenVariants,
  fromCents,
  groupByProduct,
  parseMarker,
  parsePercent,
  planApply,
  planRestore,
  salePriceCents,
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
