import { captionExcerpt, normalisePublisher } from './social-model.mjs';

// What the Meta Graph API answers, folded into rows for 70_social.sql. Pure:
// every function takes API JSON and returns rows, and the tests feed it dummy
// payloads in the shapes Meta documents.
//
// THE METRIC NAMES LIVE IN ONE TABLE, BECAUSE META RETIRES THEM. Instagram
// dropped `impressions` for `views` in 2025, and Pages lost several metrics the
// same year. A metric Meta no longer answers is skipped by the client (it
// becomes a null — not measured — never a zero), and `npm run probe:meta`
// prints which of these answer for a connected account. Change a name here,
// not at a call site.

/** Meta's own « Purchases » column. A connection may name another action type. */
export const DEFAULT_META_CONVERSION_ACTION = 'omni_purchase';

export const META_METRICS = {
  /** Instagram account, one day at a time (`metric_type=total_value`). */
  instagramDay: {
    views: 'views',
    total_interactions: 'engagement',
    profile_views: 'profile_visits',
    profile_links_taps: 'link_taps'
  },
  /** Asked alone, because its breakdown applies to the whole request. */
  instagramFollows: { metric: 'follows_and_unfollows', breakdown: 'follow_type', follows: 'FOLLOWER', unfollows: 'NON_FOLLOWER' },
  /** Unique people over a range: never stored per day, read live (≤ 30 days). */
  instagramUnique: { reach: 'reach', accounts_engaged: 'accounts_engaged' },
  instagramMedia: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'follows', 'total_interactions'],
  instagramAudience: { metric: 'follower_demographics', breakdowns: ['gender', 'age', 'country', 'city'], timeframe: 'this_month' },

  /** Facebook Page, a daily series per metric (`period=day`). */
  facebookDay: {
    page_media_view: 'views',
    page_post_engagements: 'engagement',
    page_views_total: 'profile_visits',
    page_daily_follows_unique: 'follows',
    page_daily_unfollows_unique: 'unfollows',
    page_follows: 'followers'
  },
  facebookUnique: { page_total_media_view_unique: 'reach' },
  facebookPost: { post_media_view: 'views', post_total_media_view_unique: 'reach' }
};

/** Instagram's day window per request, and Pages'. */
export const PAGE_DAYS_PER_REQUEST = 90;

const DAY_MS = 24 * 3600 * 1000;

export function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Every day from `since` to `until`, both inclusive, as YYYY-MM-DD. */
export function daysBetween(since, until) {
  const out = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += DAY_MS) out.push(isoDay(t));
  return out;
}

/** [since, until] windows of at most `size` days, oldest first. */
export function dayWindows(since, until, size) {
  const days = daysBetween(since, until);
  const out = [];
  for (let i = 0; i < days.length; i += size) out.push({ since: days[i], until: days[Math.min(i + size, days.length) - 1] });
  return out;
}

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A metric's single value, in either of Meta's two shapes (total_value, or values[0]). */
function scalar(item) {
  if (item?.total_value && 'value' in item.total_value) return numberOrNull(item.total_value.value);
  const values = item?.values;
  if (Array.isArray(values) && values.length) return numberOrNull(values[values.length - 1]?.value);
  return null;
}

/**
 * One Instagram day from its `total_value` insights (+ the follows breakdown,
 * when answered). Columns Meta did not answer are left out, so the upsert
 * writes null for them.
 */
export function foldInstagramDay(insights = [], follows = []) {
  const row = {};
  for (const item of insights) {
    const column = META_METRICS.instagramDay[item?.name];
    if (column) row[column] = scalar(item);
  }
  const breakdown = follows.find((item) => item?.name === META_METRICS.instagramFollows.metric);
  if (breakdown) {
    const results = breakdown.total_value?.breakdowns?.[0]?.results ?? [];
    const valueOf = (key) => {
      const hit = results.find((r) => r?.dimension_values?.[0] === key);
      return hit ? numberOrNull(hit.value) : 0;
    };
    // A breakdown that answered with no rows is a measured zero: nobody followed.
    row.follows = valueOf(META_METRICS.instagramFollows.follows);
    row.unfollows = valueOf(META_METRICS.instagramFollows.unfollows);
  }
  return row;
}

