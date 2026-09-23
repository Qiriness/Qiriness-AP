/**
 * The storefront figures Shopify keeps and we do not: sessions, conversion
 * rate, pageviews, bounce rate, and traffic by source. Read live through
 * ShopifyQL rather than synced into a table.
 *
 * WHY LIVE. A rate cannot be summed. Conversion for "last 30 days" is not the
 * mean of thirty daily rates, and storing daily rows would force us to
 * reconstruct it from a weighted average that is right only while nothing is
 * missing. ShopifyQL computes the exact window it is asked for, so the range
 * the reader picked is the range Shopify answers — no table, no backfill, no
 * restatement window, and no second definition of conversion to disagree with
 * Shopify's own. The precedent is `agent/src/retrieval/abandoned-checkout.mjs`:
 * fetched when a question needs it, kept in memory, never written.
 *
 * WHAT THAT COSTS, AND THE MITIGATION. The panel now depends on an external API
 * at render time. A failure renders the cards blocked with the reason, exactly
 * as a missing source does — never a zero — and the service caches for five
 * minutes, the interval the page refreshes itself at.
 *
 * HUMAN SESSIONS ONLY — see HUMAN_ONLY below. The bots are a quarter of the
 * traffic and convert at almost nothing, so an unfiltered rate reads a quarter
 * low against the admin's own screen.
 *
 * MEASURED AGAINST THE LIVE STORE 2026-09-23 (`npm run probe:analytics`):
 * `SINCE <date> UNTIL <date>` takes plain dates and UNTIL is INCLUSIVE; days
 * are cut on the shop's clock (an hour series for a Paris shop starts at
 * 22:00Z, which is 00:00 Paris), so a ShopifyQL day and a wall-clock day here
 * are the same day. Hour rows come back as UTC instants and are converted.
 *
 * Pure: query strings in, rows out. The I/O is web/lib/server/insights/analytics.ts.
 */

import { fromKey, toKey, truncate, wallClock } from './insights-range.mjs';

/**
 * The sessions columns this store answers, measured rather than assumed.
 *
 * THE FUNNEL IS HERE, and an earlier version of this file said it did not
 * exist. ShopifyQL's `parseErrors` names ONLY the invalid columns, so a query
 * mixing one wrong name with three right ones fails as a whole while naming
 * just the wrong one. `sessions_with_cart_addition` (singular) is wrong;
 * `sessions_with_cart_additions` is right, and the two checkout steps were
 * valid all along. Reading that error as "no funnel exists" put a false claim
 * into four documents and three cards. A refusal names what is absent; it never
 * enumerates what is present.
 */
export const SESSION_METRICS = Object.freeze([
  'sessions',
  'online_store_visitors',
  'conversion_rate',
  'pageviews',
  'bounce_rate',
  'sessions_with_cart_additions',
  'sessions_that_reached_checkout',
  'sessions_that_completed_checkout'
]);

/**
 * Shopify's money ladder, the one the admin's Sales report prints.
 *
 * WHY IT IS READ FROM SHOPIFY RATHER THAN COMPUTED. Our own revenue figure is
 * Shopify's `total_sales` to the cent — `sum(total_price - total_refunded)` —
 * but NET sales cannot be re-derived from the columns we store: measured over
 * August 2026, `total_price - total_tax - total_shipping_price` gives 8,048.91
 * against Shopify's 8,189.73, because our `total_shipping_price` is the price
 * before the free-shipping promotions are taken off. The 140.82 gap is exactly
 * those shipping discounts.
 *
 * AOV IS SHOPIFY'S, AND IT IS NET-BASED: `(gross_sales - discounts) / orders`,
 * confirmed twice against this store — August 8,189.73/152 = 53.88, and the 30
 * days to 23 Sep (15,874.86 - 2,450.36)/213 = 63.03, which is the figure the
 * admin shows. Dividing TOTAL sales by orders, as this dashboard first did,
 * reads about 25% high because it counts VAT and shipping as basket value.
 */
