// The Social media panel's figures, from the rows 70_social.sql's reads return.
// Pure and isomorphic: sums, rates and the « what moved » rules live here, in
// tested JavaScript, the way the other panels keep judgement out of SQL.
//
// TWO RULES RUN THROUGH ALL OF IT.
//   A null is not measured. A sum over nothing measured stays null — the card
//   draws a dash — and a sum over some measured rows counts only those.
//   Money is never added across currencies. Paid totals are per currency; the
//   panel shows one only when every account shares it.

/** Sum the non-null values; null when there were none. */
export function sumKnown(values) {
  let total = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total = (total ?? 0) + n;
  }
  return total;
}

/** `part / whole`, or null when either is unknown or the whole is zero. */
export function ratio(part, whole) {
  if (part === null || part === undefined || whole === null || whole === undefined) return null;
  const w = Number(whole);
  return w > 0 ? Number(part) / w : null;
}

/**
 * @template {{ kind?: string }} R
 * @param {R[]} rows
 * @param {string[] | null | undefined} kinds
 * @returns {R[]}
 */
const pick = (rows, kinds) => (kinds ? rows.filter((r) => kinds.includes(/** @type {string} */ (r.kind))) : rows);

/**
 * Organic totals over a range, for the accounts of `kinds` (all when null).
 *
 * - views, engagement, profile visits, link taps: summed days.
 * - posts: from the post totals (every post published in the range).
 * - engagement rate: Σ engagement / Σ reach over posts carrying both, in %.
 * - followers: the last measured count inside the range, per account, summed.
 * - growth: per account, net follows when the platform reported them, else the
 *   difference between the follower counts at the two ends; null when neither.
 *
 * @param {{ series?: any[], followers?: any[], postTotals?: any[] }} rows
 * @param {string[] | null} [kinds]
 */
export function organicTotals({ series = [], followers = [], postTotals = [] }, kinds = null) {
  const days = pick(series, kinds);
  const posts = pick(postTotals, kinds);
  const ends = pick(followers, kinds);

  const byAccount = new Map();
  for (const row of days) {
    const acc = byAccount.get(row.account_id) ?? { follows: [], unfollows: [] };
    acc.follows.push(row.follows);
    acc.unfollows.push(row.unfollows);
    byAccount.set(row.account_id, acc);
  }

  const growth = sumKnown(
    ends.map((end) => {
      const acc = byAccount.get(end.account_id);
      const follows = acc ? sumKnown(acc.follows) : null;
      const unfollows = acc ? sumKnown(acc.unfollows) : null;
      if (follows !== null && unfollows !== null) return follows - unfollows;
      if (end.followers_end !== null && end.followers_end !== undefined && end.followers_start !== null && end.followers_start !== undefined) {
        return Number(end.followers_end) - Number(end.followers_start);
      }
      return null;
    })
  );

  const rated = ratio(sumKnown(posts.map((p) => p.rated_engagement)), sumKnown(posts.map((p) => p.rated_reach)));
  const postCount = posts.length ? sumKnown(posts.map((p) => p.posts)) : days.length ? 0 : null;

  return {
    views: sumKnown(days.map((r) => r.views)),
    engagement: sumKnown(days.map((r) => r.engagement)),
    profileVisits: sumKnown(days.map((r) => r.profile_visits)),
    linkTaps: sumKnown(days.map((r) => r.link_taps)),
    posts: postCount,
    engagementRate: rated === null ? null : rated * 100,
    followers: sumKnown(ends.map((e) => e.followers_end)),
    growth
  };
}

/**
 * One value per bucket, summed across the selected accounts. Rows come back
 * from SQL only for buckets that had a stored day; a bucket whose every row is
 * null stays null.
 *
 * @param {any[]} rows
 * @param {string | ((row: any) => number | null)} field
 * @param {string[] | null} [kinds]
 * @returns {{ bucket: string, value: number | null }[]}
 */
export function bucketSeries(rows, field, kinds = null) {
  const buckets = new Map();
  for (const row of pick(rows, kinds)) {
    const value = typeof field === 'function' ? field(row) : row[field];
    const list = buckets.get(row.bucket) ?? [];
    list.push(value);
    buckets.set(row.bucket, list);
  }
  return [...buckets].map(([bucket, values]) => ({ bucket, value: sumKnown(values) }));
}

/** Net follows per bucket: follows − unfollows where both were measured. */
export function netFollows(row) {
  if (row.follows === null || row.follows === undefined || row.unfollows === null || row.unfollows === undefined) return null;
  return Number(row.follows) - Number(row.unfollows);
}

