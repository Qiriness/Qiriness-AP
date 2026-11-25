/**
 * ShopifyQL for the redesigned Marketing & funnel panel: attributed sales by
 * channel, the session funnel sliced by device / landing type / channel, and
 * landing pages with their channel and device breakdowns.
 *
 * What ShopifyQL answers here was measured against the live store on
 * 2026-11-25 (DECISIONS.md § Insights → « Marketing & funnel, redesigned »):
 *
 *  - `sales` takes an ATTRIBUTION MODEL — `WITH LAST_NON_DIRECT_CLICK_ATTRIBUTION`
 *    (or LAST_CLICK, FIRST_CLICK, LINEAR, ANY_CLICK) — and then groups by
 *    `referring_channel`, `traffic_type`, `utm_source`, `utm_medium`,
 *    `utm_campaign`, with `new_customers` among the metrics. Each metric comes
 *    back suffixed (`net_sales__last_non_direct_click`), and ORDER BY must name
 *    the suffixed column while SHOW names the plain one. Without a model,
 *    grouping `sales` by a UTM is refused (« Attribution syntax required »).
 *  - `sales` has NO landing page, device or country: revenue per landing page
 *    is not answerable, so the landing tables count converted sessions.
 *  - `sessions` groups by `session_device_type`, `session_country`,
 *    `landing_page_type`, `landing_page_path` and the four channel dimensions,
 *    all combinable, with the three funnel counts.
 *  - No checkout sub-step (contact, shipping, payment) and no product or
 *    collection VIEW exists in any dataset: those need a web pixel.
 */

import { HUMAN_ONLY, rangeClause, toNumber } from './storefront-analytics.mjs';
import { classifyTraffic, providerOf } from './marketing-channels.mjs';
import { add, emptyCounts, rates } from './funnel-math.mjs';

export { foldTraffic, funnelOf, funnelSteps, rates } from './funnel-math.mjs';

/** The attribution models the panel offers, by URL id. `lndc` is the default (Shopify's own). */
export const ATTRIBUTION_MODELS = Object.freeze({
  lndc: 'LAST_NON_DIRECT_CLICK',
  last: 'LAST_CLICK',
  first: 'FIRST_CLICK',
  linear: 'LINEAR'
});
export const DEFAULT_ATTRIBUTION = 'lndc';

export function parseAttributionModel(value) {
  return Object.hasOwn(ATTRIBUTION_MODELS, String(value ?? '')) ? String(value) : DEFAULT_ATTRIBUTION;
}

const CHANNEL_DIMENSIONS = 'referring_channel, traffic_type, utm_source, utm_medium';
const FUNNEL_COUNTS = 'sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout';

/**
 * Attributed own-store sales per channel and campaign, for one model. Grouped
 * by `sales_channel` too so the caller can keep the store's own channels
 * (a marketplace order has no session and no channel).
 */
export function attributedSalesQuery(range, model = DEFAULT_ATTRIBUTION) {
  const m = ATTRIBUTION_MODELS[parseAttributionModel(model)];
  return `FROM sales SHOW net_sales, total_sales, orders, new_customers GROUP BY sales_channel, ${CHANNEL_DIMENSIONS}, utm_campaign ${rangeClause(range)} WITH ${m}_ATTRIBUTION`;
}

/** Net sales and orders, new against returning customers, per sales channel. */
export function newReturningQuery(range) {
  return `FROM sales SHOW net_sales, orders GROUP BY sales_channel, new_or_returning_customer ${rangeClause(range)}`;
}

/**
 * A country is put in the query, so it is allowed only as letters, spaces,
 * dots, hyphens and the typographic apostrophe — never a straight quote.
 */
export function safeCountry(value) {
  const text = String(value ?? '').trim();
  return /^[\p{L}][\p{L} .’-]{0,60}$/u.test(text) ? text : null;
}