/**
 * A Page's daily series, by day. Meta stamps a daily value with the END of its
 * day (`end_time` 07:00 UTC the next morning, Pacific midnight), so the day a
 * value belongs to is the day before its `end_time`.
 * @returns {Map<string, object>} day -> partial row
 */
export function foldPageDays(insights = []) {
  const days = new Map();
  for (const item of insights) {
    const column = META_METRICS.facebookDay[item?.name];
    if (!column || item.period && item.period !== 'day') continue;
    for (const point of item.values ?? []) {
      if (!point?.end_time) continue;
      const day = isoDay(Date.parse(point.end_time) - DAY_MS);
      const row = days.get(day) ?? {};
      row[column] = numberOrNull(point.value);
      days.set(day, row);
    }
  }
  return days;
}

/** How many posts went out each day (the platform's UTC date). */
export function postsPerDay(timestamps = []) {
  const counts = new Map();
  for (const ts of timestamps) {
    if (!ts) continue;
    const day = isoDay(ts);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

const IG_TYPE = { REELS: 'reel', STORY: 'story', CAROUSEL_ALBUM: 'carousel', IMAGE: 'image', VIDEO: 'video' };

/** One Instagram post: the media fields, and its lifetime insights where answered. */
export function foldInstagramMedia(media, insights = []) {
  const metric = Object.fromEntries(insights.map((item) => [item?.name, scalar(item)]));
  const likes = metric.likes ?? numberOrNull(media.like_count);
  const comments = metric.comments ?? numberOrNull(media.comments_count);
  const shares = metric.shares ?? null;
  const saves = metric.saved ?? null;
  const engagement = metric.total_interactions ?? sumKnown([likes, comments, shares, saves]);
  return {
    external_id: String(media.id),
    published_at: new Date(media.timestamp).toISOString(),
    media_type: IG_TYPE[media.media_product_type] ?? IG_TYPE[media.media_type] ?? (media.media_type ? String(media.media_type).toLowerCase() : null),
    caption_excerpt: captionExcerpt(media.caption),
    permalink: media.permalink ?? null,
    thumbnail_url: media.thumbnail_url ?? (media.media_type === 'VIDEO' ? null : media.media_url ?? null),
    views: metric.views ?? null,
    reach: metric.reach ?? null,
    likes,
    comments,
    shares,
    saves,
    follows: metric.follows ?? null,
    engagement
  };
}

/** One Page post: reactions, comments and shares are fields; views and reach are insights. */
export function foldPagePost(post, insights = []) {
  const metric = {};
  for (const item of insights) {
    const column = META_METRICS.facebookPost[item?.name];
    if (column) metric[column] = scalar(item);
  }
  const likes = numberOrNull(post.reactions?.summary?.total_count);
  const comments = numberOrNull(post.comments?.summary?.total_count);
  // No `shares` object means nobody shared it: Meta omits the field at zero.
  const shares = post.shares ? numberOrNull(post.shares.count) : 0;
  return {
    external_id: String(post.id),
    published_at: new Date(post.created_time).toISOString(),
    media_type: post.status_type ? String(post.status_type).replace(/_/g, ' ').toLowerCase() : null,
    caption_excerpt: captionExcerpt(post.message),
    permalink: post.permalink_url ?? null,
    thumbnail_url: post.full_picture ?? null,
    views: metric.views ?? null,
    reach: metric.reach ?? null,
    likes,
    comments,
    shares,
    saves: null,
    follows: null,
    engagement: sumKnown([likes, comments, shares])
  };
}

/**
 * Follower demographics, one breakdown per request. Gender comes back as
 * F / M / U and is written out; the other keys are kept as Meta gives them
 * (« 25-34 », « FR », « Paris, Île-de-France »).
 */
export function foldAudience(dimension, insights = []) {
  const item = insights.find((i) => i?.name === META_METRICS.instagramAudience.metric);
  const results = item?.total_value?.breakdowns?.[0]?.results ?? [];
  const gender = { F: 'female', M: 'male', U: 'unknown' };
  const out = [];
  for (const result of results) {
    const raw = result?.dimension_values?.[0];
    const value = numberOrNull(result?.value);
    if (raw === undefined || raw === null || value === null) continue;
    out.push({ dimension, key: dimension === 'gender' ? gender[raw] ?? String(raw).toLowerCase() : String(raw), value });
  }
  return out;
}

/** The count and value of one action type in Meta's `actions` / `action_values` arrays. */
export function actionValue(list, actionType) {
  if (!Array.isArray(list)) return 0;
  const hit = list.find((a) => a?.action_type === actionType);
  return hit ? numberOrNull(hit.value) ?? 0 : 0;
}

/**
 * Daily ad insights (one row per day and publisher platform) -> `ad_days`.
 * Days with the same publisher are summed, which only matters if Meta ever
 * splits one, and keeps the primary key unique either way.
 */
export function foldAdInsights(rows = [], { currency, conversionAction = DEFAULT_META_CONVERSION_ACTION } = {}) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row?.date_start) continue;
    const publisher = normalisePublisher(row.publisher_platform);
    const key = `${row.date_start}|${publisher}`;
    const current = byKey.get(key) ?? {
      day: row.date_start,
      publisher,
      currency: row.account_currency ?? currency,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value: 0
    };
    current.spend = round2(current.spend + (numberOrNull(row.spend) ?? 0));
    current.impressions += numberOrNull(row.impressions) ?? 0;
    current.clicks += numberOrNull(row.clicks) ?? 0;
    current.conversions = round2(current.conversions + actionValue(row.actions, conversionAction));
    current.conversion_value = round2(current.conversion_value + actionValue(row.action_values, conversionAction));
    byKey.set(key, current);
  }
  return [...byKey.values()].filter((r) => r.currency);
}