/**
 * Paid totals per currency, with the rates rebuilt from the summed counts.
 * @param {any[]} rows
 * @param {string[] | null} [kinds]
 */
export function paidTotals(rows, kinds = null) {
  const byCurrency = new Map();
  for (const row of pick(rows, kinds)) {
    const t = byCurrency.get(row.currency) ?? { currency: row.currency, spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    t.spend += Number(row.spend) || 0;
    t.impressions += Number(row.impressions) || 0;
    t.clicks += Number(row.clicks) || 0;
    t.conversions += Number(row.conversions) || 0;
    t.conversionValue += Number(row.conversion_value) || 0;
    byCurrency.set(row.currency, t);
  }
  return [...byCurrency.values()].map(withRates);
}

/**
 * The rates rebuilt from summed counts: CTR in %, CPC and CPA in money, ROAS as a multiple.
 * @template {{ spend: number, impressions: number, clicks: number, conversions: number, conversionValue: number }} T
 * @param {T} t
 * @returns {T & { ctr: number | null, cpc: number | null, cpa: number | null, roas: number | null }}
 */
export function withRates(t) {
  const round = (n) => Math.round(n * 100) / 100;
  return {
    ...t,
    spend: round(t.spend),
    conversions: round(t.conversions),
    conversionValue: round(t.conversionValue),
    ctr: ratio(t.clicks, t.impressions) === null ? null : ratio(t.clicks, t.impressions) * 100,
    cpc: ratio(t.spend, t.clicks),
    cpa: ratio(t.spend, t.conversions),
    roas: ratio(t.conversionValue, t.spend)
  };
}

/** Relative change in %, or null when there is nothing to compare with. */
export function changePct(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (Number(previous) === 0) return null;
  return ((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100;
}

/**
 * « What moved social performance? » — four drivers in a fixed order, each the
 * change against the previous period: views, engagement and follower growth
 * as a relative change, the engagement rate in points. `share` scales the bar
 * against the largest move so the four compare. Null changes are kept, as
 * « not comparable », rather than dropped: the shape stays agreed.
 *
 * @param {{ views?: number | null, engagement?: number | null, growth?: number | null, engagementRate?: number | null }} current
 * @param {{ views?: number | null, engagement?: number | null, growth?: number | null, engagementRate?: number | null } | null} previous
 * @returns {{ key: 'views' | 'engagement' | 'growth' | 'engagementRate', change: number | null, points: boolean, share: number | null }[]}
 */
export function organicDrivers(current, previous) {
  /** @type {{ key: 'views' | 'engagement' | 'growth' | 'engagementRate', change: number | null, points: boolean }[]} */
  const drivers = [
    { key: 'views', change: previous ? changePct(current.views, previous.views) : null, points: false },
    { key: 'engagement', change: previous ? changePct(current.engagement, previous.engagement) : null, points: false },
    { key: 'growth', change: previous ? changePct(current.growth, previous.growth) : null, points: false },
    {
      key: 'engagementRate',
      change: previous && current.engagementRate !== null && previous.engagementRate !== null ? current.engagementRate - previous.engagementRate : null,
      points: true
    }
  ];
  const max = Math.max(0, ...drivers.map((d) => (d.change === null ? 0 : Math.abs(d.change))));
  return drivers.map((d) => ({ ...d, share: d.change === null || max === 0 ? null : Math.abs(d.change) / max }));
}

/**
 * The one sentence under the drivers, chosen by rule: which of reach-type
 * figures (views, growth) and efficiency (engagement rate) moved which way.
 * Returns a message key; the panel words it.
 */
export function driverSummary(drivers) {
  const by = Object.fromEntries(drivers.map((d) => [d.key, d.change]));
  const exposure = [by.views, by.growth].filter((c) => c !== null);
  const rate = by.engagementRate;
  if (!exposure.length && rate === null) return 'none';
  const exposureUp = exposure.length ? exposure.reduce((a, b) => a + b, 0) >= 0 : null;
  if (rate === null) return exposureUp ? 'exposureUp' : 'exposureDown';
  const rateUp = rate >= 0;
  if (exposureUp === null) return rateUp ? 'rateUp' : 'rateDown';
  if (exposureUp && rateUp) return 'allUp';
  if (!exposureUp && !rateUp) return 'allDown';
  return exposureUp ? 'exposureUpRateDown' : 'exposureDownRateUp';
}
