// The vocabulary of social and paid media, named once.
//
// Isomorphic and dependency-free: the sync, the dashboard's services and the
// browser bundle all read it. The check constraints in 70_social.sql mirror
// these lists and 70_social.test.mjs holds the two together.

/** Who a connection is made with, through OAuth. */
export const SOCIAL_PROVIDERS = ['meta', 'google'];

/**
 * What a connection can see. `instagram` and `facebook` are ORGANIC accounts;
 * `meta_ads` and `google_ads` are PAID ones. One provider sees several kinds.
 */
export const SOCIAL_KINDS = ['instagram', 'facebook', 'meta_ads', 'google_ads'];

export const ORGANIC_KINDS = ['instagram', 'facebook'];
export const PAID_KINDS = ['meta_ads', 'google_ads'];

export const PROVIDER_OF_KIND = {
  instagram: 'meta',
  facebook: 'meta',
  meta_ads: 'meta',
  google_ads: 'google'
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
export const UPCOMING_NETWORKS = ['tiktok', 'youtube', 'pinterest'];

/** Keep a publisher inside the vocabulary; anything new reads as `other`. */
export function normalisePublisher(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return AD_PUBLISHERS.includes(key) ? key : 'other';
}

/** The first 140 characters of a caption, on one line. Null when there is none. */
export function captionExcerpt(caption) {
  const flat = String(caption ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= 140 ? flat : `${flat.slice(0, 139)}…`;
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
