import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderSalesReport, reportFileName } from './sales-report.mjs';

/** A made-up period in the report's shape — dummy data, no real customer or order. */
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

const product = (title, revenue, previousRevenue) => ({ title, revenue, orders: 10, units: 12, previousRevenue });

function products(overrides = {}) {
  return {
    comparable: true,
    revenue: [product('Crème <Test> & Co', 3000, 2000), product('Sérum', 1000, 1800)],
    growth: [product('Crème <Test> & Co', 3000, 2000)],
    decline: [product('Sérum', 1000, 1800)],
    productRevenue: 4000,
    ...overrides
  };
}

const collections = () => [
  { collectionId: '1', title: 'Temps Sublime', products: 7, orders: 29, revenue: 2000, previousRevenue: 1500 },
  { collectionId: '2', title: 'Rituel Spa', products: 18, orders: 45, revenue: 1400, previousRevenue: 1400 },
  { collectionId: null, title: 'Outside these ranges', products: 30, orders: 86, revenue: 600, previousRevenue: 900 }
];

/** Twenty-four monthly buckets, so the chart has a comparison period to draw. */
const trend = () =>
  Array.from({ length: 24 }, (_, i) => ({
    key: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
    label: `M${i + 1}`,
    revenue: 1000 + i * 100,
    orders: 10 + i
  }));

function report(overrides = {}) {
  const month = period();
  return {
    month: '2026-08',
    label: 'August 2026',
    inProgress: false,
    generatedAt: '2026-09-01T06:00:00Z',
    timezone: 'Europe/Paris',
    modes: {
      mom: {
        label: 'MoM',
        currentLabel: 'August 2026',
        comparisonLabel: 'July 2026',
        offset: 1,
        period: month,
        // 12,200 against 9,760 is +25%.
        comparison: period({ revenue: 8000, totalSales: 9760, paidOrders: 90 }),
        products: products(),
        collections: collections(),
        platforms: [{ label: 'Shopify', revenue: 9000, orders: 90 }, { label: 'Amazon', revenue: 1000, orders: 10 }]
      },
      yoy: {
        label: 'YoY',
        currentLabel: 'August 2026',
        comparisonLabel: 'August 2025',
        offset: 12,
        period: month,
        comparison: null,
        products: products({ comparable: false, growth: [], decline: [] }),
        collections: collections().map((c) => ({ ...c, previousRevenue: null })),
        platforms: [{ label: 'Shopify', revenue: 9000, orders: 90 }, { label: 'Amazon', revenue: 1000, orders: 10 }]
      },
      six: {
        label: '6M on 6M',
        currentLabel: 'March 2026 – August 2026',
        comparisonLabel: 'March 2025 – August 2025',
        offset: 12,
        period: period({ revenue: 60000, totalSales: 60000, netSales: 50000, paidOrders: 600, sessions: 30000 }),
        comparison: period({ revenue: 50000, totalSales: 50000, netSales: 42000, paidOrders: 500, sessions: 28000 }),
        products: products(),
        collections: collections(),
        // The half-year leans further on Shopify than the month does.
        platforms: [{ label: 'Shopify', revenue: 57000, orders: 570 }, { label: 'Amazon', revenue: 3000, orders: 30 }]
      }
    },
    trend: trend(),
    trendMonths: 12,
    platforms: [{ label: 'Shopify', revenue: 9000, orders: 90 }, { label: 'Amazon', revenue: 1000, orders: 10 }],
    promotions: [
      { name: 'Gift over €65', kind: 'automatic', target: 'LINE_ITEM', orders: 30, revenue: 4000, discount: 700, newCustomerOrders: 10 },
      { name: 'Free shipping', kind: 'automatic', target: 'SHIPPING_LINE', orders: 12, revenue: 1200, discount: 0, newCustomerOrders: 3 },
      { name: null, kind: null, target: null, orders: 58, revenue: 5000, discount: 0, newCustomerOrders: 25 }
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

test('every comparison is rendered on the server, and each names both windows', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<body data-compare="mom">/);
  assert.match(html, /data-mode="mom" data-label="August 2026 vs July 2026"/);
  assert.match(html, /data-mode="yoy" data-label="August 2026 vs August 2025"/);
  assert.match(html, /data-mode="six" data-label="March 2026 – August 2026 vs March 2025 – August 2025"/);
  assert.match(html, />6M on 6M</);
});

test('the six-month view reports the half-year, not the month', () => {
  const html = renderSalesReport(report());
  // 12,200 for the month, 60,000 for the six months — each inside its own block.
  assert.match(html, /<div data-cmp="six">.*?€60,000/s);
  assert.match(html, /<div data-cmp="mom">.*?€12,200/s);
  // 60,000 against 50,000 is +20%.
  assert.match(html, /<div data-cmp="six">.*?↑ 20\.0%/s);
});

test('a comparison that does not exist says so rather than showing a dash', () => {
  const html = renderSalesReport(report());
  assert.match(html, /no comparison/);
  // The YoY block has no comparison period, so its growth table says why.
  assert.match(html, /No comparison with August 2025: the order history does not reach it\./);
});

test('the trend draws the compared period underneath, dotted', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<polyline class="line compare"/);
  assert.match(html, /class="dash dotted"/);
  // Twelve drawn of the twenty-four given, and the legend names both spans.
  assert.match(html, /M13 – M24/);
});

