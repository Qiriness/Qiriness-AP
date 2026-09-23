import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRange } from './insights-range.mjs';
import {
  bucketKeyOf,
  handleFromPath,
  landingTypesQuery,
  productPagesQuery,
  readLandingTypes,
  readProductPages,
  foldSalesLadder,
  funnelSteps,
  platformOfSalesChannel,
  salesLadderQuery,
  channelSalesQuery,
  channelSessionsQuery,
  foldSeries,
  joinChannels,
  queryGrain,
  rangeClause,
  readTotals,
  seriesQuery,
  totalsQuery
} from './storefront-analytics.mjs';

// 11 Sep 2026, 14:20 in Paris (UTC+2), the clock the range tests use.
const PARIS = { tz: 'Europe/Paris', now: new Date('2026-09-11T12:20:00Z') };
const august = resolveRange({ month: '2026-08' }, PARIS);

test('UNTIL names the last day inside the range, because it is inclusive', () => {
  // August is [1 Aug, 1 Sep): the last day inside it is the 31st, not the 1st.
  assert.equal(rangeClause(august), 'SINCE 2026-08-01 UNTIL 2026-08-31');
  assert.equal(
    totalsQuery(august),
    "FROM sessions SHOW sessions, online_store_visitors, conversion_rate, pageviews, bounce_rate, " +
      "sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout " +
      "WHERE human_or_bot_session = 'human' SINCE 2026-08-01 UNTIL 2026-08-31"
  );
  assert.equal(
    salesLadderQuery(august),
    'FROM sales SHOW gross_sales, discounts, returns, net_sales, taxes, total_sales, orders, average_order_value ' +
      'GROUP BY sales_channel SINCE 2026-08-01 UNTIL 2026-08-31'
  );
  assert.equal(
    seriesQuery(august),
    "FROM sessions SHOW sessions WHERE human_or_bot_session = 'human' TIMESERIES day SINCE 2026-08-01 UNTIL 2026-08-31"
  );
  assert.equal(
    channelSessionsQuery(august),
    "FROM sessions SHOW sessions WHERE human_or_bot_session = 'human' GROUP BY referring_channel SINCE 2026-08-01 UNTIL 2026-08-31"
  );
  assert.equal(channelSalesQuery(august), 'FROM sales SHOW total_sales, orders GROUP BY referring_channel SINCE 2026-08-01 UNTIL 2026-08-31');
});

test('every sessions query filters to humans, and the sales query does not need to', () => {
  // Bots were a quarter of this store's traffic and converted at 0.23%: an
  // unfiltered figure disagrees with the admin's own screen by ~25%.
  for (const query of [totalsQuery(august), seriesQuery(august), channelSessionsQuery(august)]) {
    assert.match(query, /WHERE human_or_bot_session = 'human'/, query);
  }
  // Orders are not made by bots, and `sales` has no such dimension.
  assert.doesNotMatch(channelSalesQuery(august), /human_or_bot_session/);
});

test('a week is fetched as days, because nothing says which day ShopifyQL starts one on', () => {
  assert.equal(queryGrain('week'), 'day');
  assert.equal(queryGrain('day'), 'day');
  assert.equal(queryGrain('hour'), 'hour');
  assert.equal(queryGrain('month'), 'month');
  const sixMonths = resolveRange({ range: '6m' }, PARIS);
  assert.equal(sixMonths.grain, 'week');
  assert.match(seriesQuery(sixMonths), /TIMESERIES day /);
});

test('a percent column is a fraction, and becomes a percentage once', () => {
  const totals = readTotals([{ sessions: '1624', conversion_rate: '0.01600985221674877', pageviews: '3710', bounce_rate: '0.7315270935960592' }]);
  assert.equal(totals.sessions, 1624);
  assert.ok(Math.abs(totals.conversionRate - 1.600985221674877) < 1e-9);
  assert.equal(totals.pageviews, 3710);
  assert.ok(Math.abs(totals.bounceRate - 73.15270935960592) < 1e-9);
  // An empty window is nulls, never zeros: no session is not a conversion of 0%.
  assert.deepEqual(readTotals([]), {
    sessions: null,
    visitors: null,
    conversionRate: null,
    pageviews: null,
    bounceRate: null,
    cartSessions: null,
    checkoutSessions: null,
    convertedSessions: null
  });
});

