import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderSalesReport, reportFileName } from './sales-report.mjs';

/** A made-up month in the report's shape — dummy data, no real customer or order. */
function period(overrides = {}) {
  return {
    revenue: 10000,
    grossRevenue: 10200,
    paidOrders: 100,
    units: 250,
    discounts: 1000,
    discountedOrders: 40,
    discountedRevenue: 5000,
    fullPriceRevenue: 5000,
    measured: 98,
    over72h: 5,
    p50Hours: 22.5,
    refundedOrders: 2,
    refundedAmount: 200,
    cancelledOrders: 1,
    returnsOpened: 0,
    customers: { newCustomers: 40, returningCustomers: 50, newCustomerOrders: 42, returningCustomerOrders: 55 },
    newsletter: { subscribed: 120, unsubscribed: 20, subscribersNow: 5000 },
    sessions: 5000,
    visitors: 4300,
    conversionRate: 2,
    bounceRate: 68,
    cartSessions: 400,
    checkoutSessions: 300,
    convertedSessions: 100,
    grossSales: 11000,
    ladderDiscounts: 1000,
    ladderReturns: 0,
    netSales: 10000,
    taxes: 1800,
    shipping: 400,
    totalSales: 12200,
    shopifyOrders: 100,
    averageOrderValue: 100,
    storefrontRevenue: 9000,
    ...overrides
  };
}

function report(overrides = {}) {
  return {
    month: '2026-08',
    label: 'August 2026',
    inProgress: false,
    generatedAt: '2026-09-01T06:00:00Z',
    timezone: 'Europe/Paris',
    compare: { mom: 'July 2026', yoy: 'August 2025', six: 'the 6 months to February 2026', sixLabel: '6 months to August 2026' },
    periods: {
      current: period(),
      // 12,200 against 9,760 is +25%, and 60,000 against 50,000 is +20%.
      mom: period({ revenue: 8000, totalSales: 9760, paidOrders: 90 }),
      yoy: null,
      six: period({ revenue: 60000, totalSales: 60000, netSales: 50000, paidOrders: 600, sessions: 30000 }),
      sixPrevious: period({ revenue: 50000, totalSales: 50000, netSales: 42000, paidOrders: 500, sessions: 28000 })
    },
    trend: [
      { key: '2026-07', label: 'Jul 26', revenue: 8000, orders: 90 },
      { key: '2026-08', label: 'Aug 26', revenue: 10000, orders: 100 }
    ],
    platforms: [{ label: 'Shopify', revenue: 9000, orders: 90 }, { label: 'Amazon', revenue: 1000, orders: 10 }],
    products: [{ title: 'Crème <Test> & Co', revenue: 3000, orders: 30, units: 40, previousRevenue: 2000 }],
    promotions: [
      { name: 'Gift over €65', kind: 'automatic', target: 'LINE_ITEM', orders: 30, revenue: 4000, discount: 700, newCustomerOrders: 10 },
      { name: 'Free shipping', kind: 'automatic', target: 'SHIPPING_LINE', orders: 12, revenue: 1200, discount: 0, newCustomerOrders: 3 },
      { name: null, kind: null, target: null, orders: 58, revenue: 5000, discount: 0, newCustomerOrders: 25 }
    ],
    collections: [
      { collectionId: '1', title: 'Temps Sublime', products: 7, orders: 29, revenue: 2000, previousRevenue: 1500 },
      { collectionId: '2', title: 'Rituel Spa', products: 18, orders: 45, revenue: 1400, previousRevenue: 1400 },
      { collectionId: null, title: 'Outside these ranges', products: 30, orders: 86, revenue: 3600, previousRevenue: 4000 }
    ],
    funnel: [
      { key: 'sessions', label: 'Sessions', value: 5000, chained: true, ofEntry: 100, ofPrevious: null },
      { key: 'product', label: 'Product page entries', value: 2400, chained: false, ofEntry: 48, ofPrevious: null },
      { key: 'cart', label: 'Added to cart', value: 400, chained: true, ofEntry: 8, ofPrevious: 8 },
      { key: 'checkout', label: 'Reached checkout', value: 300, chained: true, ofEntry: 6, ofPrevious: 75 },
      { key: 'purchase', label: 'Completed checkout', value: 100, chained: true, ofEntry: 2, ofPrevious: 33.3 }
    ],
    channels: [
      { channel: 'direct', sessions: 2582, revenue: 2030.53, orders: 40, conversionRate: 1.549, revenuePerSession: 0.786 },
      { channel: 'klaviyo', sessions: null, revenue: 401.54, orders: 5, conversionRate: null, revenuePerSession: null }
    ],
    channelsBlockedReason: null,
    inventory: { items: [{ title: 'Serum X', stock: 0, unitsOut: 22, coverDays: 0, status: 'out' }], windowDays: 30, syncedAt: '2026-09-01T05:00:00Z' },
    carriers: [{ carrier: 'Colissimo', shipments: 80, p50Hours: 20, over72h: 3 }],
    signals: [{ tone: 'good', title: 'Revenue grew 25.0% vs July 2026', detail: '' }],
    ...overrides
  };
}