test('the whole funnel is measured, and only product views are not', () => {
  const html = renderSalesReport(report());
  assert.match(html, /Added to cart<small>8\.0% from prior step<\/small>/);
  assert.match(html, /Product viewers<small>no such metric<\/small><\/label><div class="funnel-bar blocked">/);
  assert.match(html, /Every step counts sessions, not orders/);
  assert.match(html, /Klaviyo, Google Ads, Meta Ads, Instagram and TikTok are not connected yet/);
});

test("AOV is Shopify's net-based figure, and the bridge is Shopify's ladder", () => {
  const html = renderSalesReport(report());
  assert.match(html, /AOV<\/div><div class="kpi-value">€100\.00<\/div>/);
  assert.match(html, /Net sales<\/div><div class="kpi-value">€10,000<\/div>/);
  // Horizontal rows: label, bar, figure — in the owner's reading order.
  const bars = [...html.matchAll(/<span class="bridge-label">([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 6);
  assert.deepEqual(bars, ['Total sales', 'VAT &amp; shipping', 'Net sales', 'Discounts', 'Returns', 'Gross sales']);
  assert.match(html, /<b>−€2,200<\/b>/);
  assert.match(html, /<b>\+€1,000<\/b>/);
  assert.match(html, /Reads left to right: total sales less VAT \(€1,800\) and shipping \(€400\) is net sales/);
});

test('product performance ranks by revenue, growth and declines', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<h2>Product performance<\/h2>/);
  assert.match(html, />Growth</);
  assert.match(html, />Declines</);
  // Growth in euros: +1,000 on the riser, −800 on the faller.
  assert.match(html, /Crème &lt;Test&gt; &amp; Co<\/b><\/td><td>€3,000<\/td><td class="up">\+€1,000<\/td>/);
  assert.match(html, /Sérum<\/b><\/td><td>€1,000<\/td><td class="down">−€800<\/td>/);
});

test('the customer cards follow the switch rather than always showing the month', () => {
  const html = renderSalesReport(report());
  // Each block names the window it compares with.
  assert.match(html, /<div data-cmp="yoy">[\s\S]*?vs August 2025[\s\S]*?New customers/);
  assert.match(html, /<div data-cmp="six">[\s\S]*?March 2025 – August 2025/);
  assert.match(html, /Orders per customer/);
});

test('the newsletter card shows gains, losses and net for the period selected', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<h2>Newsletter subscribers<\/h2>/);
  assert.match(html, /<td><b>Gained<\/b><\/td><td>\+120<\/td>/);
  assert.match(html, /<td><b>Lost<\/b><\/td><td>−20<\/td>/);
  assert.match(html, /Net \+100/);
});