test('an hour comes back as a UTC instant and is read on the shop clock', () => {
  // 22:00Z is midnight in Paris — the first hour of 22 September, not the last of the 21st.
  assert.equal(bucketKeyOf('2026-09-21T22:00:00Z', 'hour', 'Europe/Paris'), '2026-09-22T00:00:00');
  assert.equal(bucketKeyOf('2026-08-30', 'day', 'Europe/Paris'), '2026-08-30T00:00:00');
  assert.equal(bucketKeyOf('2024-09-01', 'month', 'Europe/Paris'), '2024-09-01T00:00:00');
  assert.equal(bucketKeyOf('', 'day', 'UTC'), null);
});

test('days fold into the weeks the chart draws, and an absent bucket stays absent', () => {
  const sixMonths = resolveRange({ range: '6m' }, PARIS);
  const firstWeek = sixMonths.keys[0];
  const rows = [
    { day: firstWeek.slice(0, 10), sessions: '10' },
    { day: nextDay(firstWeek), sessions: '5' }
  ];
  const folded = foldSeries(rows, sixMonths);
  assert.equal(folded.get(firstWeek), 15);
  // Nothing invented for the weeks nothing came back for.
  assert.equal(folded.size, 1);
  assert.equal(folded.get(sixMonths.keys[1]), undefined);
});

test('a day series keys straight onto the range buckets', () => {
  const folded = foldSeries([{ day: '2026-08-30', sessions: '352' }, { day: '2026-08-31', sessions: '150' }], august);
  assert.equal(folded.get('2026-08-30T00:00:00'), 352);
  assert.equal(folded.get('2026-08-31T00:00:00'), 150);
});

test('channels join on the one dimension both datasets share, and a one-sided channel keeps its figure', () => {
  const rows = joinChannels(
    [{ referring_channel: 'direct', sessions: '695' }, { referring_channel: 'Google', sessions: '200' }, { referring_channel: 'pinterest', sessions: '50' }],
    [{ referring_channel: 'klaviyo', total_sales: '868.37', orders: '10' }, { referring_channel: 'google', total_sales: '312.2', orders: '6' }]
  );
  const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r]));

  // Matched on the lowercased name: sessions and money meet.
  assert.equal(byChannel.google.sessions, 200);
  assert.equal(byChannel.google.orders, 6);
  assert.equal(byChannel.google.conversionRate, 3);
  assert.ok(Math.abs(byChannel.google.revenuePerSession - 1.561) < 0.001);

  // Traffic with no attributed order, and revenue the session data never saw:
  // both are findings, so neither is filled in with a zero.
  assert.equal(byChannel.pinterest.orders, null);
  assert.equal(byChannel.pinterest.conversionRate, null);
  assert.equal(byChannel.klaviyo.sessions, null);
  assert.equal(byChannel.klaviyo.conversionRate, null);
  assert.equal(byChannel.klaviyo.revenue, 868.37);

  // Busiest source first.
  assert.equal(rows[0].channel, 'direct');
  assert.equal(joinChannels([{ referring_channel: null, sessions: '3' }], [])[0].channel, 'unknown');
  assert.equal(joinChannels([{ referring_channel: 'a', sessions: '1' }, { referring_channel: 'b', sessions: '2' }], [], 1).length, 1);
});

