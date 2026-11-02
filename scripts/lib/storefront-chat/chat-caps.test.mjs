import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_CAP_DEFAULTS, createChatCapsCache, effectiveCaps, readChatCaps, saveChatCaps, validateCap } from './chat-caps.mjs';

test('a cap is a whole number within its bounds; empty is the default, never zero', () => {
  assert.deepEqual(validateCap('daily', 5000), { ok: true, value: 5000 });
  assert.deepEqual(validateCap('daily', ' 5000 '), { ok: true, value: 5000 });
  assert.deepEqual(validateCap('session', ''), { ok: true, value: null });
  assert.deepEqual(validateCap('session', null), { ok: true, value: null });
  for (const bad of [0, -1, 2.5, 'abc', 100001, true]) assert.equal(validateCap('daily', bad).ok, false, String(bad));
  assert.equal(validateCap('session', 501).ok, false);
  assert.equal(validateCap('weekly', 3).ok, false);
});

test('what applies: the stored number, else the default; a stored value out of bounds is not trusted', () => {
  assert.deepEqual(effectiveCaps(null), CHAT_CAP_DEFAULTS);
  assert.deepEqual(effectiveCaps({ daily: 5000, session: null }), { daily: 5000, session: CHAT_CAP_DEFAULTS.session });
  assert.deepEqual(effectiveCaps({ daily: 0, session: 9999 }), CHAT_CAP_DEFAULTS);
});

const CLIENT = { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' };

/** PostgREST double: answers GETs with `rows`, PATCHes with what was sent; every request recorded. */
function stubServer(rows) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, url: new URL(url), body });
    const answer = method === 'GET' ? rows : [{ id: 'shop-1' }];
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return requests;
}

test('read and save address the shop by its domain; a refused value writes nothing', async () => {
  const realFetch = globalThis.fetch;
  try {
    let requests = stubServer([{ id: 'shop-1', storefront_chat_daily_cap: 5000, storefront_chat_session_cap: null }]);
    assert.deepEqual(await readChatCaps(CLIENT, 'x.myshopify.com'), { shopId: 'shop-1', daily: 5000, session: null });
    assert.ok(requests[0].url.pathname.endsWith('/shops'));
    assert.equal(requests[0].url.searchParams.get('shop_domain'), 'eq.x.myshopify.com');

    requests = stubServer([]);
    assert.equal(await readChatCaps(CLIENT, 'missing.myshopify.com'), null);

    requests = stubServer([]);
    assert.equal((await saveChatCaps(CLIENT, 'x.myshopify.com', { daily: 5000, session: 0 })).ok, false);
    assert.equal(requests.length, 0, 'nothing written for a refused value');

    requests = stubServer([]);
    assert.deepEqual(await saveChatCaps(CLIENT, 'x.myshopify.com', { daily: '5000', session: '' }), { ok: true, value: { daily: 5000, session: null } });
    assert.equal(requests[0].method, 'PATCH');
    assert.deepEqual(requests[0].body, { storefront_chat_daily_cap: 5000, storefront_chat_session_cap: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the cache reads once a minute per shop, and a failed read keeps the last value, else the defaults', async () => {
  let clock = 0;
  let reads = 0;
  let fail = false;
  const cache = createChatCapsCache(async () => {
    reads += 1;
    if (fail) throw new Error('column does not exist');
    return { daily: 5000, session: 30 };
  }, { now: () => clock });
  assert.deepEqual(await cache('a'), { daily: 5000, session: 30 });
  clock = 59_000;
  await cache('a');
  assert.equal(reads, 1);
  clock = 61_000;
  fail = true;
  assert.deepEqual(await cache('a'), { daily: 5000, session: 30 }, 'last known value');
  assert.deepEqual(await cache('b'), CHAT_CAP_DEFAULTS, 'never read: the defaults');
});