export const SALES_LADDER = Object.freeze([
  'gross_sales',
  'discounts',
  'returns',
  'net_sales',
  'taxes',
  'total_sales',
  'orders',
  'average_order_value'
]);

/**
 * The ShopifyQL `sales_channel` names that are marketplaces, so the ladder can
 * be folded onto the platform filter.
 *
 * SAME RULE AS `insights-range.mjs`: a marketplace is named, and Shopify is
 * everything else, so a new first-party channel lands in Shopify rather than in
 * nothing. Verified against August 2026, where the channel split reproduces our
 * own platform split exactly: Online Store 9,900.44, Marketplace Connect
 * 311.94 (our Amazon), Mirakl Connect 29.90 (our Yves Rocher).
 */
export const MARKETPLACE_SALES_CHANNELS = Object.freeze({
  amazon: Object.freeze(['marketplace connect']),
  yves_rocher: Object.freeze(['mirakl connect'])
});

/**
 * EVERY SESSIONS QUERY CARRIES THIS, and it is the difference between a figure
 * the owner can check and one they cannot.
 *
 * `sessions` counts automated traffic; the admin's Analytics → Reports page
 * reports HUMAN sessions. Measured 2026-09-23 over 25 Aug – 23 Sep: unfiltered
 * 6,839 sessions at 1.89%, of which **1,707 were bots converting at 0.23%**,
 * against the admin's 5,076 human sessions at 2.46%. Filtered here the same
 * window reads 5,147 at 2.43% — the remainder is the day still moving.
 *
 * Unfiltered, every rate on the page would have read a quarter low against the
 * screen the CEOs open, which is the exact shape of a plausible-but-wrong
 * number. The dimension is `human_or_bot_session` (`human` / `bot`) and it
 * composes with GROUP BY and TIMESERIES.
 */
export const HUMAN_ONLY = "WHERE human_or_bot_session = 'human'";

/**
 * How many traffic sources the acquisition card lists. Beyond this the tail is
 * a long list of single-session referrers.
 */
export const CHANNEL_LIMIT = 12;

/**
 * The grain ShopifyQL is asked for, which is not always the grain we draw.
 *
 * WEEKS ARE FETCHED AS DAYS. `date_trunc('week')` here starts on Monday;
 * nothing documents which day ShopifyQL starts a week on, and a chart whose
 * bars are shifted by a day would be wrong in a way nobody would notice. Days
 * are unambiguous, so they are fetched and folded into our own buckets.
 */
export function queryGrain(grain) {
  return grain === 'week' ? 'day' : grain;
}

/** `2026-08-01T00:00:00` -> `2026-08-01`. */
const day = (key) => key.slice(0, 10);

/**
 * The range as ShopifyQL states it. Our ranges are half-open [from, to);
 * `UNTIL` is inclusive, so it names the last day INSIDE the range.
 */
export function rangeClause(range) {
  const lastDay = toKey(new Date(fromKey(range.to).getTime() - 86_400_000));
  return `SINCE ${day(range.from)} UNTIL ${day(lastDay)}`;
}

/** The one-row totals for a window: what the KPI tiles show. */
export function totalsQuery(range) {
  return `FROM sessions SHOW ${SESSION_METRICS.join(', ')} ${HUMAN_ONLY} ${rangeClause(range)}`;
}

/** Sessions per bucket, for the trend. */
export function seriesQuery(range) {
  return `FROM sessions SHOW sessions ${HUMAN_ONLY} TIMESERIES ${queryGrain(range.grain)} ${rangeClause(range)}`;
}

/**
 * How many entry pages the product table lists. The tail is a long run of
 * single-session pages.
 */
export const PRODUCT_PAGE_LIMIT = 12;

/**
 * Where sessions came in, by the kind of page they landed on — `Product`,
 * `Homepage`, `Collection`, and so on — with the funnel metrics for each.
 *
 * `landing_page_type` IS A TYPED DIMENSION, so there is no string matching on
 * URLs. Measured 2026-09-23, it agrees with `landing_page_path CONTAINS
 * '/products/'` to within four sessions in August and does not need to guess
 * which paths under /products/ are really product pages.
 */