test('the report is one self-contained HTML document', () => {
  const html = renderSalesReport(report());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Qiriness — Sales report, August 2026<\/title>/);
  // Nothing loaded from anywhere: it has to open from an email attachment.
  assert.doesNotMatch(html, /<script src|<link |https?:\/\//);
});

test('it has the four sections and no profitability', () => {
  const html = renderSalesReport(report());
  for (const id of ['view-overview', 'view-customers', 'view-marketing', 'view-operations']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /Contribution|Product profitability|margin bridge/i);
});

test('the headline figures and both comparisons are rendered on the server', () => {
  const html = renderSalesReport(report());
  assert.match(html, /€10,000/);
  // Revenue 10,000 vs 8,000 is +25.0%; YoY has no measured period.
  assert.match(html, /<span data-cmp="mom"><span class="delta up">↑ 25\.0%<\/span><\/span><span data-cmp="yoy"><span class="delta flat">no comparison<\/span>/);
  assert.match(html, /<body data-compare="mom">/);
});

test('the whole funnel is measured, and only product views are not', () => {
  const html = renderSalesReport(report());
  assert.match(html, /Sessions<\/div><div class="kpi-value"><span data-cmp="mom">5,000<\/span>/);
  assert.match(html, /Conversion<\/div><div class="kpi-value"><span data-cmp="mom">2\.00%<\/span>/);
  // Every step of the funnel carries a number and its share of the step above.
  assert.match(html, /Added to cart<small>8\.0% from prior step<\/small><\/label>.*?<b>400<\/b><small>8\.0% of entry/);
  assert.match(html, /Reached checkout<small>75\.0% from prior step<\/small>/);
  assert.match(html, /Completed checkout<small>33\.3% from prior step<\/small>/);
  // Product ENTRIES are drawn, outside the chain and labelled as such.
  assert.match(html, /Product page entries<small>entries, not views · outside the chain<\/small>/);
  assert.match(html, /<b>2,400<\/b><small>48\.0% of entry<\/small>/);
  assert.match(html, /Product views are not measurable/);
  assert.match(html, /Every step counts sessions, not orders/);
  // What is genuinely not connected still says so.
  assert.match(html, /Klaviyo, Google Ads, Meta Ads, Instagram and TikTok are not connected yet/);
});

test("AOV is Shopify's net-based figure, and the bridge is Shopify's ladder", () => {
  const html = renderSalesReport(report());
  // 100 from the ladder, not 12,200/100 = 122 from total sales.
  assert.match(html, /AOV<\/div><div class="kpi-value"><span data-cmp="mom">€100\.00<\/span>/);
  assert.match(html, /Net sales<\/div><div class="kpi-value"><span data-cmp="mom">€10,000<\/span>/);
  // Horizontal rows now: label, bar, figure — the bars were vertical columns.
  const bars = [...html.matchAll(/<span class="bridge-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(bars, ['Total sales', 'VAT &amp; shipping', 'Net sales', 'Discounts', 'Returns', 'Gross sales']);
  assert.match(html, /<b>−€2,200<\/b>/);
  assert.match(html, /<b>\+€1,000<\/b>/);
  assert.match(html, /<b>€11,000<\/b>/);
  assert.match(html, /Reads left to right: total sales less VAT \(€1,800\) and shipping \(€400\) is net sales/);
});

test('a storefront figure that could not be read is a dash with its reason', () => {
  const html = renderSalesReport(
    report({
      periods: { current: period({ sessions: null, conversionRate: null }), mom: null, yoy: null },
      channels: [],
      channelsBlockedReason: 'Shopify Analytics could not be read: no answer in 8s'
    })
  );
  assert.match(html, /Sessions<\/div><div class="kpi-value">—<\/div><span class="delta flat">Shopify Analytics could not be read/);
  assert.match(html, /no answer in 8s/);
  assert.doesNotMatch(html, /Sessions<\/div><div class="kpi-value">0<\/div>/);
});

test('the channel table keeps a one-sided channel rather than filling it with zero', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<b>direct<\/b><\/td><td>2,582<\/td><td>€2,031<\/td><td>40<\/td><td>1\.55%<\/td>/);
  // Klaviyo revenue with no recorded sessions: dashes, not zeros.
  assert.match(html, /<b>klaviyo<\/b><\/td><td><span class="muted">—<\/span><\/td><td>€402<\/td>/);
  assert.match(html, /Revenue here is Shopify's attribution/);
});

test('the newsletter card shows gains, losses and net against both periods', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<h2>Newsletter subscribers<\/h2>/);
  assert.match(html, /<td><b>Gained<\/b><\/td><td>\+120<\/td>/);
  assert.match(html, /<td><b>Lost<\/b><\/td><td>−20<\/td>/);
  assert.match(html, /Net \+100/);
});

