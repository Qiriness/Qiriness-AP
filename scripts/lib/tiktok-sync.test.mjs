import assert from 'node:assert/strict';
import test from 'node:test';
import { runSocialSync } from './social-sync.mjs';
import { connectTikTok } from './tiktok-sync.mjs';
import { TikTokError, TIKTOK_SCOPES } from './tiktok-client.mjs';
import { runSocialJobs } from '../../agent/src/social/social-job-runner.mjs';

const env = { TIKTOK_CLIENT_KEY: 'dummy-key', TIKTOK_CLIENT_SECRET: 'dummy-secret', SOCIAL_OAUTH_STATE_SECRET: 'x'.repeat(40) };
const now = new Date('2026-10-09T10:00:00Z');
const bundle = { accessToken: 'dummy-access', refreshToken: 'dummy-refresh', openId: 'login-a', expiresAt: Date.now() + 86400000 };
const account = { id: 'a', kind: 'tiktok', provider: 'tiktok', external_id: 'login-a', enabled: true };
function database({ accounts = [account], token = bundle, existing = [] } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: new URL(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (call.url.hostname === 'open.tiktokapis.com') return Response.json({ error: { code: 'ok' }, data: call.url.pathname.includes('/user/info/') ? { user: profile } : { videos: [video], has_more: false } });
    let result = [];
    if (call.url.pathname.endsWith('/social_connections')) result = [{ provider: 'tiktok' }];
    if (call.url.pathname.endsWith('/social_read_token')) result = JSON.stringify(token);
    if (call.url.pathname.endsWith('/social_accounts') && call.method === 'GET') result = call.url.searchParams.has('external_id') ? existing : accounts;
    return Response.json(result);
  };
  return { calls, client: { baseUrl: 'https://db.test/rest/v1', key: 'dummy-service-key' }, restore() { globalThis.fetch = original; } };
}
const profile = { open_id: 'login-a', display_name: 'Dummy Brand', follower_count: 300 };
const video = { id: 'v1', create_time: now.getTime() / 1000 - 86400, view_count: 100, like_count: 8, comment_count: 2, share_count: 3 };
test('a claimed TikTok job runs the real shared sync and completes after writing its video metrics', async () => {
  const db = database();
  const done = [];
  try {
    const totals = await runSocialJobs({ supabase: db.client, shopId: 'shop-a', env, jobs: {
      claim: async () => [{ id: 'job-tiktok', payload: { provider: 'tiktok' } }],
      complete: async id => done.push(id), fail: async () => { assert.fail('The TikTok job should complete'); }
    } });
    assert.deepEqual(done, ['job-tiktok']);
    assert.equal(totals.ok, 1);
    assert.ok(db.calls.some(c => c.method === 'POST' && c.url.pathname.endsWith('/social_posts')));
  } finally { db.restore(); }
});
function sync(db, extra = {}) {
  return runSocialSync({ supabase: db.client, shopRow: { id: 'shop-a' }, env, now, log() {},
    createTikTok: () => ({ profile: async () => profile, videos: async () => ({ videos: [video], has_more: false }) }), ...extra });
}
test('shared worker/nightly entry point syncs TikTok lifetime posts and current follower snapshot only', async () => {
  const db = database();
  try {
    const cursors = [];
    const out = await sync(db, { createTikTok: () => ({ profile: async () => profile, videos: async cursor => {
      cursors.push(cursor);
      return cursor ? { videos: [{ ...video, id: 'old', create_time: now.getTime() / 1000 - 366 * 86400 }], has_more: true, cursor: 456 } : { videos: [video], has_more: true, cursor: 123 };
    } }) });
    assert.equal(out.tiktok.status, 'ok');
    assert.equal(out.tiktok.posts, 1);
    assert.deepEqual(cursors, [undefined, 123]);
    const day = db.calls.find(c => c.method === 'POST' && c.url.pathname.endsWith('/social_account_days')).body[0];
    assert.equal(day.shop_id, 'shop-a');
    assert.equal(day.followers, 300);
    assert.ok(!('views' in day) && !('engagement' in day));
    const post = db.calls.find(c => c.method === 'POST' && c.url.pathname.endsWith('/social_posts')).body[0];
    assert.equal(post.views, 100);
    assert.equal(post.engagement, 13);
    assert.equal(post.reach, null);
    assert.ok(!('non_followers_pct' in post));
    assert.equal(post.insights_at, now.toISOString());
    assert.ok(db.calls.some(c => c.method === 'PATCH' && c.body.last_sync_status === 'ok'));
  } finally { db.restore(); }
});
test('TikTok dry run reads but writes nothing', async () => {
  const db = database();
  try {
    assert.equal((await sync(db, { dryRun: true })).tiktok.status, 'ok');
    assert.ok(db.calls.every(c => c.method === 'GET' || c.url.pathname.endsWith('/social_read_token')));
  } finally { db.restore(); }
});
test('different account identity cannot receive another login’s video statistics', async () => {
  const db = database({ accounts: [{ ...account, external_id: 'login-b' }] });
  try {
    assert.equal((await sync(db)).tiktok.status, 'needs_reconnect');
    assert.ok(!db.calls.some(c => c.url.pathname.endsWith('/social_posts')));
  } finally { db.restore(); }
});
test('rotated token is persisted with the shop-scoped refresh RPC', async () => {
  const db = database();
  try {
    await sync(db, { createTikTok: (stored, persist) => ({ profile: async () => {
      await persist({ ...stored, refreshToken: 'dummy-rotated' }); return profile;
    }, videos: async () => ({ videos: [], has_more: false }) }) });
    const call = db.calls.find(c => c.url.pathname.endsWith('/social_refresh_token'));
    assert.equal(call.body.p_shop, 'shop-a');
    assert.equal(call.body.p_provider, 'tiktok');
    assert.equal(JSON.parse(call.body.p_token).refreshToken, 'dummy-rotated');
    assert.ok(!('p_connected_by' in call.body));
  } finally { db.restore(); }
});
test('revoked TikTok token is terminal; repeated cursors are retriable failures', async () => {
  const db = database();
  try {
    assert.equal((await sync(db, { createTikTok: () => ({ profile: async () => { throw new TikTokError(true); } }) })).tiktok.status, 'needs_reconnect');
    assert.equal((await sync(db, { createTikTok: () => ({ profile: async () => profile, videos: async () => ({ videos: [video], has_more: true, cursor: 123 }) }) })).tiktok.status, 'failed');
  } finally { db.restore(); }
});
function upstream(scopes = TIKTOK_SCOPES) {
  return async url => String(url).includes('/oauth/token/')
    ? Response.json({ access_token: bundle.accessToken, refresh_token: bundle.refreshToken, open_id: bundle.openId, expires_in: 86400, refresh_expires_in: 31536000, scope: scopes.join(',') })
    : Response.json({ error: { code: 'ok' }, data: { user: profile } });
}
test('connect validates granted scopes before writing any credentials', async () => {
  const db = database();
  try {
    const result = await connectTikTok({ supabase: db.client, shopId: 'shop-a', code: 'dummy', redirect: 'https://example.invalid/callback', env, fetchImpl: upstream(['user.info.basic']) });
    assert.equal(result.ok, false);
    assert.equal(db.calls.length, 0);
  } finally { db.restore(); }
});
test('reconnect preserves tracking and engagement basis; previous login is disabled with its history retained', async () => {
  for (const existing of [[], [{ id: 'a' }]]) {
    const db = database({ existing });
    try {
      const result = await connectTikTok({ supabase: db.client, shopId: 'shop-a', code: 'dummy', userId: 'user-a', redirect: 'https://example.invalid/callback', env, fetchImpl: upstream() });
      assert.equal(result.ok, true);
      const saved = db.calls.find(c => c.url.pathname.endsWith('/social_save_token')).body;
      assert.equal(saved.p_connected_by, 'user-a');
      const row = db.calls.find(c => c.method === 'POST' && c.url.pathname.endsWith('/social_accounts')).body[0];
      assert.ok(!('enabled' in row));
      assert.equal(row.engagement_basis, existing.length ? undefined : 'views');
      const disabled = db.calls.find(c => c.method === 'PATCH' && c.url.pathname.endsWith('/social_accounts'));
      assert.equal(disabled.url.searchParams.get('external_id'), 'neq.login-a');
      assert.equal(disabled.url.searchParams.get('shop_id'), 'eq.shop-a');
      assert.ok(!db.calls.some(c => c.method === 'DELETE'));
    } finally { db.restore(); }
  }
});
