import { DEFAULT_GOOGLE_ADS_API_VERSION } from './social-oauth.mjs';

/**
 * The Google Ads API over REST, read only. Authentication is the shop's refresh
 * token (Vault) and this app's OAuth client (env). How rows are built from
 * answers lives in google-ads-reports.mjs, which is pure.
 *
 * NO DEVELOPER TOKEN. Google sunset developer tokens on 2026-09-09: API access
 * levels (Test / Basic / Standard) now belong to the Google Cloud project that
 * owns the OAuth client, and the `developer-token` header is "optional and
 * ignored by the API servers". It is still sent when GOOGLE_ADS_DEVELOPER_TOKEN
 * is set, which costs nothing and keeps an old token working, but nothing
 * requires it. DECISIONS § Insights → « Social and paid ».
 *
 * A REFUSED REFRESH TOKEN (`invalid_grant`) is a `GoogleAdsError` with
 * `needsReconnect`: the person revoked access, or the OAuth consent screen is
 * still in « Testing », where Google expires refresh tokens after 7 days.
 *
 * Tokens never leave this module: not in an error, not in a log line.
 */

const ADS = 'https://googleads.googleapis.com';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const MAX_RETRIES = 4;

export function createGoogleAdsClient({
  refreshToken,
  clientId,
  clientSecret,
  developerToken = null,
  apiVersion = DEFAULT_GOOGLE_ADS_API_VERSION,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = () => {},
  now = () => Date.now()
}) {
  if (!refreshToken) throw new Error('No Google refresh token.');
  if (!clientId || !clientSecret) throw new Error('The Google Ads OAuth client is not set.');

  let cached = null;

  async function accessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    let response;
    try {
      response = await fetchImpl(OAUTH_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, cache: 'no-store' });
    } catch (error) {
      throw new GoogleAdsError({ what: 'oauth token', message: error instanceof Error ? error.message : String(error) });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
      throw new GoogleAdsError({
        what: 'oauth token',
        status: response.status,
        code: payload?.error ?? null,
        message: payload?.error_description ?? payload?.error ?? 'no access token returned'
      });
    }
    cached = { token: payload.access_token, expiresAt: now() + (Number(payload.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  async function request(path, { method = 'GET', body, loginCustomerId = null } = {}) {
    const url = `${ADS}/${apiVersion}/${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const headers = {
        Authorization: `Bearer ${await accessToken()}`,
        ...(developerToken ? { 'developer-token': developerToken } : {}),
        ...(loginCustomerId ? { 'login-customer-id': String(loginCustomerId) } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      };
      let response;
      try {
        response = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      } catch (error) {
        throw new GoogleAdsError({ what: path, message: error instanceof Error ? error.message : String(error) });
      }
      const payload = await response.json().catch(() => null);
      if (response.ok) return payload;

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const wait = Math.min(2 ** attempt * 10, 120);
        log(`Google Ads HTTP ${response.status} on ${path}; waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (response.status === 401) cached = null;
      const error = Array.isArray(payload) ? payload[0]?.error : payload?.error;
      const detail = error?.details?.[0]?.errors?.[0];
      throw new GoogleAdsError({
        what: path,
        status: response.status,
        code: detail?.errorCode ? Object.values(detail.errorCode)[0] : error?.status ?? null,
        message: detail?.message ?? error?.message ?? ''
      });
    }
  }

  return {
    /** Customer ids the person can reach directly, as bare digits. */
    async listAccessibleCustomers() {
      const payload = await request('customers:listAccessibleCustomers');
      return (payload?.resourceNames ?? []).map((name) => String(name).replace(/^customers\//, ''));
    },

    /** Every row of a GAQL query, flattened out of searchStream's batches. */
    async search(customerId, query, { loginCustomerId = null } = {}) {
      const batches = await request(`customers/${customerId}/googleAds:searchStream`, { method: 'POST', body: { query }, loginCustomerId });
      return (Array.isArray(batches) ? batches : [batches]).flatMap((batch) => batch?.results ?? []);
    }
  };
}

/** Exchange an OAuth code for a refresh token. No refresh token is a refusal, not a partial success. */
export async function exchangeGoogleCode({ clientId, clientSecret, redirect, code, fetchImpl = fetch }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect });
  let response;
  try {
    response = await fetchImpl(OAUTH_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, cache: 'no-store' });
  } catch (error) {
    throw new GoogleAdsError({ what: 'oauth code exchange', message: error instanceof Error ? error.message : String(error) });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GoogleAdsError({ what: 'oauth code exchange', status: response.status, code: payload?.error ?? null, message: payload?.error_description ?? '' });
  }
  if (!payload?.refresh_token) {
    throw new GoogleAdsError({ what: 'oauth code exchange', message: 'Google returned no refresh token. Remove the app from your Google account permissions and connect again.' });
  }
  return { refreshToken: payload.refresh_token, scopes: String(payload.scope ?? '').split(' ').filter(Boolean) };
}

export class GoogleAdsError extends Error {
  constructor({ what, status = null, code = null, message = '' }) {
    super(`Google Ads ${what} failed${status ? `: HTTP ${status}` : ''}${code ? ` (${code})` : ''}${message ? ` — ${String(message).slice(0, 300)}` : ''}`);
    this.name = 'GoogleAdsError';
    this.status = status;
    this.code = code;
    this.needsReconnect = code === 'invalid_grant' || code === 'unauthorized_client';
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
