import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAllowedShops, signAppProxyQuery, signedMessage, verifyAppProxySignature } from './app-proxy-signature.mjs';

const SECRET = 'hush';
const NOW_MS = 1317327555 * 1000;

test('signs exactly as Shopify documents it', () => {
  // The worked example from shopify.dev "Authenticate app proxies".
  const params = new URLSearchParams('extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555');
  assert.equal(
    signedMessage(params),
    'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555'
  );
});

function signed(query, secret = SECRET) {
  const params = new URLSearchParams(query);
  params.set('signature', signAppProxyQuery(params, secret));
  return params;
}

test('a correctly signed, fresh request passes and names its shop', () => {
  const params = signed('shop=Dev-Store.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fstorefront-advisor&timestamp=1317327555');
  assert.deepEqual(verifyAppProxySignature(params, SECRET, { nowMs: NOW_MS }), { ok: true, shop: 'dev-store.myshopify.com' });
});

test('a tampered parameter fails', () => {
  const params = signed('shop=dev-store.myshopify.com&timestamp=1317327555');
  params.set('shop', 'other.myshopify.com');
  assert.deepEqual(verifyAppProxySignature(params, SECRET, { nowMs: NOW_MS }), { ok: false, reason: 'mismatch' });
});

test('another app\'s secret fails', () => {
  const params = signed('shop=dev-store.myshopify.com&timestamp=1317327555', 'other-secret');
  assert.equal(verifyAppProxySignature(params, SECRET, { nowMs: NOW_MS }).reason, 'mismatch');
});

test('an old signature is a replay', () => {
  const params = signed('shop=dev-store.myshopify.com&timestamp=1317327555');
  assert.equal(verifyAppProxySignature(params, SECRET, { nowMs: NOW_MS + 301_000 }).reason, 'stale');
});

test('no secret, no signature or no shop is refused before any hashing', () => {
  const params = signed('shop=dev-store.myshopify.com&timestamp=1317327555');
  assert.equal(verifyAppProxySignature(params, '', { nowMs: NOW_MS }).reason, 'missing');
  assert.equal(verifyAppProxySignature(new URLSearchParams('shop=x&timestamp=1'), SECRET).reason, 'missing');
  assert.equal(verifyAppProxySignature(signed('timestamp=1317327555'), SECRET, { nowMs: NOW_MS }).reason, 'missing');
});

test('the allow-list is lower-cased, trimmed, and empty means nobody', () => {
  assert.deepEqual([...parseAllowedShops(' A.myshopify.com, b.myshopify.com ,')], ['a.myshopify.com', 'b.myshopify.com']);
  assert.equal(parseAllowedShops(undefined).size, 0);
});
