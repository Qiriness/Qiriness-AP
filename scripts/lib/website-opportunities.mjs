/**
 * Which landing pages deserve the next hour of website work.
 *
 * NOT THE LOWEST CONVERSION RATE. A page converting at 0.5% on 20 sessions is
 * noise; a page converting at 1.2% on 3,000 sessions where similar pages
 * convert at 2.5% is forty orders a month. The score is
 *
 *   potential conversions = landing sessions × max(0, benchmark CVR − page CVR)
 *
 * and an estimated revenue beside it at the site's AOV — labelled an
 * estimate, never a promised gain.
 *
 * THE BENCHMARK IS A COMPARABLE PAGE, NOT THE SITE. Pages are compared within
 * a segment: product pages by price band (a €349 LED mask is not benchmarked
 * against a €6 sheet mask), collections by category, everything else by page
 * type. The benchmark is the pooled CVR of the OTHER pages in the segment with
 * enough sessions (the page itself is left out, or a big page would set its
 * own bar). A product page whose price band holds no other qualifying page
 * gets NO benchmark rather than the all-products rate.
 *
 * FLAGS NAME THE SHAPE of the problem, each only with enough traffic behind it:
 * a weak add-to-cart rate, paid traffic converting far below non-paid traffic
 * on the same page, mobile far below desktop.
 */

export const DEFAULT_OPTIONS = Object.freeze({
  /** Sessions a page needs to be scored or to count in a benchmark. */
  minSessions: 100,
  /** Sessions each side of a channel or device comparison needs. */
  minSliceSessions: 50,
  /** A slice is flagged when it converts below this share of the other. */
  gapRatio: 0.5,
  /** Expected conversions at the benchmark below which a score is « low confidence ». */
  minExpectedConversions: 5,
  limit: 15
});

/** Product price bands, in the shop's currency. */
export const PRICE_BANDS = Object.freeze([
  { id: 'under25', below: 25 },
  { id: '25to60', below: 60 },
  { id: '60to150', below: 150 },
  { id: '150plus', below: Infinity }
]);

export function priceBand(price) {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return null;
  return PRICE_BANDS.find((b) => Number(price) < b.below).id;
}

/** The segment a page is benchmarked within, or null when it cannot be placed (a product with no known price). */
export function segmentOf(page) {
  if (page.type === 'Product') return page.priceBand ? `product:${page.priceBand}` : null;
  if (page.type === 'Collection') return `collection:${page.category ?? 'other'}`;
  return `type:${page.type}`;
}

const pooled = (pages, field) => {
  const sessions = pages.reduce((t, p) => t + p.sessions, 0);
  return sessions > 0 ? pages.reduce((t, p) => t + p[field], 0) / sessions : null;
};

const PAID = new Set(['paid_search', 'paid_social']);
const NON_PAID = new Set(['organic_search', 'organic_social', 'email', 'direct', 'referral']);

function sliceRate(byKey, keys) {
  let sessions = 0;
  let converted = 0;
  for (const [key, c] of byKey ?? []) {
    if (!keys.has(key)) continue;
    sessions += c.sessions;
    converted += c.convertedSessions;
  }
  return { sessions, rate: sessions > 0 ? converted / sessions : null };
}

/**
 * @param {Array<{path:string,type:string,priceBand?:string|null,category?:string|null,sessions:number,cartSessions:number,convertedSessions:number}>} pages
 * @param {{aov:number|null, byGroup?:Map<string,Map<string,object>>, byDevice?:Map<string,Map<string,object>>}} context
 */
export function scoreOpportunities(pages, { aov = null, byGroup = new Map(), byDevice = new Map() } = {}, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const qualified = pages.filter((p) => p.sessions >= o.minSessions);
  const bySegment = new Map();
  for (const page of qualified) {
    const seg = segmentOf(page);
    if (seg) bySegment.set(seg, [...(bySegment.get(seg) ?? []), page]);
  }

  const scored = [];
  for (const page of qualified) {
    const segment = segmentOf(page);
    const peers = (bySegment.get(segment) ?? []).filter((p) => p !== page);
    const cvr = page.sessions > 0 ? page.convertedSessions / page.sessions : 0;
    const atc = page.sessions > 0 ? page.cartSessions / page.sessions : 0;
    const benchCvr = peers.length ? pooled(peers, 'convertedSessions') : null;
    const benchAtc = peers.length ? pooled(peers, 'cartSessions') : null;
    const potential = benchCvr === null ? 0 : page.sessions * Math.max(0, benchCvr - cvr);

    const flags = [];
    if (benchAtc !== null && atc < benchAtc * o.gapRatio) flags.push('lowAddToCart');
    const paid = sliceRate(byGroup.get(page.path), PAID);
    const organic = sliceRate(byGroup.get(page.path), NON_PAID);
    if (paid.sessions >= o.minSliceSessions && organic.sessions >= o.minSliceSessions && organic.rate > 0 && paid.rate < organic.rate * o.gapRatio) {
      flags.push('paidBelowOrganic');
    }
    const mobile = sliceRate(byDevice.get(page.path), new Set(['mobile']));
    const desktop = sliceRate(byDevice.get(page.path), new Set(['desktop']));
    if (mobile.sessions >= o.minSliceSessions && desktop.sessions >= o.minSliceSessions && desktop.rate > 0 && mobile.rate < desktop.rate * o.gapRatio) {
      flags.push('mobileBelowDesktop');
    }
    if (potential <= 0 && flags.length === 0) continue;

    scored.push({
      path: page.path,
      type: page.type,
      segment,
      sessions: page.sessions,
      conversionRate: cvr * 100,
      benchmarkRate: benchCvr === null ? null : benchCvr * 100,
      addToCartRate: atc * 100,
      benchmarkAddToCart: benchAtc === null ? null : benchAtc * 100,
      peers: peers.length,
      potentialConversions: potential,
      potentialRevenue: aov === null ? null : potential * aov,
      confidence: benchCvr !== null && page.sessions * benchCvr >= o.minExpectedConversions ? 'ok' : 'low',
      flags,
      slices: {
        paid: paid.rate === null ? null : { sessions: paid.sessions, rate: paid.rate * 100 },
        organic: organic.rate === null ? null : { sessions: organic.sessions, rate: organic.rate * 100 },
        mobile: mobile.rate === null ? null : { sessions: mobile.sessions, rate: mobile.rate * 100 },
        desktop: desktop.rate === null ? null : { sessions: desktop.sessions, rate: desktop.rate * 100 }
      }
    });
  }
  return scored
    .sort((a, b) => b.potentialConversions - a.potentialConversions || b.flags.length - a.flags.length || b.sessions - a.sessions)
    .slice(0, o.limit);
}
