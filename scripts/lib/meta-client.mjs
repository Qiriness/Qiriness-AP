import { createHmac } from 'node:crypto';

import { DEFAULT_META_GRAPH_VERSION } from './social-oauth.mjs';

/**
 * The Meta Graph API: Instagram, Facebook Pages and the Marketing API, read
 * only. One function per call the sync makes; how answers become rows lives in
 * meta-insights.mjs, which is pure and tested.
 *
 * EVERY CALL CARRIES `appsecret_proof`, the HMAC of the token under the app
 * secret, so a token lifted from a log could not be replayed by another app.
 *
 * ERRORS. Rate limits (codes 4, 17, 32, 613, 80000-80014) are waited out with
 * backoff, up to MAX_RETRIES. An expired or revoked token (code 190) is a
 * `MetaError` with `needsReconnect`, which the sync records on the connection
 * so the dashboard says « Reconnect » instead of « failed ».
 *
 * The token never leaves this module: not in an error, not in a log line. A
 * `paging.next` URL carries it, so URLs are reduced to their path before they
 * are named anywhere.
 */

const GRAPH = 'https://graph.facebook.com';
const MAX_RETRIES = 4;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const isRateLimit = (code) => RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014);

export function appSecretProof(token, appSecret) {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

export function createMetaClient({
  token,
  appSecret,
  graphVersion = DEFAULT_META_GRAPH_VERSION,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = () => {}
}) {
  if (!token) throw new Error('No Meta token.');
  if (!appSecret) throw new Error('META_APP_SECRET is not set.');

  async function request(pathOrUrl, params = {}, { asToken = token } = {}) {
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`${GRAPH}/${graphVersion}/${pathOrUrl.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    url.searchParams.set('access_token', asToken);
    url.searchParams.set('appsecret_proof', appSecretProof(asToken, appSecret));

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url.toString(), { cache: 'no-store' });
      } catch (error) {
        throw new MetaError({ what: pathOf(url), message: error instanceof Error ? error.message : String(error) });
      }
      const payload = await response.json().catch(() => null);
      if (response.ok && !payload?.error) return payload;

      const error = payload?.error ?? {};
      const code = Number(error.code);
      if ((isRateLimit(code) || response.status >= 500) && attempt < MAX_RETRIES) {
        const wait = Math.min(2 ** attempt * 15, 120);
        log(`Meta ${isRateLimit(code) ? 'rate limit' : `HTTP ${response.status}`} on ${pathOf(url)}; waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      throw new MetaError({ what: pathOf(url), status: response.status, code, subcode: error.error_subcode, message: error.message });
    }
  }

  /** Every item of a paged edge. `max` stops early on edges that go back years. */
  async function paged(path, params = {}, { asToken, max = Infinity, stop } = {}) {
    const out = [];
    let page = await request(path, params, { asToken });
    for (;;) {
      for (const item of page?.data ?? []) {
        if (stop?.(item)) return out;
        out.push(item);
        if (out.length >= max) return out;
      }
      const next = page?.paging?.next;
      if (!next) return out;
      // `next` already carries every parameter, the token included; request()
      // re-sets the token and proof, which keeps the URL honest if Meta ever
      // stops echoing them.
      page = await request(next, {}, { asToken });
    }
  }

  /**
   * Insights for one object, tolerant of metrics Meta no longer answers.
   *
   * Meta rejects the WHOLE request when one metric name is invalid (code 100),
   * and it retires metric names often. So a rejected batch is retried one
   * metric at a time, and the ones still refused are returned as `failed`
   * rather than failing the account: a missing metric becomes a null (not
   * measured), never a zero, and never a lost night.
   */
  async function insights(objectId, metrics, params = {}, { asToken } = {}) {
    try {
      const page = await request(`${objectId}/insights`, { ...params, metric: metrics.join(',') }, { asToken });
      return { data: page?.data ?? [], failed: [] };
    } catch (error) {
      if (!(error instanceof MetaError) || error.code !== 100) throw error;
      if (metrics.length === 1) return { data: [], failed: metrics };
    }
    const data = [];
    const failed = [];
    for (const metric of metrics) {
      try {
        const page = await request(`${objectId}/insights`, { ...params, metric }, { asToken });
        data.push(...(page?.data ?? []));
      } catch (error) {
        if (error instanceof MetaError && error.code === 100) failed.push(metric);
        else throw error;
      }
    }
    return { data, failed };
  }

  return {
    request,
    paged,
    insights,

    me() {
      return request('me', { fields: 'id,name' });
    },

    /** The token's granted permissions: what the person actually ticked. */
    async grantedScopes() {
      const page = await request('me/permissions');
      return (page?.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
    },

    /** Pages the person can see, each with its own token and linked Instagram account. */
    listPages() {
      return paged('me/accounts', {
        fields: 'id,name,username,access_token,instagram_business_account{id,username,name}',
        limit: 100
      });
    },

    listAdAccounts() {
      return paged('me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: 100 });
    },

    instagramProfile(igId) {
      return request(igId, { fields: 'id,username,name,followers_count,media_count' });
    },

    /** Media newest first, until `since` (a Date) is passed. */
    instagramMedia(igId, since) {
      return paged(
        `${igId}/media`,
        { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: 50 },
        { stop: (item) => since && new Date(item.timestamp) < since }
      );
    },

    pagePosts(pageId, pageToken, since) {
      return paged(
        `${pageId}/posts`,
        {
          fields: 'id,message,created_time,permalink_url,full_picture,status_type,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)',
          limit: 50
        },
        { asToken: pageToken, stop: (item) => since && new Date(item.created_time) < since }
      );
    },

    pageProfile(pageId, pageToken) {
      return request(pageId, { fields: 'id,name,username,followers_count,fan_count' }, { asToken: pageToken });
    },

    /** Daily account-level ad insights, split by publisher platform. */
    adInsights(adAccountId, { since, until }) {
      return paged(`act_${adAccountId}/insights`, {
        level: 'account',
        time_increment: 1,
        breakdowns: 'publisher_platform',
        fields: 'spend,impressions,clicks,actions,action_values,account_currency',
        time_range: { since, until },
        limit: 500
      });
    },

    /** Every campaign of an ad account, any status: name, status, objective. */
    listCampaigns(adAccountId) {
      return paged(`act_${adAccountId}/campaigns`, { fields: 'id,name,status,effective_status,objective', limit: 200 });
    },

    /** Daily campaign-level ad insights. A campaign with no delivery that day has no row. */
    campaignInsights(adAccountId, { since, until }) {
      return paged(`act_${adAccountId}/insights`, {
        level: 'campaign',
        time_increment: 1,
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency',
        time_range: { since, until },
        limit: 500
      });
    }
  };
}

/** Exchange an OAuth code for a short-lived user token, then for a long-lived one. */
export async function exchangeMetaCode({ appId, appSecret, redirect, code, graphVersion = DEFAULT_META_GRAPH_VERSION, fetchImpl = fetch }) {
  const short = await tokenCall(
    `${GRAPH}/${graphVersion}/oauth/access_token`,
    { client_id: appId, client_secret: appSecret, redirect_uri: redirect, code },
    fetchImpl
  );
  const long = await tokenCall(
    `${GRAPH}/${graphVersion}/oauth/access_token`,
    { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token },
    fetchImpl
  );
  const expiresIn = Number(long.expires_in);
  return {
    token: long.access_token,
    // Meta sometimes omits expires_in on a long-lived token; ~60 days is its documented life.
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 3600) * 1000)
  };
}

async function tokenCall(endpoint, params, fetchImpl) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), { cache: 'no-store' });
  } catch (error) {
    throw new MetaError({ what: 'oauth/access_token', message: error instanceof Error ? error.message : String(error) });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error || !payload?.access_token) {
    const error = payload?.error ?? {};
    throw new MetaError({ what: 'oauth/access_token', status: response.status, code: Number(error.code), message: error.message ?? 'no token returned' });
  }
  return payload;
}

export class MetaError extends Error {
  constructor({ what, status = null, code = null, subcode = null, message = '' }) {
    super(`Meta ${what} failed${status ? `: HTTP ${status}` : ''}${code ? ` (code ${code})` : ''}${message ? ` — ${String(message).slice(0, 300)}` : ''}`);
    this.name = 'MetaError';
    this.status = status;
    this.code = Number.isFinite(code) ? code : null;
    this.subcode = subcode ?? null;
    // 190: the token expired, was revoked, or the password changed. 102: session.
    this.needsReconnect = code === 190 || code === 102;
  }
}

/** The path without query string, version or ids that look like tokens. */
function pathOf(url) {
  const u = url instanceof URL ? url : new URL(url);
  return u.pathname.replace(/^\/v\d+\.\d+\//, '');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
