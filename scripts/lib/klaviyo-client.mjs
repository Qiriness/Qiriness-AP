/**
 * The Klaviyo REST API, private-key authenticated. One function per call the
 * sync makes; everything about how the answers are folded into rows lives in
 * klaviyo-reports.mjs, which is pure and tested.
 *
 * RATE LIMITS. The reporting endpoints are the tight ones: 1 request a second
 * burst, 2 a minute steady, 225 a day (Klaviyo's reference, read 2026-09-25).
 * A 429 carries Retry-After, which is waited out — up to MAX_RETRIES times —
 * rather than failing a backfill halfway.
 *
 * The key never leaves this module: not in an error, not in a log line.
 */

export const KLAVIYO_BASE_URL = 'https://a.klaviyo.com/api';
export const KLAVIYO_REVISION = '2026-07-15';

const MAX_RETRIES = 4;
const MAX_WAIT_SECONDS = 90;

export function createKlaviyoClient(apiKey, { fetchImpl = fetch, sleep = defaultSleep, log = () => {} } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('No Klaviyo private key.');
  const key = apiKey.trim();

  async function request(path, { method = 'GET', body } = {}) {
    const url = path.startsWith('http') ? path : `${KLAVIYO_BASE_URL}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Klaviyo-API-Key ${key}`,
            accept: 'application/vnd.api+json',
            revision: KLAVIYO_REVISION,
            ...(body ? { 'content-type': 'application/vnd.api+json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store'
        });
      } catch (error) {
        throw new Error(`Klaviyo ${method} ${pathOf(url)} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const wait = Math.min(Number(response.headers.get('retry-after')) || 30, MAX_WAIT_SECONDS);
        log(`Klaviyo rate limit on ${pathOf(url)}; waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new KlaviyoError(response.status, `${method} ${pathOf(url)}`, firstErrorDetail(payload));
      }
      return payload;
    }
  }

  return {
    /** Every metric on the account, all pages. */
    async listMetrics() {
      const out = [];
      let next = '/metrics/';
      while (next) {
        const page = await request(next);
        out.push(...(page?.data ?? []));
        next = page?.links?.next ?? null;
      }
      return out;
    },

    /** Every campaign on one channel (`email` or `sms`), all pages. */
    async listCampaigns(channel) {
      const out = [];
      let next = `/campaigns/?filter=${encodeURIComponent(`equals(messages.channel,'${channel}')`)}`;
      while (next) {
        const page = await request(next);
        out.push(...(page?.data ?? []));
        next = page?.links?.next ?? null;
      }
      return out;
    },

    flowSeriesReport(body) {
      return request('/flow-series-reports/', { method: 'POST', body });
    },

    campaignValuesReport(body) {
      return request('/campaign-values-reports/', { method: 'POST', body });
    }
  };
}

export class KlaviyoError extends Error {
  constructor(status, what, detail) {
    super(`Klaviyo ${what} failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'KlaviyoError';
    this.status = status;
  }
}

/** Klaviyo's JSON:API error text, which names the missing scope on a 403. */
function firstErrorDetail(payload) {
  const error = payload?.errors?.[0];
  if (!error) return '';
  return String(error.detail || error.title || '').slice(0, 300);
}

/** The path without its query string: enough to say which call failed. */
function pathOf(url) {
  return url.replace(KLAVIYO_BASE_URL, '').split('?')[0];
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
