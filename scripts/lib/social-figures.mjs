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
 * - engagement rate, in %, by the platform's chosen basis (`bases[kind]`, default
 *   reach), always over the posts that carry both halves:
 *     reach     Σ engagement / Σ reach
 *     views     Σ engagement / Σ views
 *     followers Σ engagement / (followers × posts), i.e. the average post's
 *               interactions over the followers at the end of the range.
 *   Platforms on different bases are NOT pooled: the rate is null, because one
 *   number from two definitions would be read as if it were one.
 * - followers: the last measured count inside the range, per account, summed.
 * - growth: per account, net follows when the platform reported them, else the
 *   difference between the follower counts at the two ends; null when neither.
 *
 * @param {{ series?: any[], followers?: any[], postTotals?: any[] }} rows
 * @param {string[] | null} [kinds]
 * @param {Record<string, string>} [bases] engagement-rate basis per platform kind
 */
export function organicTotals({ series = [], followers = [], postTotals = [] }, kinds = null, bases = {}) {
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

  const rated = pooledRate(posts, ends, bases);
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

const basisOf = (bases, kind) => bases?.[kind] ?? 'reach';

/** Σ numerator / Σ denominator for the accounts' common basis, or null (see organicTotals). */
function pooledRate(posts, ends, bases) {
  const used = new Set(posts.map((p) => basisOf(bases, p.kind)));
  if (used.size !== 1) return null;
  const [basis] = used;
  const followersOf = new Map(ends.map((e) => [e.account_id, e.followers_end]));
  let numerator = null;
  let denominator = null;
  const add = (n, d) => {
    if (n === null || n === undefined || d === null || d === undefined) return;
    numerator = (numerator ?? 0) + Number(n);
    denominator = (denominator ?? 0) + Number(d);
  };
  for (const p of posts) {
    if (basis === 'reach') add(p.rated_engagement, p.rated_reach);
    else if (basis === 'views') add(p.rated_views_engagement, p.rated_views);
    else {
      const followers = followersOf.get(p.account_id);
      if (followers !== null && followers !== undefined && Number(p.engaged_posts) > 0) add(p.engagement, Number(followers) * Number(p.engaged_posts));
    }
  }
  return ratio(numerator, denominator);
}

/**
 * One post's engagement rate, in %, under a basis: its interactions divided by
 * the account's followers, the post's reach or the post's views. Null when
 * either half is unknown or the denominator is zero.
 *
 * @param {{ engagement: number | null, reach: number | null, views: number | null }} post
 * @param {'followers' | 'reach' | 'views'} basis
 * @param {number | null} followers the account's follower count
 */
export function postEngagementRate(post, basis, followers) {
  const whole = basis === 'followers' ? followers : basis === 'views' ? post.views : post.reach;
  const rate = ratio(post.engagement, whole);
  return rate === null ? null : rate * 100;
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


/**
 * What a set of posts says about the content itself: how many of each media
 * type, how many carry each of the team's tags, and when the posts that earned
 * the most engagement went out.
 *
 * PEAK TIMES ARE WHEN A POST WAS PUBLISHED, NOT WHEN PEOPLE REACTED. Meta
 * timestamps no like or comment, so « when people engage » cannot be measured
 * from the API; the nearest true thing is the average engagement of the posts
 * published in each hour of the day and each weekday, in the shop's timezone.
 * Each slot carries its post count, and slots with a single post are ranked
 * only when no slot has two. Posts without a measured engagement are left out of the averages.
 *
 * @param {{ accountId: string, id: string, mediaType: string|null, publishedAt: string, engagement: number|null }[]} posts
 * @param {{ id: string, name: string }[]} tags
 * @param {{ tagId: string, accountId: string, postId: string }[]} links
 * @param {string} tz IANA timezone
 */
export function postActivity(posts, tags = [], links = [], tz = 'UTC') {
  // Keep every dependency inside the function: reports serialize this function
  // after Next's production minifier has renamed identifiers.
  const PEAK_TOP = 3;
  const PEAK_MIN_POSTS = 2;
  const count = (keys) => {
    const map = new Map();
    for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  };
  const byType = [...count(posts.map((p) => p.mediaType ?? 'other'))]
    .map(([key, posts]) => ({ key, posts }))
    .sort((a, b) => b.posts - a.posts || a.key.localeCompare(b.key));

  const inRange = new Set(posts.map((p) => `${p.accountId}|${p.id}`));
  const tagged = new Map(tags.map((t) => [t.id, new Set()]));
  for (const link of links) {
    const key = `${link.accountId}|${link.postId}`;
    if (inRange.has(key)) tagged.get(link.tagId)?.add(key);
  }
  const byTag = tags
    .map((t) => ({ id: t.id, name: t.name, posts: tagged.get(t.id).size }))
    .filter((t) => t.posts > 0)
    .sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name));
  const anyTag = new Set([...tagged.values()].flatMap((s) => [...s]));

  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hours = new Map();
  const days = new Map();
  const add = (map, key, engagement) => {
    const cell = map.get(key) ?? { total: 0, posts: 0 };
    cell.total += engagement;
    cell.posts += 1;
    map.set(key, cell);
  };
  for (const post of posts) {
    if (post.engagement === null || post.engagement === undefined) continue;
    const p = Object.fromEntries(parts.formatToParts(new Date(post.publishedAt)).map((x) => [x.type, x.value]));
    add(hours, Number(p.hour), post.engagement);
    add(days, WEEKDAYS.indexOf(p.weekday), post.engagement);
  }
  // One post is an anecdote: slots with at least PEAK_MIN_POSTS posts are ranked
  // when there are any, and only otherwise are single-post slots shown.
  const top = (map) => {
    const slots = [...map].map(([slot, c]) => ({ slot, average: c.total / c.posts, posts: c.posts }));
    const steady = slots.filter((x) => x.posts >= PEAK_MIN_POSTS);
    return (steady.length ? steady : slots)
      .sort((a, b) => b.average - a.average || b.posts - a.posts || a.slot - b.slot)
      .slice(0, PEAK_TOP);
  };

  return {
    total: posts.length,
    byType,
    byTag,
    untagged: posts.length - anyTag.size,
    peakHours: top(hours),
    peakDays: top(days)
  };
}