export function landingTypesQuery(range) {
  return `FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_completed_checkout ${HUMAN_ONLY} GROUP BY landing_page_type ${rangeClause(range)}`;
}

/**
 * The product pages sessions arrived on, busiest first.
 *
 * IT COUNTS ENTRIES, NOT VIEWS, and that is the whole caveat. Shopify keeps no
 * product-view metric (`product_views` and every spelling of it is refused), so
 * this is the sessions whose FIRST page was that product — a session that
 * landed on the homepage and then browsed to the product is not here. It is a
 * floor per page, and it is not a funnel stage: the cart step below it includes
 * sessions that entered anywhere.
 */
export function productPagesQuery(range, limit = PRODUCT_PAGE_LIMIT) {
  return `FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions ${HUMAN_ONLY} AND landing_page_type = 'Product' GROUP BY landing_page_path ORDER BY sessions DESC LIMIT ${Math.max(1, Math.trunc(limit))} ${rangeClause(range)}`;
}

/** `/products/uv-protect-spf-50` -> `uv-protect-spf-50`, or null if it is not a product page. */
export function handleFromPath(path) {
  const match = /^\/products\/([^/?#]+)/.exec(String(path ?? ''));
  return match ? decodeURIComponent(match[1]) : null;
}

/** The landing-page rows, largest first, with the two rates each type supports. */
export function readLandingTypes(rows = []) {
  return rows
    .map((row) => {
      const sessions = toNumber(row.sessions);
      const carts = toNumber(row.sessions_with_cart_additions);
      const converted = toNumber(row.sessions_that_completed_checkout);
      return {
        type: String(row.landing_page_type ?? 'Unknown'),
        sessions,
        visitors: toNumber(row.online_store_visitors),
        cartSessions: carts,
        convertedSessions: converted,
        cartRate: sessions && carts !== null ? (carts / sessions) * 100 : null,
        conversionRate: sessions && converted !== null ? (converted / sessions) * 100 : null
      };
    })
    .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0));
}

/** One row per product page, with the handle pulled out of the path for naming. */
export function readProductPages(rows = []) {
  return rows.map((row) => {
    const path = String(row.landing_page_path ?? '');
    const sessions = toNumber(row.sessions);
    const carts = toNumber(row.sessions_with_cart_additions);
    return {
      path,
      handle: handleFromPath(path),
      title: null,
      sessions,
      visitors: toNumber(row.online_store_visitors),
      cartSessions: carts,
      cartRate: sessions && carts !== null ? (carts / sessions) * 100 : null
    };
  });
}

/**
 * Sessions by channel, and the revenue each brought in. Two datasets, two
 * queries, ONE DIMENSION.
 *
 * `referring_channel` is grouped on BOTH sides, which is what makes the join
 * exact. Measured 2026-09-23: `sessions` also offers `referrer_source`
 * (`direct` / `search` / `paid` / `email`) and `referrer_name` (`google`,
 * `bing`), but `sales` offers neither — joining a coarse category to a named
 * channel produced a table where nearly every row had traffic or money and
 * never both, and no conversion rate at all.
 */
export function channelSessionsQuery(range) {
  return `FROM sessions SHOW sessions ${HUMAN_ONLY} GROUP BY referring_channel ${rangeClause(range)}`;
}

export function channelSalesQuery(range) {
  return `FROM sales SHOW total_sales, orders GROUP BY referring_channel ${rangeClause(range)}`;
}

/**
 * The money ladder per sales channel, so the platform filter can narrow it.
 * Grouped rather than totalled because `sales` has no channel-handle filter and
 * the fold is a business judgement either way.
 */
export function salesLadderQuery(range) {
  return `FROM sales SHOW ${SALES_LADDER.join(', ')} GROUP BY sales_channel ${rangeClause(range)}`;
}