function sumKnown(values) {
  const known = values.filter((v) => v !== null && v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Campaign list rows -> `ad_campaigns` (without account/shop ids). */
export function foldMetaCampaigns(campaigns = []) {
  return campaigns
    .filter((c) => c?.id)
    .map((c) => ({
      external_id: String(c.id),
      name: c.name ?? null,
      status: c.effective_status ?? c.status ?? null,
      objective: c.objective ?? null
    }));
}

/**
 * Daily campaign-level ad insights -> `ad_campaign_days`. Same conversion rule
 * as the account level (one action type), so the two never disagree on what a
 * conversion is.
 */
export function foldCampaignInsights(rows = [], { currency, conversionAction = DEFAULT_META_CONVERSION_ACTION } = {}) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row?.date_start || !row?.campaign_id) continue;
    const key = `${row.campaign_id}|${row.date_start}`;
    const current = byKey.get(key) ?? {
      campaign_id: String(row.campaign_id),
      campaign_name: row.campaign_name ?? null,
      day: row.date_start,
      currency: row.account_currency ?? currency,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value: 0
    };
    current.spend = round2(current.spend + (numberOrNull(row.spend) ?? 0));
    current.impressions += numberOrNull(row.impressions) ?? 0;
    current.clicks += numberOrNull(row.clicks) ?? 0;
    current.conversions = round2(current.conversions + actionValue(row.actions, conversionAction));
    current.conversion_value = round2(current.conversion_value + actionValue(row.action_values, conversionAction));
    byKey.set(key, current);
  }
  return [...byKey.values()].filter((r) => r.currency);
}