test('with no unsubscribe on record, the newsletter says why instead of printing zero losses', () => {
  const data = report();
  for (const key of ['mom', 'yoy', 'six']) data.modes[key].period = period({ newsletter: null });
  const html = renderSalesReport(data);
  assert.match(html, /Not measurable for this period/);
  // The newsletter KPI left the overview row; only the card remains.
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

test('the channel table keeps a one-sided channel rather than filling it with zero', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<b>direct<\/b><\/td><td>2,582<\/td><td>€2,031<\/td><td>40<\/td><td>1\.55%<\/td>/);
  assert.match(html, /<b>klaviyo<\/b><\/td><td><span class="muted">—<\/span><\/td><td>€402<\/td>/);
  assert.match(html, /Revenue here is Shopify's attribution/);
});

test('the collection mix names the ranges and keeps what falls outside them', () => {
  const html = renderSalesReport(report());
  assert.match(html, /<h2>Collection mix<\/h2>/);
  assert.match(html, /<b>Temps Sublime<\/b><\/td><td>€2,000<\/td><td>50\.0%<\/td>/);
  assert.match(html, /never add up to 100%/);
  assert.match(html, /<tr class="muted"><td><b>Outside these ranges<\/b>/);
});

test('the file name carries only the month', () => {
  assert.equal(reportFileName('2026-08'), 'qiriness-sales-report-2026-08.html');
  assert.equal(reportFileName('../../x'), 'qiriness-sales-report-.html');
});

test('the sales mix reports the period the switch selects, not always the month', () => {
  const html = renderSalesReport(report());
  const mixes = [...html.matchAll(/<h2>Sales mix<\/h2>[\s\S]*?<\/article>/g)];
  assert.equal(mixes.length, 1);
  const block = mixes[0][0];
  // Three blocks, one per comparison, and the six-month one carries its own
  // split: 95% Shopify over the half-year against 90% in the month.
  assert.equal([...block.matchAll(/data-cmp="/g)].length, 3);
  const six = block.slice(block.indexOf('data-cmp="six"'));
  assert.match(six, /95%/);
  const mom = block.slice(block.indexOf('data-cmp="mom"'), block.indexOf('data-cmp="yoy"'));
  assert.match(mom, /90%/);
});

test('a window with no measured mix says so rather than drawing an empty bar', () => {
  const blank = report();
  blank.modes.six.platforms = null;
  const html = renderSalesReport(blank);
  const block = html.slice(html.indexOf('<h2>Sales mix</h2>'));
  const six = block.slice(block.indexOf('data-cmp="six"'), block.indexOf('</article>'));
  assert.match(six, /No comparison/);
  assert.match(six, /March 2026 – August 2026/);
});

test('a card that cannot follow the switch names the window it does cover', () => {
  const html = renderSalesReport(report());
  // Signals, the funnel, the channel table and promotions are read for the
  // report month alone; each says so rather than looking like it moved.
  assert.match(html, /Rule-based exceptions[^<]*always August 2026 against July 2026/);
  assert.match(html, /Stage conversion and largest leakage[^<]*August 2026 only/);
  assert.match(html, /referring_channel[^<]*August 2026 only/);
  assert.match(html, /What each promotion recorded on its orders[^<]*August 2026 only/);
});

test('the drivers card splits the same top line the KPI card reports', () => {
  const html = renderSalesReport(report());
  const mom = html.slice(html.indexOf('data-cmp="mom"'));
  // The KPI chip and the driver total are the same change, because a reader
  // comparing the two cards is entitled to one answer: 12,200 against 9,760.
  const kpi = /Total sales[\s\S]*?([↑↓])\s*([\d.]+)%/.exec(mom);
  const driver = /Total revenue change[\s\S]*?([+−])([\d.]+)%/.exec(mom);
  assert.ok(kpi && driver);
  assert.equal(kpi[2], driver[2]);
  assert.equal(kpi[1] === '↑', driver[1] === '+');
});