/** Which platform a ShopifyQL sales channel belongs to. */
export function platformOfSalesChannel(channel) {
  const name = String(channel ?? '').trim().toLowerCase();
  for (const [platform, names] of Object.entries(MARKETPLACE_SALES_CHANNELS)) {
    if (names.includes(name)) return platform;
  }
  return 'shopify';
}

/**
 * The ladder rows folded onto one platform (or all of them).
 *
 * Money adds up across channels; AOV does not, so it is recomputed from the
 * parts — `(gross - discounts) / orders`, Shopify's own formula. Discounts and
 * returns come back NEGATIVE from ShopifyQL and are kept as positive magnitudes
 * here, because every card renders them as deductions.
 */
export function foldSalesLadder(rows = [], platform = 'all') {
  const wanted = (row) => platform === 'all' || platformOfSalesChannel(row.sales_channel) === platform;
  const kept = rows.filter(wanted);
  if (kept.length === 0) return null;

  const sum = (key) => kept.reduce((total, row) => total + (toNumber(row[key]) ?? 0), 0);
  const grossSales = sum('gross_sales');
  const discounts = Math.abs(sum('discounts'));
  const returns = Math.abs(sum('returns'));
  const orders = sum('orders');
  return {
    grossSales,
    discounts,
    returns,
    netSales: sum('net_sales'),
    taxes: sum('taxes'),
    totalSales: sum('total_sales'),
    // What the ladder leaves unaccounted between net sales and total sales.
    shipping: sum('total_sales') - sum('net_sales') - sum('taxes'),
    orders,
    averageOrderValue: orders > 0 ? (grossSales - discounts) / orders : null
  };
}

/**
 * The same figures as monthly buckets, for a caller that needs SEVERAL windows.
 *
 * WHY THIS EXISTS: ShopifyQL is rate-limited on its own bucket, separately from
 * the GraphQL point budget, and the monthly report needs five windows of both
 * datasets — ten queries, which came back `THROTTLED` with the analytics bucket
 * at zero. Every window the report asks for is whole months, so two monthly
 * series answer all of them and the caller sums the months it wants.
 *
 * ONLY COUNTS AND MONEY ARE SUMMABLE, which is why the sessions series asks for
 * the funnel counts rather than `conversion_rate`: a rate cannot be added, but
 * completed checkouts over sessions IS the conversion rate, exactly as Shopify
 * computes it. `bounce_rate` has no count behind it here and is left out — no
 * report card reads it.
 */
export function monthlySessionsQuery(window) {
  return `FROM sessions SHOW sessions, online_store_visitors, pageviews, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout ${HUMAN_ONLY} TIMESERIES month ${rangeClause(window)}`;
}

export function monthlyLadderQuery(window) {
  return `FROM sales SHOW ${SALES_LADDER.filter((c) => c !== 'average_order_value').join(', ')} TIMESERIES month ${rangeClause(window)}`;
}

/** True when a window starts and ends on a month boundary, so months can serve it. */
export function isMonthAligned(window) {
  return /^\d{4}-\d{2}-01T00:00:00$/.test(String(window.from ?? '')) && /^\d{4}-\d{2}-01T00:00:00$/.test(String(window.to ?? ''));
}

/** The monthly rows that fall inside a window, by their bucket key. */
function monthsIn(rows, window) {
  return rows.filter((row) => {
    const key = String(row.month ?? row.bucket ?? '').slice(0, 10);
    if (!key) return false;
    const at = `${key}T00:00:00`;
    return at >= window.from && at < window.to;
  });
}

/** Sessions totals for one window, summed from months. A window with no month is null. */
export function foldMonthlySessions(rows = [], window) {
  const months = monthsIn(rows, window);
  if (months.length === 0) return null;
  const sum = (key) => months.reduce((total, row) => total + (toNumber(row[key]) ?? 0), 0);
  const sessions = sum('sessions');
  const converted = sum('sessions_that_completed_checkout');
  return {
    sessions,
    visitors: sum('online_store_visitors'),
    // Shopify's own rate, rebuilt from its own counts.
    conversionRate: sessions > 0 ? (converted / sessions) * 100 : null,
    pageviews: sum('pageviews'),
    // Not summable from counts, and no report card reads it.
    bounceRate: null,
    cartSessions: sum('sessions_with_cart_additions'),
    checkoutSessions: sum('sessions_that_reached_checkout'),
    convertedSessions: converted
  };
}