/**
 * The session funnel cut every way the panel filters it: device, landing type
 * and the four channel dimensions plus campaign. One query; every filter but
 * country is applied by folding these rows, so changing it costs no query.
 */
/**
 * @param {any} range
 * @param {{ country?: string | null }} [options]
 */
export function trafficQuery(range, { country = null } = {}) {
  const c = safeCountry(country);
  const where = c ? `${HUMAN_ONLY} AND session_country = '${c}'` : HUMAN_ONLY;
  return `FROM sessions SHOW ${FUNNEL_COUNTS} ${where} GROUP BY session_device_type, landing_page_type, ${CHANNEL_DIMENSIONS}, utm_campaign ${rangeClause(range)} ORDER BY sessions DESC LIMIT 10000`;
}

/** The busiest countries, for the funnel's country filter. */
export function countriesQuery(range, limit = 25) {
  return `FROM sessions SHOW sessions ${HUMAN_ONLY} GROUP BY session_country ${rangeClause(range)} ORDER BY sessions DESC LIMIT ${Math.max(1, Math.trunc(limit))}`;
}

/** Every landing page with its funnel counts, visitors and bounce rate. */
export function landingPagesQuery(range, limit = 500) {
  return `FROM sessions SHOW sessions, online_store_visitors, bounce_rate, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout ${HUMAN_ONLY} GROUP BY landing_page_type, landing_page_path ${rangeClause(range)} ORDER BY sessions DESC LIMIT ${Math.max(1, Math.trunc(limit))}`;
}

/** Landing page x channel dimensions. */
export function landingChannelQuery(range, limit = 10000) {
  return `FROM sessions SHOW ${FUNNEL_COUNTS} ${HUMAN_ONLY} GROUP BY landing_page_path, ${CHANNEL_DIMENSIONS} ${rangeClause(range)} ORDER BY sessions DESC LIMIT ${Math.max(1, Math.trunc(limit))}`;
}

/** Landing page x device. */
export function landingDeviceQuery(range, limit = 5000) {
  return `FROM sessions SHOW ${FUNNEL_COUNTS} ${HUMAN_ONLY} GROUP BY landing_page_path, session_device_type ${rangeClause(range)} ORDER BY sessions DESC LIMIT ${Math.max(1, Math.trunc(limit))}`;
}

// --- readers -------------------------------------------------------------------------

const n = (value) => toNumber(value) ?? 0;
const counts = (row) => ({
  sessions: n(row.sessions),
  cartSessions: n(row.sessions_with_cart_additions),
  checkoutSessions: n(row.sessions_that_reached_checkout),
  convertedSessions: n(row.sessions_that_completed_checkout)
});

export const DEVICES = Object.freeze(['mobile', 'desktop', 'tablet', 'unknown']);
const device = (value) => {
  const d = String(value ?? '').toLowerCase();
  return DEVICES.includes(d) ? d : 'unknown';
};

/**
 * `/products/x?utm_source=y` and `/products/x/` are one page. ShopifyQL
 * already returns paths without a query string (checked 2026-11-25); this is
 * the guarantee rather than the expectation.
 */
