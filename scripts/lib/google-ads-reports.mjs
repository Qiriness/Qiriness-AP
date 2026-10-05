// What the Google Ads API answers, folded into rows for 70_social.sql. Pure.
//
// REST answers in camelCase (`metrics.costMicros`), and every int64 arrives as
// a STRING. Money is in micros of the account's currency.

/** One customer's own identity. */
export const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account FROM customer LIMIT 1';

/** A manager account's direct clients — what a person reaching ads through an agency MCC sees. */
export const CLIENTS_QUERY =
  'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level = 1';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Spend, impressions, clicks and conversions per day and network, both ends inclusive. */
export function dailyQuery(since, until) {
  if (!DAY.test(since) || !DAY.test(until)) throw new Error(`dailyQuery takes YYYY-MM-DD dates; got ${since} – ${until}.`);
  return (
    'SELECT segments.date, segments.ad_network_type, customer.currency_code, ' +
    'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
    `FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`
  );
}

/** Google's ad network types, folded into the publishers `ad_days` knows. */
export function publisherOfNetwork(network) {
  switch (String(network ?? '').toUpperCase()) {
    case 'SEARCH':
    case 'SEARCH_PARTNERS':
      return 'google_search';
    case 'CONTENT':
      return 'google_display';
    case 'YOUTUBE':
    case 'YOUTUBE_SEARCH':
    case 'YOUTUBE_WATCH':
      return 'youtube';
    default:
      return 'google_other';
  }
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** searchStream rows -> `ad_days` rows (without account/shop ids). */
export function foldDaily(rows = [], { currency = null } = {}) {
  const byKey = new Map();
  for (const row of rows) {
    const day = row?.segments?.date;
    if (!day) continue;
    const publisher = publisherOfNetwork(row.segments.adNetworkType);
    const key = `${day}|${publisher}`;
    const current = byKey.get(key) ?? {
      day,
      publisher,
      currency: row.customer?.currencyCode ?? currency,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value: 0
    };
    current.spend = round2(current.spend + num(row.metrics?.costMicros) / 1e6);
    current.impressions += num(row.metrics?.impressions);
    current.clicks += num(row.metrics?.clicks);
    current.conversions = round2(current.conversions + num(row.metrics?.conversions));
    current.conversion_value = round2(current.conversion_value + num(row.metrics?.conversionsValue));
    byKey.set(key, current);
  }
  return [...byKey.values()].filter((r) => r.currency);
}

/**
 * The ad accounts a person can read, from what they reach directly and, for a
 * manager, its clients. A manager itself serves no ads and is not listed. An
 * account reachable both ways is listed once, direct, because direct access
 * needs no login-customer-id.
 *
 * @param {Array<{ id: string, customer?: object, clients?: object[], error?: string }>} reached
 */
export function foldDiscovery(reached = []) {
  const accounts = new Map();
  for (const entry of reached) {
    const customer = entry.customer;
    if (!customer) continue;
    if (!customer.manager) {
      accounts.set(String(customer.id), {
        external_id: String(customer.id),
        name: customer.descriptiveName ?? null,
        currency: customer.currencyCode ?? null,
        login_customer_id: null
      });
      continue;
    }
    for (const client of entry.clients ?? []) {
      const c = client.customerClient;
      if (!c || c.manager || (c.status && c.status !== 'ENABLED')) continue;
      const id = String(c.id);
      if (accounts.has(id)) continue;
      accounts.set(id, { external_id: id, name: c.descriptiveName ?? null, currency: c.currencyCode ?? null, login_customer_id: String(customer.id) });
    }
  }
  return [...accounts.values()];
}

/** Per campaign and day, both ends inclusive. Campaigns with no delivery return no row. */
export function campaignDailyQuery(since, until) {
  if (!DAY.test(since) || !DAY.test(until)) throw new Error(`campaignDailyQuery takes YYYY-MM-DD dates; got ${since} – ${until}.`);
  return (
    'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, customer.currency_code, ' +
    'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
    `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`
  );
}

/**
 * searchStream rows -> `ad_campaigns` and `ad_campaign_days` (without account
 * / shop ids). A campaign's name and status are taken from its latest row.
 */
export function foldCampaignDaily(rows = [], { currency = null } = {}) {
  const campaigns = new Map();
  const days = new Map();
  for (const row of rows) {
    const id = row?.campaign?.id;
    const day = row?.segments?.date;
    if (!id || !day) continue;
    const prior = campaigns.get(String(id));
    if (!prior || prior.day <= day) {
      campaigns.set(String(id), {
        day,
        external_id: String(id),
        name: row.campaign.name ?? null,
        status: row.campaign.status ?? null,
        objective: row.campaign.advertisingChannelType ?? null
      });
    }
    const key = `${id}|${day}`;
    const current = days.get(key) ?? {
      campaign_id: String(id),
      day,
      currency: row.customer?.currencyCode ?? currency,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value: 0
    };
    current.spend = round2(current.spend + num(row.metrics?.costMicros) / 1e6);
    current.impressions += num(row.metrics?.impressions);
    current.clicks += num(row.metrics?.clicks);
    current.conversions = round2(current.conversions + num(row.metrics?.conversions));
    current.conversion_value = round2(current.conversion_value + num(row.metrics?.conversionsValue));
    days.set(key, current);
  }
  return {
    campaigns: [...campaigns.values()].map(({ day, ...c }) => c),
    days: [...days.values()].filter((r) => r.currency)
  };
}