test('with no unsubscribe on record, the newsletter says why instead of printing zero losses', () => {
  const html = renderSalesReport(report({ periods: { current: period({ newsletter: null }), mom: null, yoy: null } }));
  assert.match(html, /Not measurable for this month/);
  // The newsletter KPI left the overview row on 2026-09-23; only the card remains.
  assert.doesNotMatch(html, /Newsletter, net/);
});

test('names from the catalogue are escaped', () => {
  const html = renderSalesReport(report());
  assert.match(html, /Crème &lt;Test&gt; &amp; Co/);
  assert.equal(escapeHtml(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;');
});

test('a shipping promotion shows "shipping" rather than a zero discount; full price comes last', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<b>Free shipping<\/b><\/td><td>€1,200<\/td><td>12<\/td><td>€100\.00<\/td><td>shipping<\/td>/);
  assert.ok(html.indexOf('No promotion (full price)') > html.indexOf('Free shipping'));
});

test('the file name carries only the month', () => {
  assert.equal(reportFileName('2026-08'), 'qiriness-sales-report-2026-08.html');
  assert.equal(reportFileName('../../x'), 'qiriness-sales-report-.html');
});

test('a negative net compares in people, and nothing against nothing is flat', () => {
  const html = renderSalesReport(
    report({
      periods: {
        current: period({ cancelledOrders: 0, newsletter: { subscribed: 77, unsubscribed: 129, subscribersNow: 10 } }),
        mom: period({ cancelledOrders: 0, newsletter: { subscribed: 183, unsubscribed: 312, subscribersNow: 10 } }),
        yoy: null
      }
    })
  );
  // −52 against −129 is 77 more people, not "+59.7%".
  assert.match(html, /<td><b>Net<\/b><\/td><td>−52<\/td><td><span class="delta up">↑ 77<\/span>/);
  assert.match(html, /Cancelled orders<\/span><strong>0<\/strong><span data-cmp="mom"><span class="delta flat">→ 0\.0%<\/span>/);
});

test('6M vs 6M switches the figures as well as the chips', () => {
  const html = renderSalesReport(report());
  // The month's figure and the six months' both render; CSS shows one.
  // Shopify's own total sales, and the six-month figure replaces it on the switch.
  assert.match(html, /Total sales<\/div><div class="kpi-value"><span data-cmp="mom">€12,200<\/span><span data-cmp="yoy">€12,200<\/span><span data-cmp="six">€60,000<\/span>/);
  // 60,000 against 50,000 is +20.0%, and it is the chip the six-month view shows.
  assert.match(html, /<span data-cmp="six"><span class="delta up">↑ 20\.0%<\/span><\/span>/);
  assert.match(html, /data-mode="six"[^>]*>6M vs 6M</);
  assert.match(html, /6 months to August 2026 vs the 6 months to February 2026/);
  // Three comparisons, one visible at a time, month-on-month by default.
  assert.match(html, /<body data-compare="mom">/);
});

test('the collection mix names the ranges and keeps what falls outside them', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<h2>Collection mix<\/h2>/);
  assert.match(html, /<b>Temps Sublime<\/b><\/td><td>€2,000<\/td>/);
  // Share is of paid product revenue, and the overlap is stated rather than summed.
  assert.match(html, /never add up to 100%/);
  assert.match(html, /<tr class="muted"><td><b>Outside these ranges<\/b>/);
  // Flat against last month reads as flat, not as missing.
  assert.match(html, /<b>Rituel Spa<\/b><\/td><td>€1,400<\/td><td>[^<]*<\/td><td><span class="delta flat">/);
});
