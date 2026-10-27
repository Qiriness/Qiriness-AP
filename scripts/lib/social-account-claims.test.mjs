import assert from 'node:assert/strict';
import test from 'node:test';

import { setAccountEnabled, runSocialSync } from './social-sync.mjs';

// One account counts for one shop (social-account-claims.mjs): an agency login
// connected to a second shop must not start counting the first shop's accounts.

/** A PostgREST stand-in holding `social_accounts`, filtered the way the client asks. */
function fakeAccounts(accounts) {
  const rows = accounts.map((a, i) => ({ id: `acc-${i + 1}`, provider: 'meta', name: null, ...a }));
  const calls = [];
  const original = globalThis.fetch;
  const matches = (row, params) =>
    [...params].filter(([k]) => !['select', 'limit', 'order', 'on_conflict'].includes(k)).every(([k, v]) => {
      if (v.startsWith('neq.')) return String(row[k]) !== v.slice(4);
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(row[k]));
      return String(row[k]) === v.replace(/^eq\./, '');
    });
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: parsed.pathname, params: parsed.searchParams, body });
    let answer = [];
    if (parsed.pathname.endsWith('/social_accounts')) {
      if (method === 'GET') answer = rows.filter((r) => matches(r, parsed.searchParams));
      if (method === 'PATCH') answer = rows.filter((r) => matches(r, parsed.searchParams)).map((r) => Object.assign(r, body));
      if (method === 'POST') {
        for (const incoming of body) {
          const found = rows.find((r) => r.shop_id === incoming.shop_id && r.kind === incoming.kind && r.external_id === incoming.external_id);
          if (found) Object.assign(found, incoming);
          else rows.push({ id: `acc-${rows.length + 1}`, enabled: true, ...incoming });
        }
        answer = body;
      }
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: { baseUrl: 'https://db.test/rest/v1', key: 'sb_secret_test' }, rows, calls, restore: () => (globalThis.fetch = original) };
}

test('switching on an account another shop tracks is refused; one nobody tracks is not', async () => {
  const db = fakeAccounts([
    { shop_id: 'shop-a', kind: 'meta_ads', external_id: '111', enabled: true },
    { shop_id: 'shop-b', kind: 'meta_ads', external_id: '111', enabled: false },
    { shop_id: 'shop-b', kind: 'meta_ads', external_id: '222', enabled: false }
  ]);
  try {
    assert.deepEqual(await setAccountEnabled({ supabase: db.client, shopId: 'shop-b', accountId: 'acc-2', enabled: true }), { refused: 'tracked_elsewhere' });
    assert.equal(db.rows[1].enabled, false);
    assert.equal((await setAccountEnabled({ supabase: db.client, shopId: 'shop-b', accountId: 'acc-3', enabled: true }))?.enabled, true);
    // Switching off is never refused, and an account of another shop is not this shop's to change.
    assert.equal((await setAccountEnabled({ supabase: db.client, shopId: 'shop-a', accountId: 'acc-1', enabled: false }))?.enabled, false);
    assert.equal(await setAccountEnabled({ supabase: db.client, shopId: 'shop-b', accountId: 'acc-1', enabled: true }), null);
  } finally {
    db.restore();
  }
});

test('a re-discovery adds another shop\'s tracked account switched off, and leaves known accounts alone', async () => {
  const db = fakeAccounts([
    { shop_id: 'shop-a', kind: 'facebook', external_id: 'page-a', enabled: true },
    { shop_id: 'shop-b', kind: 'facebook', external_id: 'page-b-old', enabled: false }
  ]);
  const ENV = { META_APP_ID: 'app', META_APP_SECRET: 'secret', SOCIAL_OAUTH_STATE_SECRET: 'x'.repeat(40) };
  const meta = {
    listPages: async () => [
      { id: 'page-a', name: 'Shop A page' },
      { id: 'page-b', name: 'Shop B page' },
      { id: 'page-b-old', name: 'Shop B old page' }
    ],
    listAdAccounts: async () => []
  };
  const original = db.restore;
  try {
    // Connected as shop B; a sync re-discovers what the login sees, then reads enabled accounts.
    const connection = { provider: 'meta', secret_id: 's', token_expires_at: '2099-01-01T00:00:00Z' };
    const base = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/social_connections')) return new Response(JSON.stringify([connection]), { status: 200 });
      if (path.endsWith('/rpc/social_read_token')) return new Response(JSON.stringify('token'), { status: 200 });
      return base(url, init);
    };
    await runSocialSync({
      supabase: db.client,
      shopRow: { id: 'shop-b' },
      provider: 'meta',
      env: ENV,
      createMeta: () => ({ ...meta, pageInsightsDaily: async () => [], igInsightsDaily: async () => [], listPosts: async () => [] })
    }).catch(() => {});
    const page = (shop, id) => db.rows.find((r) => r.shop_id === shop && r.external_id === id);
    assert.equal(page('shop-b', 'page-a')?.enabled, false, 'shop A tracks it, so shop B gets it switched off');
    assert.equal(page('shop-b', 'page-b')?.enabled, true, 'nobody tracks it: the default, on');
    assert.equal(page('shop-b', 'page-b-old')?.enabled, false, 'already known: its choice is kept');
    assert.equal(page('shop-a', 'page-a')?.enabled, true, 'shop A untouched');
  } finally {
    original();
  }
});
