// The vocabulary of social and paid media, named once.
//
// Isomorphic and dependency-free: the sync, the dashboard's services and the
// browser bundle all read it. The check constraints in 70_social.sql mirror
// these lists and 70_social.test.mjs holds the two together.

/** Who a connection is made with, through OAuth. */
export const SOCIAL_PROVIDERS = ['meta', 'google', 'tiktok'];

/**
 * What a connection can see. `instagram` and `facebook` are ORGANIC accounts;
 * `meta_ads` and `google_ads` are PAID ones. One provider sees several kinds.
 */
export const SOCIAL_KINDS = ['instagram', 'facebook', 'meta_ads', 'google_ads', 'tiktok'];

export const ORGANIC_KINDS = ['instagram', 'facebook', 'tiktok'];
export const PAID_KINDS = ['meta_ads', 'google_ads'];

export const PROVIDER_OF_KIND = {
  instagram: 'meta',
  facebook: 'meta',
  meta_ads: 'meta',
  google_ads: 'google',
  tiktok: 'tiktok'
};

/**
 * Where an ad was shown. Meta reports `publisher_platform`; Google reports an
 * ad network type, folded here into four.
 */
export const AD_PUBLISHERS = [
  'facebook',
  'instagram',
  'audience_network',
  'messenger',
  'threads',
  'google_search',
  'google_display',
  'youtube',
  'google_other',
  'other'
];

export const AUDIENCE_DIMENSIONS = ['gender', 'age', 'country', 'city'];

/**
 * Networks listed in Connections that cannot be connected yet. Drawn as
 * « Coming soon », never in the platform selector: a network nobody can connect
 * would only ever show an empty panel.
 */
export const UPCOMING_NETWORKS = ['youtube', 'pinterest'];

/** Keep a publisher inside the vocabulary; anything new reads as `other`. */
export function normalisePublisher(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return AD_PUBLISHERS.includes(key) ? key : 'other';
}

/**
 * The first 140 characters of a caption, on one line. Null when there is none.
 *
 * CUT BY CHARACTER, NOT BY UTF-16 UNIT. `String.slice` counts an emoji as two
 * units and can split it, leaving a lone surrogate; JSON.stringify writes that
 * as an escaped half-pair, which Postgres refuses, and PostgREST answers
 * « Empty or invalid json » for the whole batch. That is what stopped the first
 * Facebook post sync (2026-10-07). `Array.from` iterates code points — the unit
 * Postgres's `char_length` and the 140-character check count in.
 */
export function captionExcerpt(caption) {
  const chars = Array.from(String(caption ?? '').replace(/\s+/g, ' ').trim());
  if (!chars.length) return null;
  return chars.length <= 140 ? chars.join('') : `${chars.slice(0, 139).join('')}…`;
}

/**
 * Where a campaign opens in its platform's own interface.
 *
 * NEITHER PLATFORM DOCUMENTS THESE URLS. Meta's Ads Manager takes `act` and
 * `selected_campaign_ids`; Google Ads takes the customer as `__e` and the
 * campaign as `campaignId`, and Google states its UI URLs may change at any
 * time. They are built here, once, so a link that stops working is one line
 * to fix. Null when the ids needed are missing.
 *
 * @param {{ kind: string, accountExternalId: string | null, campaignId: string | null }} input
 * @returns {string | null}
 */
export function campaignUrl({ kind, accountExternalId, campaignId }) {
  if (!accountExternalId || !campaignId) return null;
  const account = encodeURIComponent(String(accountExternalId).replace(/^act_/, ''));
  const campaign = encodeURIComponent(String(campaignId));
  if (kind === 'meta_ads') return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account}&selected_campaign_ids=${campaign}`;
  if (kind === 'google_ads') return `https://ads.google.com/aw/overview?__e=${account.replace(/-/g, '')}&campaignId=${campaign}`;
  return null;
}

/**
 * How a platform's engagement rate is divided. Interactions are always the
 * numerator; the team picks the denominator per platform, one at a time:
 *   followers — interactions / followers (the account's size)
 *   reach     — interactions / reach (unique accounts that saw the post)
 *   views     — interactions / views (plays and impressions; TikTok's habit)
 * `reach` is the default: it is what the panel computed before the choice existed.
 */
export const ENGAGEMENT_BASES = ['followers', 'reach', 'views'];
export const DEFAULT_ENGAGEMENT_BASIS = 'reach';