/** The wall-clock key one day after `key`. */
function nextDay(key) {
  const d = new Date(`${key}Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test('the whole funnel is asked for, including the steps once wrongly called absent', () => {
  // `sessions_with_cart_addition` (singular) does not exist and the plural does;
  // reading that one refusal as "no funnel" was the mistake this guards.
  const query = totalsQuery(august);
  for (const metric of ['sessions_with_cart_additions', 'sessions_that_reached_checkout', 'sessions_that_completed_checkout']) {
    assert.match(query, new RegExp(metric), metric);
  }
  assert.doesNotMatch(query, /sessions_with_cart_addition[^s]/);
});

test('the funnel reads as shares of the step above and of the entry', () => {
  // August 2026, live: 4,164 sessions -> 339 carts -> 252 checkouts -> 85 orders.
  const steps = funnelSteps(readTotals([
    {
      sessions: '4164',
      online_store_visitors: '3600',
      conversion_rate: '0.0204',
      pageviews: '12359',
      bounce_rate: '0.65',
      sessions_with_cart_additions: '339',
      sessions_that_reached_checkout: '252',
      sessions_that_completed_checkout: '85'
    }
  ]));
  assert.deepEqual(steps.filter((x) => x.chained).map((x) => x.value), [4164, 339, 252, 85]);
  const chained = steps.filter((x) => x.chained);
  assert.equal(chained[0].ofPrevious, null);
  assert.ok(Math.abs(chained[1].ofPrevious - 8.1412) < 0.001);
  assert.ok(Math.abs(chained[2].ofPrevious - 74.336) < 0.001);
  // The last step over the first IS the conversion rate Shopify prints.
  assert.ok(Math.abs(chained[3].ofEntry - 2.0413) < 0.001);
});

test('product entries are drawn in the funnel but kept out of its chain', () => {
  // August 2026, live: 4,164 sessions, 2,006 of them entering on a product page,
  // and 339 carts. 339/2,006 = 16.9% would be a lie — the two do not nest.
  const steps = funnelSteps(
    readTotals([
      {
        sessions: '4164',
        sessions_with_cart_additions: '339',
        sessions_that_reached_checkout: '252',
        sessions_that_completed_checkout: '85'
      }
    ]),
    2006
  );
  assert.deepEqual(steps.map((s) => s.key), ['sessions', 'product', 'cart', 'checkout', 'purchase']);
  const product = steps[1];
  assert.equal(product.value, 2006);
  assert.equal(product.chained, false);
  assert.equal(product.ofPrevious, null);
  assert.ok(Math.abs(product.ofEntry - 48.17) < 0.01);
  // The cart step still measures against SESSIONS, skipping the product row.
  assert.ok(Math.abs(steps[2].ofPrevious - 8.1412) < 0.001);
  // And the chain still ends at the conversion rate.
  assert.ok(Math.abs(steps[4].ofEntry - 2.0413) < 0.001);
  // Nothing measured for it leaves the row empty rather than dropping it.
  assert.equal(funnelSteps(readTotals([]), null)[1].value, null);
});

test('a funnel with nothing measured stays null rather than collapsing to zero', () => {
  const steps = funnelSteps(readTotals([]));
  assert.deepEqual(steps.map((x) => x.value), [null, null, null, null, null]);
  assert.deepEqual(steps.map((x) => x.ofEntry), [null, null, null, null, null]);
});

test('the money ladder folds onto the platform filter, and AOV is recomputed not summed', () => {
  // August 2026, live: the channel split reproduces our own platform split.
  const rows = [
    { sales_channel: 'Online Store', gross_sales: '8996.4', discounts: '-1096.52', returns: '0', net_sales: '7899.88', taxes: '1629.88', total_sales: '9900.44', orders: '142', average_order_value: '55.632' },
    { sales_channel: 'Marketplace Connect', gross_sales: '273.8', discounts: '-13.85', returns: '0', net_sales: '259.95', taxes: '51.99', total_sales: '311.94', orders: '9', average_order_value: '28.883' },
    { sales_channel: 'Mirakl Connect', gross_sales: '29.9', discounts: '0', returns: '0', net_sales: '29.9', taxes: '0', total_sales: '29.9', orders: '1', average_order_value: '29.9' }
  ];

  const all = foldSalesLadder(rows, 'all');
  assert.equal(Math.round(all.totalSales * 100) / 100, 10242.28);
  assert.equal(all.orders, 152);
  // Shopify's formula: (gross - discounts) / orders, not total sales / orders.
  assert.ok(Math.abs(all.averageOrderValue - 53.87) < 0.02);
  // Discounts and returns arrive negative and are kept as magnitudes.
  assert.ok(all.discounts > 0);

  const shopify = foldSalesLadder(rows, 'shopify');
  assert.equal(shopify.totalSales, 9900.44);
  assert.equal(shopify.orders, 142);
  const amazon = foldSalesLadder(rows, 'amazon');
  assert.equal(amazon.totalSales, 311.94);
  assert.equal(foldSalesLadder(rows, 'yves_rocher').totalSales, 29.9);
  // Nothing on that platform is null, never a ladder of zeros.
  assert.equal(foldSalesLadder([], 'all'), null);
});

test('a channel nobody has mapped counts as Shopify, as the handle rule does', () => {
  assert.equal(platformOfSalesChannel('Online Store'), 'shopify');
  assert.equal(platformOfSalesChannel('Point of Sale'), 'shopify');
  assert.equal(platformOfSalesChannel('Draft Orders'), 'shopify');
  assert.equal(platformOfSalesChannel('Marketplace Connect'), 'amazon');
  assert.equal(platformOfSalesChannel('mirakl connect'), 'yves_rocher');
  assert.equal(platformOfSalesChannel(null), 'shopify');
});

test('landing pages are typed by Shopify, not matched on URL strings', () => {
  assert.equal(
    landingTypesQuery(august),
    "FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_completed_checkout " +
      "WHERE human_or_bot_session = 'human' GROUP BY landing_page_type SINCE 2026-08-01 UNTIL 2026-08-31"
  );
  const query = productPagesQuery(august, 5);
  assert.match(query, /AND landing_page_type = 'Product'/);
  assert.match(query, /GROUP BY landing_page_path ORDER BY sessions DESC LIMIT 5/);
  // Humans only here too, or the busiest "product page" is whatever the bots crawl.
  assert.match(query, /WHERE human_or_bot_session = 'human'/);
  // A limit is always a whole number, whatever it is handed.
  assert.match(productPagesQuery(august, 7.9), /LIMIT 7 /);
  assert.match(productPagesQuery(august, 0), /LIMIT 1 /);
});

test('a handle is read out of the path, so our catalogue can name the page', () => {
  assert.equal(handleFromPath('/products/uv-protect-spf-50'), 'uv-protect-spf-50');
  assert.equal(handleFromPath('/products/eau-qi?variant=42'), 'eau-qi');
  assert.equal(handleFromPath('/products/caf%C3%A9-vert'), 'café-vert');
  // Not a product page, and not a path at all.
  assert.equal(handleFromPath('/collections/source-deau'), null);
  assert.equal(handleFromPath('/'), null);
  assert.equal(handleFromPath(null), null);
});

test('landing types carry their two rates and come back busiest first', () => {
  // August 2026, live: product entries are half the traffic and convert worst.
  const rows = readLandingTypes([
    { landing_page_type: 'Homepage', sessions: '746', online_store_visitors: '603', sessions_with_cart_additions: '72', sessions_that_completed_checkout: '27' },
    { landing_page_type: 'Product', sessions: '2006', online_store_visitors: '1646', sessions_with_cart_additions: '173', sessions_that_completed_checkout: '25' }
  ]);
  assert.deepEqual(rows.map((r) => r.type), ['Product', 'Homepage']);
  assert.ok(Math.abs(rows[0].cartRate - 8.624) < 0.01);
  assert.ok(Math.abs(rows[0].conversionRate - 1.246) < 0.01);
  assert.ok(Math.abs(rows[1].conversionRate - 3.619) < 0.01);
  // A type nothing was measured for keeps nulls rather than becoming 0%.
  const empty = readLandingTypes([{ landing_page_type: 'Search', sessions: '0' }]);
  assert.equal(empty[0].cartRate, null);
  assert.equal(empty[0].conversionRate, null);
});

test('a product page carries its handle and waits for its title', () => {
  const pages = readProductPages([
    { landing_page_path: '/products/uv-protect-spf-50', sessions: '115', online_store_visitors: '98', sessions_with_cart_additions: '22' }
  ]);
  assert.equal(pages[0].handle, 'uv-protect-spf-50');
  // The service fills the title from the catalogue; the reader shows the path until then.
  assert.equal(pages[0].title, null);
  assert.equal(pages[0].sessions, 115);
  assert.ok(Math.abs(pages[0].cartRate - 19.13) < 0.01);
});
