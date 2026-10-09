import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tiktokConfig } from './tiktok-client.mjs';

// Connecting Meta and Google through OAuth: the app's own credentials, the
// consent URLs, and the `state` that ties a provider's answer to the person
// who asked.
//
// THE APP'S CREDENTIALS ARE ENV, THE SHOP'S TOKEN IS VAULT. `META_APP_ID` and
// friends identify this application to the provider and are the same for every
// shop it serves; they are set once, on Vercel (the callback), Render (the
// worker's sync) and GitHub Actions (the nightly). The token a person grants
// belongs to their shop and goes in Vault (70_social.sql). DECISIONS § Insights
// → "Social and paid".
//
// A PROVIDER WITHOUT CREDENTIALS IS NOT HIDDEN: `socialAppConfig` names what is
// missing, and the dashboard draws Connect disabled with that reason.

/** Pinned so a provider's version bump is a one-line, reviewed change. Env wins. */
export const DEFAULT_META_GRAPH_VERSION = 'v23.0';
export const DEFAULT_GOOGLE_ADS_API_VERSION = 'v21';

/**
 * What a Meta connection asks for. Read-only, every one:
 *   pages_show_list, pages_read_engagement, read_insights — the Page and its figures
 *   pages_read_user_content — the Page's own posts (`/{page}/posts`); without it
 *     Meta answers « (#10) This endpoint requires the 'pages_read_user_content'
 *     permission » — measured on the first real connect, 2026-10-07
 *   instagram_basic, instagram_manage_insights — the Instagram account linked to it
 *   ads_read — ad account insights
 *   business_management — Pages and ad accounts owned through a Business portfolio
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'read_insights',
  'instagram_basic',
  'instagram_manage_insights',
  'ads_read',
  'business_management'
];

/** Google Ads has one scope, and it is read/write by Google's design; the code only reads. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/adwords'];

export const STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const STATE_COOKIE = 'qos_social_oauth';

/**
 * The app credentials, and what is missing for each provider.
 * @param {Record<string, string | undefined>} env
 */
export function socialAppConfig(env = process.env) {
  const value = (name) => {
    const v = env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const missing = (names) => names.filter((name) => !value(name));

  const stateSecret = value('SOCIAL_OAUTH_STATE_SECRET');
  const stateMissing = stateSecret && stateSecret.length >= 32 ? [] : ['SOCIAL_OAUTH_STATE_SECRET'];

  const metaMissing = missing(['META_APP_ID', 'META_APP_SECRET']);
  // No developer token: Google sunset them on 2026-09-09; access now belongs to
  // the Cloud project that owns the OAuth client (google-ads-client.mjs).
  const googleMissing = missing(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);

  return {
    tiktok: tiktokConfig(env),
    publicUrl: value('PUBLIC_APP_URL'),
    stateSecret,
    meta: {
      appId: value('META_APP_ID'),
      appSecret: value('META_APP_SECRET'),
      graphVersion: value('META_GRAPH_VERSION') ?? DEFAULT_META_GRAPH_VERSION,
      // Facebook Login for Business: a configuration id replaces the scope list
      // when set. Optional — the classic dialog with scopes works without it.
      loginConfigId: value('META_LOGIN_CONFIG_ID'),
      missing: metaMissing,
      // The sync needs only the app's own id/secret; Connect also needs the state secret.
      canSync: metaMissing.length === 0,
      canConnect: metaMissing.length === 0 && stateMissing.length === 0,
      connectMissing: [...metaMissing, ...stateMissing]
    },
    google: {
      clientId: value('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: value('GOOGLE_OAUTH_CLIENT_SECRET'),
      // Optional and ignored by Google since 2026-09-09; sent only if set.
      developerToken: value('GOOGLE_ADS_DEVELOPER_TOKEN'),
      apiVersion: value('GOOGLE_ADS_API_VERSION') ?? DEFAULT_GOOGLE_ADS_API_VERSION,
      missing: googleMissing,
      canSync: googleMissing.length === 0,
      canConnect: googleMissing.length === 0 && stateMissing.length === 0,
      connectMissing: [...googleMissing, ...stateMissing]
    }
  };
}

/** Where a provider sends the person back. Must match the app's registered URI exactly. */
export function redirectUri(origin, provider) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  return `${base}/api/settings/integrations/${provider}/callback`;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(payload, secret) {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * A signed, short-lived state: `<payload>.<signature>`. The payload names the
 * provider, the shop and the person, plus a nonce that is ALSO set in an
 * httpOnly cookie — so a state lifted from one browser cannot complete in
 * another.
 *
 * @param {{ provider: string, shopId: string, userId?: string | null, secret: string | null, now?: number, nonce?: string }} input
 */
export function createState({ provider, shopId, userId = null, secret, now = Date.now(), nonce = b64url(randomBytes(16)) }) {
  if (!secret) throw new Error('SOCIAL_OAUTH_STATE_SECRET is not set.');
  const payload = b64url(JSON.stringify({ p: provider, s: shopId, u: userId, n: nonce, t: now }));
  return { state: `${payload}.${sign(payload, secret)}`, nonce };
}

/**
 * @param {{ state: string | null | undefined, cookieNonce: string | null | undefined, provider: string, secret: string | null, now?: number, maxAgeMs?: number }} input
 * @returns {{ ok: true, provider: string, shopId: string, userId: string | null } | { ok: false, error: string }}
 */
export function verifyState({ state, cookieNonce, provider, secret, now = Date.now(), maxAgeMs = STATE_MAX_AGE_MS }) {
  if (!secret) return { ok: false, error: 'state_secret_missing' };
  const [payload, signature, extra] = String(state ?? '').split('.');
  if (!payload || !signature || extra !== undefined) return { ok: false, error: 'state_malformed' };

  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, error: 'state_signature' };

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'state_malformed' };
  }
  if (body?.p !== provider) return { ok: false, error: 'state_provider' };
  if (!cookieNonce || body.n !== cookieNonce) return { ok: false, error: 'state_browser' };
  if (typeof body.t !== 'number' || now - body.t > maxAgeMs || body.t - now > 60_000) return { ok: false, error: 'state_expired' };
  if (typeof body.s !== 'string' || !body.s) return { ok: false, error: 'state_malformed' };
  return { ok: true, provider: body.p, shopId: body.s, userId: body.u ?? null };
}

/** @param {{ appId: string, graphVersion?: string, redirect: string, state: string, loginConfigId?: string | null }} input */
export function metaAuthorizeUrl({ appId, graphVersion = DEFAULT_META_GRAPH_VERSION, redirect, state, loginConfigId = null }) {
  const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (loginConfigId) url.searchParams.set('config_id', loginConfigId);
  else url.searchParams.set('scope', META_SCOPES.join(','));
  return url.toString();
}

/** @param {{ clientId: string, redirect: string, state: string }} input */
export function googleAuthorizeUrl({ clientId, redirect, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  // offline + consent: the only way Google returns a refresh token, and it
  // returns one only on a fresh consent — a reconnect without `prompt=consent`
  // would come back with an access token that dies in an hour.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}
