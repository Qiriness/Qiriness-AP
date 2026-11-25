import assert from 'node:assert/strict';
import test from 'node:test';

import { priceBand, scoreOpportunities, segmentOf } from './website-opportunities.mjs';

const page = (path, type, sessions, converted, extra = {}) => ({
  path,
  type,
  sessions,
  convertedSessions: converted,
  cartSessions: extra.cart ?? converted * 5,
  ...extra
});

test('price bands keep a €349 device and a €6 mask apart', () => {
  assert.equal(priceBand(6), 'under25');
  assert.equal(priceBand(349), '150plus');
  assert.equal(priceBand(null), null);
  assert.equal(segmentOf({ type: 'Product', priceBand: '150plus' }), 'product:150plus');
  assert.equal(segmentOf({ type: 'Product', priceBand: null }), null);
  assert.equal(segmentOf({ type: 'Collection', category: 'promo' }), 'collection:promo');
  assert.equal(segmentOf({ type: 'Homepage' }), 'type:Homepage');
});

test('the score is sessions x the gap to comparable pages, and the page is not its own benchmark', () => {
  const pages = [
    page('/products/big', 'Product', 3000, 36, { priceBand: '25to60' }), // 1.2%
    page('/products/peer1', 'Product', 1000, 25, { priceBand: '25to60' }), // 2.5%
    page('/products/peer2', 'Product', 1000, 25, { priceBand: '25to60' }),
    page('/products/led', 'Product', 2000, 2, { priceBand: '150plus' }) // alone in its band
  ];
  const out = scoreOpportunities(pages, { aov: 60 });
  const big = out.find((o) => o.path === '/products/big');
  assert.equal(big.benchmarkRate, 2.5);
  assert.equal(Math.round(big.potentialConversions), 39);
  assert.equal(Math.round(big.potentialRevenue), 2340);
  assert.equal(big.confidence, 'ok');
  // No other page priced like it: no benchmark, so no invented gap.
  assert.equal(out.find((o) => o.path === '/products/led'), undefined);
  assert.equal(out[0].path, '/products/big');
});

test('small pages are not scored; a thin benchmark is low confidence', () => {
  const out = scoreOpportunities(
    [page('/a', 'Homepage', 20, 0), page('/b', 'Blog Article', 150, 0, { cart: 0 }), page('/c', 'Blog Article', 150, 2, { cart: 4 })],
    { aov: null }
  );
  assert.equal(out.some((o) => o.path === '/a'), false);
  const b = out.find((o) => o.path === '/b');
  assert.equal(b.confidence, 'low'); // 150 x 1.3% = 2 expected conversions
  assert.equal(b.potentialRevenue, null);
});

test('flags: weak add to cart, paid below organic on the same page, mobile below desktop', () => {
  const pages = [page('/products/x', 'Product', 1000, 10, { priceBand: '25to60', cart: 20 }), page('/products/y', 'Product', 1000, 20, { priceBand: '25to60', cart: 150 })];
  const byGroup = new Map([
    ['/products/x', new Map([
      ['paid_social', { sessions: 600, convertedSessions: 1 }],
      ['organic_search', { sessions: 300, convertedSessions: 8 }]
    ])]
  ]);
  const byDevice = new Map([
    ['/products/x', new Map([
      ['mobile', { sessions: 800, convertedSessions: 4 }],
      ['desktop', { sessions: 200, convertedSessions: 6 }]
    ])]
  ]);
  const [x] = scoreOpportunities(pages, { aov: 50, byGroup, byDevice });
  assert.equal(x.path, '/products/x');
  assert.deepEqual(x.flags, ['lowAddToCart', 'paidBelowOrganic', 'mobileBelowDesktop']);
  assert.equal(x.slices.mobile.rate, 0.5);
});
