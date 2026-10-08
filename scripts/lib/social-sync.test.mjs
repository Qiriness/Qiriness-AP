import assert from 'node:assert/strict';
import test from 'node:test';

import { MetaError } from './meta-client.mjs';
import { connectMeta, daysToRead, IG_FIRST_DAYS, runSocialSync } from './social-sync.mjs';

const SHOP = { id: 'shop-1' };
const NOW = new Date('2026-10-04T10:00:00Z');
const ENV = {
  META_APP_ID: 'app',
  META_APP_SECRET: 'secret',
  SOCIAL_OAUTH_STATE_SECRET: 'x'.repeat(40),
  GOOGLE_OAUTH_CLIENT_ID: 'c',
  GOOGLE_OAUTH_CLIENT_SECRET: 's'
};

/** A PostgREST stand-in on the global fetch: records every request, answers from `respond`. */
function fakeSupabase(respond) {
  const calls = [];
  const client = { baseUrl: 'https://db.test/rest/v1', key: 'sb_secret_test' };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: decodeURIComponent(String(url)), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const payload = respond(call) ?? [];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client, calls, restore: () => (globalThis.fetch = original) };
}

const upserts = (calls, table) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/${table}?on_conflict=`));

test('days to read: a first window, then the trailing days plus one step back until the history is full', () => {
  const first = daysToRead({ today: '2026-10-04', oldest: null, firstDays: 30, trailingDays: 3, historyDays: 365, deepenDays: 30 });
  assert.equal(first.length, 30);
  assert.equal(first[0], '2026-09-05');
  assert.equal(first.at(-1), '2026-10-04');

  const later = daysToRead({ today: '2026-10-04', oldest: '2026-09-05', firstDays: 30, trailingDays: 3, historyDays: 365, deepenDays: 30 });
  assert.equal(later.length, 33);
  assert.equal(later[0], '2026-08-06');
  assert.deepEqual(later.slice(-3), ['2026-10-02', '2026-10-03', '2026-10-04']);

  const full = daysToRead({ today: '2026-10-04', oldest: '2025-10-05', firstDays: 30, trailingDays: 3, historyDays: 365, deepenDays: 30 });
  assert.deepEqual(full, ['2026-10-02', '2026-10-03', '2026-10-04']);
});

test('a Meta login that sees nothing is refused and nothing is saved', async () => {
  const db = fakeSupabase(() => null);
  const graph = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/oauth/access_token')) return Response.json({ access_token: 'tok', expires_in: 5184000 });
    return Response.json({ data: [] });
  };
  try {
    const out = await connectMeta({ supabase: db.client, shopId: SHOP.id, code: 'c', redirect: 'https://x/cb', env: ENV, fetchImpl: graph });
    assert.equal(out.ok, false);
    assert.match(out.error, /sees no Facebook Page/);
    assert.equal(db.calls.some((c) => c.url.includes('/rpc/social_save_token')), false);
  } finally {
    db.restore();
  }
});

test('Meta without app credentials is not offered, and the reason names them', async () => {
  const out = await connectMeta({ supabase: {}, shopId: SHOP.id, code: 'c', redirect: 'r', env: {} });
  assert.match(out.error, /META_APP_ID, META_APP_SECRET/);
});

function fakeMeta(overrides = {}) {
  return {
    listPages: async () => [{ id: 'P1', name: 'Page', access_token: 'page-token', instagram_business_account: { id: 'IG1', username: 'brand' } }],
    listAdAccounts: async () => [],
    instagramMedia: async () => [
      { id: 'M1', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-10-03T08:00:00+0000', like_count: 10, comments_count: 2, caption: 'New' },
      { id: 'M0', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-01-03T08:00:00+0000', like_count: 50, comments_count: 5, caption: 'Old' }
    ],
    insights: async (id, metrics, params) => {
      if (params?.breakdown === 'follow_type') return { data: [], failed: metrics };
      if (params?.breakdown) return { data: [], failed: metrics };
      if (id === 'IG1') return { data: [{ name: 'views', total_value: { value: 100 } }], failed: ['profile_links_taps'] };
      if (id === 'M1') return { data: [{ name: 'reach', values: [{ value: 400 }] }, { name: 'total_interactions', values: [{ value: 30 }] }], failed: [] };
      return { data: [], failed: [] };
    },
    instagramProfile: async () => ({ followers_count: 21419 }),
    pagePosts: async () => [],
    pageProfile: async () => ({ followers_count: 17946 }),
    adInsights: async () => [],
    ...overrides
  };
}

function metaDb({ enabled = ['instagram'] } = {}) {
  return fakeSupabase(metaRespond({ enabled }));
}

function metaRespond({ enabled = ['instagram'] } = {}) {
  return (call) => {
    if (call.url.includes('/social_connections?select=provider')) return [{ provider: 'meta', last_sync_status: null }];
    if (call.url.includes('/rpc/social_read_token')) return 'user-token';
    if (call.url.includes('/social_accounts?select=') && call.url.includes('enabled=eq.true')) {
      return enabled.map((kind) => ({ id: `acc-${kind}`, provider: 'meta', kind, external_id: kind === 'instagram' ? 'IG1' : 'P1', name: kind, enabled: true }));
    }
    if (call.url.includes('/social_connections?select=conversion_action')) return [{ conversion_action: null }];
    return [];
  };
}

test('a first Instagram sync: 30 days, followers apart, every post listed and the recent ones read', async () => {
  const db = metaDb();
  try {
    const results = await runSocialSync({ supabase: db.client, shopRow: SHOP, env: ENV, now: NOW, log: () => {}, createMeta: () => fakeMeta() });
    assert.equal(results.meta.status, 'ok');
    assert.deepEqual(results.meta.unanswered.sort(), ['instagram:follower_demographics:age', 'instagram:follower_demographics:city', 'instagram:follower_demographics:country', 'instagram:follower_demographics:gender', 'instagram:follows_and_unfollows', 'instagram:profile_links_taps']);

    const days = upserts(db.calls, 'social_account_days');
    const metricRows = days.flatMap((c) => c.body).filter((r) => 'views' in r);
    assert.equal(metricRows.length, IG_FIRST_DAYS);
    assert.ok(metricRows.every((r) => !('followers' in r)), 'a metrics row never carries followers');
    const today = metricRows.find((r) => r.day === '2026-10-04');
    assert.equal(today.views, 100);
    assert.equal(today.link_taps, null, 'an unanswered metric is not measured, not zero');
    assert.equal(metricRows.find((r) => r.day === '2026-10-03').posts, 1);
    assert.equal(today.posts, 0, 'no post that day is a measured zero');

    const followerRows = days.flatMap((c) => c.body).filter((r) => 'followers' in r);
    assert.deepEqual(followerRows, [{ account_id: 'acc-instagram', shop_id: 'shop-1', day: '2026-10-04', followers: 21419 }]);

    const posts = upserts(db.calls, 'social_posts');
    assert.equal(posts.length, 2, 'fields and insights are two upserts');
    assert.deepEqual(posts[0].body.map((r) => r.external_id), ['M1', 'M0']);
    assert.ok(posts[0].body.every((r) => !('reach' in r)), 'the fields upsert never erases insights');
    assert.deepEqual(
      posts[1].body.map((r) => [r.external_id, r.reach, r.engagement, r.insights_at]),
      [
        ['M1', 400, 30, NOW.toISOString()],
        ['M0', null, 55, NOW.toISOString()]
      ],
      'the recent post is read, and so is an older post never read before'
    );

    const status = db.calls.find((c) => c.method === 'PATCH' && c.url.includes('/social_connections?'));
    assert.equal(status.body.last_sync_status, 'ok');
  } finally {
    db.restore();
  }
});

test('an older post already read is not read again; a recent one is', async () => {
  let pages = 0;
  const db = fakeSupabase((call) => {
    // One page, then the empty page that ends the paging.
    if (call.url.includes('/social_posts?select=external_id')) return pages++ === 0 ? [{ external_id: 'M0' }] : [];
    return metaRespond()(call);
  });
  const asked = [];
  try {
    await runSocialSync({
      supabase: db.client,
      shopRow: SHOP,
      env: ENV,
      now: NOW,
      log: () => {},
      createMeta: () => {
        const meta = fakeMeta();
        return { ...meta, insights: async (id, ...rest) => (asked.push(id), meta.insights(id, ...rest)) };
      }
    });
    assert.ok(asked.includes('M1'));
    assert.ok(!asked.includes('M0'));
    const read = db.calls.find((c) => c.url.includes('/social_posts?select=external_id'));
    assert.match(read.url, /insights_at=not\.is\.null/);
  } finally {
    db.restore();
  }
});

test('a post Meta cannot answer at all does not blind the next post of its type', async () => {
  const db = metaDb();
  const asked = new Map();
  try {
    await runSocialSync({
      supabase: db.client,
      shopRow: SHOP,
      env: ENV,
      now: NOW,
      log: () => {},
      createMeta: () =>
        fakeMeta({
          instagramMedia: async () => [
            { id: 'A', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-10-03T08:00:00+0000' },
            { id: 'B', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-10-02T08:00:00+0000' }
          ],
          insights: async (id, metrics, params) => {
            if (id === 'A') return { data: [], failed: metrics };
            if (id === 'B') asked.set(id, metrics);
            if (params?.breakdown) return { data: [], failed: metrics };
            return { data: [], failed: [] };
          }
        })
    });
    assert.ok(asked.get('B').includes('views'), 'B is still asked for views');
  } finally {
    db.restore();
  }
});

test('a refused token marks the connection for reconnecting, and the night goes on', async () => {
  const db = metaDb();
  try {
    const expired = new MetaError({ what: 'me/accounts', code: 190, message: 'Session has expired' });
    const results = await runSocialSync({
      supabase: db.client,
      shopRow: SHOP,
      env: ENV,
      now: NOW,
      log: () => {},
      createMeta: () => fakeMeta({ listPages: async () => { throw expired; } })
    });
    assert.equal(results.meta.status, 'needs_reconnect');
    const status = db.calls.find((c) => c.method === 'PATCH' && c.url.includes('/social_connections?'));
    assert.equal(status.body.last_sync_status, 'needs_reconnect');
  } finally {
    db.restore();
  }
});

test('one account failing leaves the others synced and names itself', async () => {
  const db = metaDb({ enabled: ['instagram', 'facebook'] });
  try {
    const results = await runSocialSync({
      supabase: db.client,
      shopRow: SHOP,
      env: ENV,
      now: NOW,
      log: () => {},
      createMeta: () => fakeMeta({ listPages: async () => [{ id: 'OTHER', access_token: 't' }] })
    });
    assert.equal(results.meta.status, 'failed');
    assert.match(results.meta.error, /^facebook: Meta no longer gives this login a token for the Page/);
    assert.equal(results.meta.accounts, 1);
  } finally {
    db.restore();
  }
});

test('not connected, or no app credentials, is a skip', async () => {
  const db = fakeSupabase(() => []);
  try {
    assert.deepEqual(await runSocialSync({ supabase: db.client, shopRow: SHOP, provider: 'google', env: ENV, now: NOW }), {
      google: { status: 'skipped', reason: 'not connected' }
    });
  } finally {
    db.restore();
  }
  const connected = fakeSupabase((call) => (call.url.includes('/social_connections?select=provider') ? [{ provider: 'meta' }] : []));
  try {
    const results = await runSocialSync({ supabase: connected.client, shopRow: SHOP, env: {}, now: NOW });
    assert.equal(results.meta.status, 'skipped');
    assert.match(results.meta.reason, /META_APP_ID/);
  } finally {
    connected.restore();
  }
});

test('an ad account also writes its campaigns, and a campaign failure keeps the account totals', async () => {
  const db = fakeSupabase((call) => {
    if (call.url.includes('/social_connections?select=provider')) return [{ provider: 'meta' }];
    if (call.url.includes('/rpc/social_read_token')) return 'user-token';
    if (call.url.includes('/social_accounts?select=') && call.url.includes('enabled=eq.true')) {
      return [{ id: 'acc-ads', provider: 'meta', kind: 'meta_ads', external_id: '999', name: 'Ads', currency: 'EUR', enabled: true }];
    }
    if (call.url.includes('/social_connections?select=conversion_action')) return [{ conversion_action: null }];
    return [];
  });
  const ads = (overrides) =>
    fakeMeta({
      listPages: async () => [],
      adInsights: async () => [{ date_start: '2026-10-01', publisher_platform: 'instagram', spend: '5', impressions: '100', clicks: '3', account_currency: 'EUR' }],
      campaignInsights: async (_id, window) => [
        { campaign_id: '120', campaign_name: 'Gone', date_start: window.since, spend: '5', impressions: '100', clicks: '3', account_currency: 'EUR' }
      ],
      listCampaigns: async () => [],
      ...overrides
    });
  try {
    const ok = await runSocialSync({ supabase: db.client, shopRow: SHOP, env: ENV, now: NOW, log: () => {}, createMeta: () => ads({}) });
    assert.equal(ok.meta.status, 'ok');
    assert.equal(ok.meta.campaign_days, 13, 'first sync: 395 days in 13 windows, one delivering day each here');
    const campaigns = upserts(db.calls, 'ad_campaigns');
    assert.deepEqual(campaigns[0].body.map((c) => [c.external_id, c.name]), [['120', 'Gone']], 'a deleted campaign keeps its name from the insights');
    const days = upserts(db.calls, 'ad_campaign_days');
    assert.ok(days[0].body.every((d) => !('campaign_name' in d)));
    assert.equal(new Set(days[0].body.map((d) => d.day)).size, 13);

    db.calls.length = 0;
    const broken = await runSocialSync({
      supabase: db.client,
      shopRow: SHOP,
      env: ENV,
      now: NOW,
      log: () => {},
      createMeta: () => ads({ campaignInsights: async () => { throw new Error('Meta act_999/insights failed: HTTP 500'); } })
    });
    assert.equal(broken.meta.status, 'failed');
    assert.match(broken.meta.error, /Ads \(campaigns\): Meta act_999\/insights failed/);
    assert.equal(upserts(db.calls, 'ad_days').length, 1, 'the account totals were still written');
  } finally {
    db.restore();
  }
});