/** The money ladder for one window, summed from months; AOV is recomputed, never summed. */
export function foldMonthlyLadder(rows = [], window) {
  const months = monthsIn(rows, window);
  if (months.length === 0) return null;
  const sum = (key) => months.reduce((total, row) => total + (toNumber(row[key]) ?? 0), 0);
  const grossSales = sum('gross_sales');
  const discounts = Math.abs(sum('discounts'));
  const orders = sum('orders');
  return {
    grossSales,
    discounts,
    returns: Math.abs(sum('returns')),
    netSales: sum('net_sales'),
    taxes: sum('taxes'),
    totalSales: sum('total_sales'),
    shipping: sum('total_sales') - sum('net_sales') - sum('taxes'),
    orders,
    averageOrderValue: orders > 0 ? (grossSales - discounts) / orders : null
  };
}

/** Postgres-style numerics arrive as strings; a missing metric stays null. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The totals row, or nulls when the window held nothing. */
export function readTotals(rows = []) {
  const row = rows[0] ?? {};
  return {
    sessions: toNumber(row.sessions),
    visitors: toNumber(row.online_store_visitors),
    // A PERCENT column is a fraction (0.016 = 1.6%); every rate on the
    // dashboard is a percentage, so it is converted once, here.
    conversionRate: percent(row.conversion_rate),
    pageviews: toNumber(row.pageviews),
    bounceRate: percent(row.bounce_rate),
    cartSessions: toNumber(row.sessions_with_cart_additions),
    checkoutSessions: toNumber(row.sessions_that_reached_checkout),
    convertedSessions: toNumber(row.sessions_that_completed_checkout)
  };
}

/**
 * The funnel, as steps a chart can draw: each stage with its share of the one
 * above and of the entry. Sessions-based throughout, so it is internally
 * consistent — the last step over the first IS Shopify's conversion rate
 * (August 2026: 85 of 4,164 = 2.04%). Our own order count is deliberately NOT
 * a step: it counts every platform, including marketplace orders that had no
 * session, and mixing the two would be the apples-and-oranges the rest of this
 * file exists to avoid.
 *
 * `productEntries` (sessions whose FIRST page was a product) is drawn in the
 * funnel at the owner's request, and it is NOT PART OF THE CHAIN. Shopify keeps
 * no product-view metric, so this counts entries: a session that landed on the
 * homepage and browsed to a product is missing from it, and the cart step below
 * includes sessions that entered anywhere. It therefore carries `chained:
 * false`, its own share of the entry, and no "from prior step" — and the cart
 * step's "from prior step" keeps measuring against SESSIONS, skipping it.
 * Without that, August would have read "cart: 16.9% from prior step", which is
 * 339 over 2,006 — two populations that do not nest.
 *
 * RE-CHECKED 2026-09-23 before settling for entries: `FROM products SHOW
 * view_sessions` is refused with *Invalid dataset in FROM clause - products* —
 * an error naming the DATASET, not a column, so unlike the cart and checkout
 * steps there is nothing hiding behind a mistyped name. `view_sessions` exists
 * on no dataset here, and `product_title` exists only on `sales`, which holds
 * no session metrics.
 *
 * @param {{ sessions: number | null, cartSessions: number | null, checkoutSessions: number | null, convertedSessions: number | null }} totals
 * @param {number | null} [productEntries]
 */
