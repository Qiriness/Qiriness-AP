/**
 * Which marketing channel a session or an attributed order belongs to, and
 * which connected provider (Google Ads, Meta Ads, Klaviyo…) may claim it.
 *
 * WHY THIS IS OURS AND NOT SHOPIFY'S `traffic_type`. Shopify marks a visit
 * `paid` whenever it carries tracking parameters, so every Klaviyo click is
 * `paid` (measured 2026-11-25: klaviyo | paid | Klaviyo | email, 1,718 sessions
 * in 30 days). Comparing « Google Ads » with every Google visit would also
 * credit Google Ads with organic search. So the group is decided here, from the
 * four dimensions ShopifyQL gives on BOTH `sessions` and `sales`:
 * `referring_channel`, `traffic_type`, `utm_source`, `utm_medium`.
 *
 * THE RULES, in order (first match wins):
 *  1. no channel and no UTM                          -> unknown
 *  2. utm_medium is an email medium, the channel is a
 *     mail client (gmail, orange…) or the source an ESP -> email
 *  3. utm_medium is an affiliate medium              -> affiliate
 *  4. utm_medium = product_sync (free product listings) -> organic_search
 *  5. a social network                               -> paid_social when PAID, else organic_social
 *  6. a search engine                                -> paid_search when PAID, else organic_search
 *  7. a paid medium from anywhere else               -> other
 *  8. direct                                         -> direct
 *  9. anything else with a referrer                  -> referral
 *
 * PAID is decided by `utm_medium` when the visit has one (cpc, paid_social…),
 * and only otherwise by Shopify's `traffic_type`: without a UTM, `paid` means
 * an ad click id (gclid, fbclid). An Instagram bio link tagged
 * `utm_medium=social` is therefore organic even though Shopify calls it paid.
 *
 * The word lists are facts about the web (what gmail is, what cpc means), not
 * about one shop. A shop with its own conventions adds to them; nothing here
 * names a brand ([[keep-it-reusable-across-companies]]).
 */

export const CHANNEL_GROUPS = Object.freeze([
  'paid_search',
  'paid_social',
  'email',
  'organic_search',
  'organic_social',
  'direct',
  'referral',
  'affiliate',
  'other',
  'unknown'
]);

/** Groups whose cost is advertising spend: what MER, CAC and ROAS divide by. */
export const PAID_GROUPS = Object.freeze(['paid_search', 'paid_social']);

const set = (...words) => new Set(words);

const EMAIL_MEDIUMS = set('email', 'e-mail', 'mail', 'newsletter', 'emailing', 'crm');
const EMAIL_SOURCES = set('klaviyo', 'mailchimp', 'brevo', 'sendinblue', 'shopify_email', 'orderlyemails', 'omnisend', 'splio', 'newsletter');
/** Webmail and mail-security hosts a click from a mail arrives through. */
const EMAIL_CHANNELS = set(
  'klaviyo', 'shopify_email', 'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'office', 'yahoo_mail', 'orange', 'sfr',
  'free', 'laposte', 'bbox', 'aol', 'icloud', 'gmx', 'web.de', 'proton', 'vadesecure', 'mailinblack'
);
const AFFILIATE_MEDIUMS = set('affiliate', 'affiliation', 'affiliates', 'partner', 'partnership');
const PAID_MEDIUMS = set(
  'cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'sem', 'cpm', 'cpv', 'display', 'banner', 'ads', 'ad',
  'paid_social', 'paidsocial', 'paid-social', 'social_paid', 'social-paid', 'retargeting', 'remarketing', 'shopping_ads'
);
/** Free product listings (Google's Shopping tab, synced by the Shopify Google channel). Organic, though it is « shopping ». */
const FREE_LISTING_MEDIUMS = set('product_sync');

const GOOGLE = set('google', 'syndicatedsearch', 'googlesyndication', 'doubleclick', 'googleadservices', 'youtube_ads');
const SEARCH = set(...GOOGLE, 'bing', 'yahoo!', 'yahoo', 'ecosia', 'qwant', 'duckduckgo', 'naver', 'baidu', 'yandex', 'brave', 'startpage', 'lilo');
const META = set('facebook', 'instagram', 'an', 'fb', 'ig', 'messenger', 'threads', 'audience_network', 'meta');
const SOCIAL = set(...META, 'tiktok', 'pinterest', 'snapchat', 'linkedin', 'youtube', 'x', 'twitter', 't.co', 'reddit');

const clean = (value) => (value === null || value === undefined ? '' : String(value).trim().toLowerCase());

/**
 * The visit's four dimensions, normalised. `utm_source` is cut at the first
 * hyphen too, so `fb-SiteLink` reads as `fb`.
 */
export function trafficKey(row = {}) {
  const source = clean(row.utm_source ?? row.utmSource);
  return {
    channel: clean(row.referring_channel ?? row.channel),
    trafficType: clean(row.traffic_type ?? row.trafficType),
    source,
    sourceRoot: source.split(/[-_ ]/)[0],
    medium: clean(row.utm_medium ?? row.utmMedium)
  };
}

