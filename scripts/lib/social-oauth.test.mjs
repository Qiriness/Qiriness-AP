import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createState,
  googleAuthorizeUrl,
  metaAuthorizeUrl,
  redirectUri,
  socialAppConfig,
  STATE_MAX_AGE_MS,
  verifyState
} from './social-oauth.mjs';

const SECRET = 'x'.repeat(40);
const SHOP = '00000000-0000-0000-0000-000000000001';

test('a provider without credentials names what is missing, and cannot connect', () => {
  const config = socialAppConfig({ META_APP_ID: '1', SOCIAL_OAUTH_STATE_SECRET: SECRET });
  assert.deepEqual(config.meta.missing, ['META_APP_SECRET']);
  assert.equal(config.meta.canConnect, false);
  assert.equal(config.google.canConnect, false);
  assert.deepEqual(config.google.missing, ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
});

test('Google Ads needs no developer token: the OAuth client is enough', () => {
  const config = socialAppConfig({ GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's', SOCIAL_OAUTH_STATE_SECRET: SECRET });
  assert.equal(config.google.canConnect, true);
  assert.equal(config.google.developerToken, null);
});

test('a short state secret blocks connecting, not syncing', () => {
  const config = socialAppConfig({ META_APP_ID: '1', META_APP_SECRET: 's', SOCIAL_OAUTH_STATE_SECRET: 'short' });
  assert.equal(config.meta.canSync, true);
  assert.equal(config.meta.canConnect, false);
  assert.deepEqual(config.meta.connectMissing, ['SOCIAL_OAUTH_STATE_SECRET']);
});

test('the redirect URI is the callback route under the origin', () => {
  assert.equal(redirectUri('https://app.example/', 'meta'), 'https://app.example/api/settings/integrations/meta/callback');
});

test('a state round-trips in the browser that started it', () => {
  const { state, nonce } = createState({ provider: 'meta', shopId: SHOP, userId: 'u1', secret: SECRET, now: 1000 });
  assert.deepEqual(verifyState({ state, cookieNonce: nonce, provider: 'meta', secret: SECRET, now: 2000 }), {
    ok: true,
    provider: 'meta',
    shopId: SHOP,
    userId: 'u1'
  });
});

test('a state is refused when tampered, replayed elsewhere, for another provider, or late', () => {
  const { state, nonce } = createState({ provider: 'meta', shopId: SHOP, secret: SECRET, now: 0 });
  const [payload, signature] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'meta', s: 'other-shop', u: null, n: nonce, t: 0 })).toString('base64url');

  assert.equal(verifyState({ state: `${forged}.${signature}`, cookieNonce: nonce, provider: 'meta', secret: SECRET, now: 1 }).error, 'state_signature');
  assert.equal(verifyState({ state, cookieNonce: 'another-browser', provider: 'meta', secret: SECRET, now: 1 }).error, 'state_browser');
  assert.equal(verifyState({ state, cookieNonce: undefined, provider: 'meta', secret: SECRET, now: 1 }).error, 'state_browser');
  assert.equal(verifyState({ state, cookieNonce: nonce, provider: 'google', secret: SECRET, now: 1 }).error, 'state_provider');
  assert.equal(verifyState({ state, cookieNonce: nonce, provider: 'meta', secret: SECRET, now: STATE_MAX_AGE_MS + 1 }).error, 'state_expired');
  assert.equal(verifyState({ state, cookieNonce: nonce, provider: 'meta', secret: 'y'.repeat(40), now: 1 }).error, 'state_signature');
  assert.equal(verifyState({ state: `${payload}`, cookieNonce: nonce, provider: 'meta', secret: SECRET, now: 1 }).error, 'state_malformed');
});

test('Meta asks for scopes, or for a Login for Business configuration when one is set', () => {
  const classic = new URL(metaAuthorizeUrl({ appId: 'A', redirect: 'https://x/cb', state: 'S', graphVersion: 'v23.0' }));
  assert.equal(classic.pathname, '/v23.0/dialog/oauth');
  assert.match(classic.searchParams.get('scope'), /ads_read/);
  assert.equal(classic.searchParams.get('config_id'), null);

  const business = new URL(metaAuthorizeUrl({ appId: 'A', redirect: 'https://x/cb', state: 'S', loginConfigId: 'C' }));
  assert.equal(business.searchParams.get('config_id'), 'C');
  assert.equal(business.searchParams.get('scope'), null);
});

test('Google asks for offline access with a fresh consent, or no refresh token comes back', () => {
  const url = new URL(googleAuthorizeUrl({ clientId: 'C', redirect: 'https://x/cb', state: 'S' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
});
