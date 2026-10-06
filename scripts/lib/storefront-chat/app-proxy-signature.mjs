import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shopify app proxy signatures — how the storefront chat endpoint knows a
 * request came through a store's /apps/... path and which store it was.
 *
 * Shopify appends `shop`, `logged_in_customer_id`, `path_prefix`, `timestamp`
 * and `signature` to the query of every proxied request. The signature is a
 * hex HMAC-SHA256, keyed with the app's client secret, over every OTHER query
 * parameter as `key=value` (repeated keys joined with `,`), sorted, and
 * concatenated with nothing between them. Shopify may add parameters later, so
 * every parameter is signed over, not a known list.
 *
 * A signature only proves the query was not tampered with; the caller still
 * checks the shop against its allow-list. `logged_in_customer_id` is signed but
 * deliberately unused: the advisor is anonymous.
 */

/** A replay older than this is refused. Shopify signs at forwarding time. */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

/** The message Shopify signs: every parameter but `signature`, sorted. */
export function signedMessage(searchParams) {
  const grouped = new Map();
  for (const [key, value] of searchParams) {
    if (key === 'signature') continue;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return [...grouped].map(([key, values]) => `${key}=${values.join(',')}`).sort().join('');
}

export function signAppProxyQuery(searchParams, secret) {
  return createHmac('sha256', secret).update(signedMessage(searchParams)).digest('hex');
}

/**
 * @param {URLSearchParams} searchParams the proxied request's query
 * @param {string} secret the app's client secret
 * @returns {{ ok: true, shop: string } | { ok: false, reason: 'missing' | 'mismatch' | 'stale' }}
 */
export function verifyAppProxySignature(searchParams, secret, { nowMs = Date.now(), maxAgeSeconds = MAX_SIGNATURE_AGE_SECONDS } = {}) {
  const provided = searchParams.get('signature');
  const shop = searchParams.get('shop');
  if (!secret || !provided || !shop) return { ok: false, reason: 'missing' };

  const expected = Buffer.from(signAppProxyQuery(searchParams, secret), 'utf8');
  const given = Buffer.from(provided, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'mismatch' };
  }

  const timestamp = Number(searchParams.get('timestamp'));
  if (!Number.isFinite(timestamp) || Math.abs(nowMs / 1000 - timestamp) > maxAgeSeconds) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, shop: shop.toLowerCase() };
}

/** `STOREFRONT_CHAT_ALLOWED_SHOPS`, comma-separated *.myshopify.com domains. Empty allows nobody. */
export function parseAllowedShops(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}