const isPaid = (key) => (key.medium ? PAID_MEDIUMS.has(key.medium) : key.trafficType === 'paid');
const inFamily = (key, family) => family.has(key.channel) || family.has(key.source) || family.has(key.sourceRoot);

/** The channel group of one row (see the rules above). */
export function classifyTraffic(row = {}) {
  const key = trafficKey(row);
  const noChannel = !key.channel || key.channel === 'unknown';
  if (noChannel && !key.source && !key.medium) return 'unknown';
  if (EMAIL_MEDIUMS.has(key.medium) || EMAIL_SOURCES.has(key.source) || EMAIL_SOURCES.has(key.sourceRoot) || EMAIL_CHANNELS.has(key.channel)) {
    return 'email';
  }
  if (AFFILIATE_MEDIUMS.has(key.medium)) return 'affiliate';
  if (FREE_LISTING_MEDIUMS.has(key.medium)) return 'organic_search';
  if (inFamily(key, SOCIAL)) return isPaid(key) ? 'paid_social' : 'organic_social';
  if (inFamily(key, SEARCH)) return isPaid(key) ? 'paid_search' : 'organic_search';
  if (key.medium && PAID_MEDIUMS.has(key.medium)) return 'other';
  if (key.channel === 'direct' || (noChannel && key.trafficType === 'direct')) return 'direct';
  if (noChannel) return 'unknown';
  return 'referral';
}

/**
 * The providers a row can be credited to on the Shopify side. A provider is a
 * marketing integration whose own reporting we compare with Shopify's.
 *
 * ADDING ONE IS AN ENTRY HERE, not a dashboard change: `kind` is the account
 * kind its spend is stored under (`social_accounts.kind`, null for an owned
 * channel such as email), `group` the channel group it lives in, `family` the
 * channel / source names that are its own. Google Ads is the paid-search rows
 * from Google's family (not Bing); Meta Ads the paid-social rows from Meta's;
 * Klaviyo the email rows whose source or channel is Klaviyo.
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'google_ads', kind: 'google_ads', group: 'paid_search', family: GOOGLE, paid: true }),
  Object.freeze({ id: 'meta_ads', kind: 'meta_ads', group: 'paid_social', family: META, paid: true }),
  Object.freeze({ id: 'klaviyo', kind: null, group: 'email', family: set('klaviyo'), paid: false })
]);

/** The provider (by id) a row is credited to on Shopify's side, or null. */
export function providerOf(row = {}, group = classifyTraffic(row)) {
  const key = trafficKey(row);
  for (const provider of PROVIDERS) {
    if (provider.group === group && inFamily(key, provider.family)) return provider.id;
  }
  return null;
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A ShopifyQL row's metric, whatever attribution suffix it carries:
 * `net_sales__last_non_direct_click` is read as `net_sales`.
 */
export function metric(row, name) {
  if (row[name] !== undefined) return num(row[name]);
  const prefix = `${name}__`;
  for (const [key, value] of Object.entries(row)) if (key.startsWith(prefix)) return num(value);
  return 0;
}

const SESSION_FIELDS = Object.freeze({
  sessions: 'sessions',
  cartSessions: 'sessions_with_cart_additions',
  checkoutSessions: 'sessions_that_reached_checkout',
  convertedSessions: 'sessions_that_completed_checkout'
});
const SALES_FIELDS = Object.freeze({ netSales: 'net_sales', totalSales: 'total_sales', orders: 'orders', newCustomers: 'new_customers' });

/** Sums of the session and sales counts of rows, keyed by what `keyOf` returns (rows it maps to null are skipped). */
export function foldRows(rows = [], keyOf, fields) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    const acc = out.get(key) ?? Object.fromEntries(Object.keys(fields).map((f) => [f, 0]));
    for (const [field, column] of Object.entries(fields)) acc[field] += metric(row, column);
    out.set(key, acc);
  }
  return out;
}

export const foldSessions = (rows, keyOf) => foldRows(rows, keyOf, SESSION_FIELDS);
export const foldSales = (rows, keyOf) => foldRows(rows, keyOf, SALES_FIELDS);

/** Sessions per channel group. */
export const sessionsByGroup = (rows) => foldSessions(rows, (row) => classifyTraffic(row));
/** Attributed sales per channel group. */
export const salesByGroup = (rows) => foldSales(rows, (row) => classifyTraffic(row));
/** Sessions credited to each provider. */
export const sessionsByProvider = (rows) => foldSessions(rows, (row) => providerOf(row));
/** Attributed sales credited to each provider. */
export const salesByProvider = (rows) => foldSales(rows, (row) => providerOf(row));

/** Attributed sales per UTM campaign within one provider (campaign name as Shopify recorded it). */
export function salesByCampaign(rows = [], providerId) {
  return foldSales(rows, (row) => (providerOf(row) === providerId ? String(row.utm_campaign ?? '') || null : null));
}

/** Sessions per UTM campaign within one provider. */
export function sessionsByCampaign(rows = [], providerId) {
  return foldSessions(rows, (row) => (providerOf(row) === providerId ? String(row.utm_campaign ?? '') || null : null));
}