export function funnelSteps(totals, productEntries = null) {
  const chain = [
    { key: 'sessions', label: 'Sessions', value: totals.sessions },
    { key: 'cart', label: 'Added to cart', value: totals.cartSessions },
    { key: 'checkout', label: 'Reached checkout', value: totals.checkoutSessions },
    { key: 'purchase', label: 'Completed checkout', value: totals.convertedSessions }
  ];
  const entry = chain[0].value;
  const share = (value) => (entry && value !== null ? (value / entry) * 100 : null);

  const steps = chain.map((step, i) => {
    const previous = i > 0 ? chain[i - 1].value : null;
    return {
      ...step,
      chained: true,
      ofEntry: share(step.value),
      ofPrevious: previous && step.value !== null ? (step.value / previous) * 100 : null
    };
  });

  steps.splice(1, 0, {
    key: 'product',
    label: 'Product page entries',
    value: productEntries ?? null,
    chained: false,
    ofEntry: share(productEntries ?? null),
    ofPrevious: null
  });
  return steps;
}

function percent(value) {
  const n = toNumber(value);
  return n === null ? null : n * 100;
}

/**
 * A ShopifyQL bucket -> the wall-clock key the charts are drawn on.
 *
 * Day and month come back as plain dates already on the shop's clock. Hour
 * comes back as a UTC instant, so it is converted to the shop's wall clock —
 * without that, every hour on the 24-hour range would be drawn in the wrong
 * place and the shape would look almost right.
 */
export function bucketKeyOf(value, grain, tz) {
  const text = String(value ?? '');
  if (!text) return null;
  if (grain === 'hour' || text.endsWith('Z')) return toKey(wallClock(new Date(text), tz));
  return toKey(fromKey(text.length === 10 ? text : text.slice(0, 19)));
}

/**
 * Rows -> one value per bucket key of the range, summed where several rows fall
 * in one bucket (a week is fetched as days). A bucket nothing was returned for
 * stays absent rather than becoming zero: the caller decides which absences are
 * real zeros, from the range's coverage, as every other series here does.
 */
export function foldSeries(rows = [], range, metric = 'sessions') {
  const byKey = new Map();
  for (const row of rows) {
    const bucket = bucketKeyOf(row[range.grain] ?? row.bucket ?? row[queryGrain(range.grain)], range.grain, range.tz);
    if (!bucket) continue;
    const key = toKey(truncate(fromKey(bucket), range.grain));
    const value = toNumber(row[metric]);
    if (value === null) continue;
    byKey.set(key, (byKey.get(key) ?? 0) + value);
  }
  return byKey;
}

/**
 * Traffic and money per channel, joined on the source name.
 *
 * TWO DATASETS, ONE DIMENSION. Both are grouped on `referring_channel`, so
 * `google` here is Shopify's `google` there; the names are lowercased and
 * trimmed only against spelling drift. A channel present on one side only
 * keeps its figure and leaves the other null — a source that sent traffic and
 * no orders is a real finding, and so is revenue attributed to a channel the
 * session data did not record.
 */
export function joinChannels(sessionRows = [], salesRows = [], limit = CHANNEL_LIMIT) {
  const channels = new Map();
  const at = (name) => {
    const key = String(name ?? '').trim().toLowerCase() || 'unknown';
    if (!channels.has(key)) channels.set(key, { channel: key, sessions: null, revenue: null, orders: null });
    return channels.get(key);
  };
  for (const row of sessionRows) at(row.referring_channel).sessions = toNumber(row.sessions);
  for (const row of salesRows) {
    const entry = at(row.referring_channel);
    entry.revenue = toNumber(row.total_sales);
    entry.orders = toNumber(row.orders);
  }
  return [...channels.values()]
    .map((entry) => ({
      ...entry,
      // Conversion per channel is orders over sessions, and it is only
      // computable where both sides exist.
      conversionRate: entry.sessions && entry.orders !== null ? (entry.orders / entry.sessions) * 100 : null,
      revenuePerSession: entry.sessions && entry.revenue !== null ? entry.revenue / entry.sessions : null
    }))
    .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0) || (b.revenue ?? 0) - (a.revenue ?? 0))
    .slice(0, limit);
}