export function normalisePath(path) {
  const raw = String(path ?? '').trim();
  if (!raw) return null;
  let p = raw.split(/[?#]/)[0];
  try {
    p = decodeURI(p);
  } catch {
    // keep it encoded
  }
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.toLowerCase() || '/';
}

/** The traffic rows, each with its channel group, provider and device decided once. */
export function readTraffic(rows = []) {
  return rows.map((row) => {
    const group = classifyTraffic(row);
    return {
      device: device(row.session_device_type),
      landingType: row.landing_page_type ? String(row.landing_page_type) : 'Unknown',
      group,
      provider: providerOf(row, group),
      campaign: row.utm_campaign ? String(row.utm_campaign) : null,
      ...counts(row)
    };
  });
}

/**
 * Landing pages, normalised and merged. Visitors and bounce rate are Shopify's
 * per row; when two raw paths merge into one page, visitors cannot be added
 * (one person may be in both) and become null, and the bounce rate is the
 * sessions-weighted mean of the two.
 */
export function readLandingPages(rows = []) {
  const pages = new Map();
  for (const row of rows) {
    const path = normalisePath(row.landing_page_path);
    if (!path) continue;
    const c = counts(row);
    const bounce = toNumber(row.bounce_rate);
    const hit = pages.get(path);
    if (!hit) {
      pages.set(path, {
        path,
        type: row.landing_page_type ? String(row.landing_page_type) : 'Unknown',
        ...c,
        visitors: toNumber(row.online_store_visitors),
        bounceWeight: bounce === null ? null : bounce * c.sessions,
        merged: false
      });
      continue;
    }
    add(hit, c);
    hit.visitors = null;
    hit.bounceWeight = hit.bounceWeight === null || bounce === null ? null : hit.bounceWeight + bounce * c.sessions;
    hit.merged = true;
  }
  return [...pages.values()]
    .map(({ bounceWeight, ...page }) => ({
      ...page,
      // A PERCENT column is a fraction; the dashboard prints percentages.
      bounceRate: bounceWeight === null || page.sessions === 0 ? null : (bounceWeight / page.sessions) * 100,
      ...rates(page)
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** path -> [{ key, counts }] for one breakdown dimension of the landing x channel / device rows. */
export function landingBreakdown(rows = [], keyOf) {
  const out = new Map();
  for (const row of rows) {
    const path = normalisePath(row.landing_page_path);
    const key = keyOf(row);
    if (!path || key === null) continue;
    const byKey = out.get(path) ?? new Map();
    byKey.set(key, add(byKey.get(key) ?? emptyCounts(), counts(row)));
    out.set(path, byKey);
  }
  return out;
}

export const landingByGroup = (rows) => landingBreakdown(rows, (row) => classifyTraffic(row));
export const landingByDevice = (rows) => landingBreakdown(rows, (row) => device(row.session_device_type));

/** `/collections/source-deau` -> `source-deau`; `/products/x` -> `x`. */
export function handleOf(path, kind) {
  const match = new RegExp(`^/${kind}/([^/?#]+)`).exec(String(path ?? ''));
  return match ? match[1] : null;
}

export const COLLECTION_CATEGORIES = Object.freeze(['concern', 'range', 'promo', 'general', 'other']);

/**
 * Seasonal and promotional collections, by words in the handle. Generic
 * French / English retail words, not one shop's names; a shop whose promotions
 * use other words gets them as « other » until the list learns them.
 */
const PROMO_WORDS = /(black-?friday|cyber|soldes|sales?(-|$)|promo|offre|offer|deal|noel|christmas|fete|fetes|french-days|vente-privee|outlet|destockage|edition-limitee|limited|saint-valentin|valentine|halloween|anniversaire)/;
const GENERAL_WORDS = /^(all|tous|meilleures?-ventes|best-?sellers?|nouveaute|nouveautes|new|new-in|top|favoris|coffrets?)(-|$)/;

/**
 * A collection's category: a skincare concern, a product range, a promotion,
 * general shopping, or other. Concerns and ranges come from the shop's own
 * data (the advice layer's `axis` and the sales ranges), so they follow the
 * catalogue; promotions and general shopping are read from the handle.
 *
 * @param {string} handle
 * @param {{concerns:Set<string>, ranges:Set<string>, categories:Set<string>}} known
 */
export function collectionCategory(handle, known) {
  const h = String(handle ?? '').toLowerCase();
  if (!h) return 'other';
  if (known.concerns.has(h)) return 'concern';
  if (known.ranges.has(h)) return 'range';
  if (PROMO_WORDS.test(h)) return 'promo';
  if (known.categories.has(h) || GENERAL_WORDS.test(h)) return 'general';
  return 'other';
}
