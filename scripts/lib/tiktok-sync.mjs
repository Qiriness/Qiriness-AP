import { createTikTokClient, exchangeTikTokCode, foldTikTokVideo, TikTokError, TIKTOK_SCOPES, tiktokConfig } from './tiktok-client.mjs';
import { supabaseRpc, supabaseSelect, supabaseUpdate, supabaseUpsert } from './supabase-rest-client.mjs';
import { SOCIAL_RPC, SOCIAL_T } from './tables.mjs';

// A single TikTok login per shop, with rotating tokens kept together in Vault.
/** @param {{ supabase: any, shopId: string, code: string, redirect: string, userId?: string | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} input */
export async function connectTikTok({ supabase, shopId, code, redirect, userId = null, env = process.env, fetchImpl = fetch }) {
  if (!tiktokConfig(env).canConnect) return { ok: false, code: 'not_configured', error: 'TikTok app credentials or OAuth state secret are missing.' };
  const { bundle, scopes } = await exchangeTikTokCode({ code, redirect, env, fetchImpl });
  if (TIKTOK_SCOPES.some(scope => !scopes.includes(scope))) return { ok: false, code: 'exchange_failed', error: 'Grant TikTok profile statistics and video access to connect.' };
  const profile = await createTikTokClient({ bundle, env, fetchImpl }).profile();
  if (!bundle.openId || profile?.open_id !== bundle.openId) throw new TikTokError(true);
  const existing = await supabaseSelect(supabase, SOCIAL_T.ACCOUNTS, { shop_id: shopId, kind: 'tiktok', external_id: bundle.openId }, 'id', { limit: 1 });
  await supabaseRpc(supabase, SOCIAL_RPC.SAVE_TOKEN, {
    p_shop: shopId, p_provider: 'tiktok', p_token: JSON.stringify(bundle),
    p_expires_at: new Date(bundle.expiresAt).toISOString(), p_scopes: scopes, p_connected_by: userId
  });
  await supabaseUpsert(supabase, SOCIAL_T.ACCOUNTS, [{
    shop_id: shopId, provider: 'tiktok', kind: 'tiktok', external_id: bundle.openId,
    name: profile.display_name ?? null,
    ...(existing.length ? {} : { engagement_basis: 'views' })
  }], 'shop_id,kind,external_id');
  // Old logins retain history but cannot be synced with this login's token.
  await supabaseUpdate(supabase, SOCIAL_T.ACCOUNTS, {
    shop_id: shopId, provider: 'tiktok', external_id: { operator: 'neq', value: bundle.openId }
  }, { enabled: false });
  return { ok: true, accounts: 1 };
}

export async function prepareTikTok(ctx, token, { env, fetchImpl, createTikTok }) {
  let bundle;
  try { bundle = JSON.parse(token); } catch { throw new TikTokError(true); }
  if (!bundle?.openId || !bundle.accessToken || !bundle.refreshToken || !Number.isFinite(bundle.expiresAt)) throw new TikTokError(true);
  if (ctx.dryRun && bundle.expiresAt < Date.now() + 60000) throw new Error('TikTok token needs renewal; run a normal sync before a dry run.');
  const persist = async renewed => {
    if (renewed.openId !== bundle.openId) throw new TikTokError(true);
    await supabaseRpc(ctx.supabase, SOCIAL_RPC.REFRESH_TOKEN, {
      p_shop: ctx.shopId, p_provider: 'tiktok', p_token: JSON.stringify(renewed),
      p_expires_at: new Date(renewed.expiresAt).toISOString()
    });
  };
  ctx.tiktok = createTikTok ? createTikTok(bundle, persist) : createTikTokClient({ bundle, env, fetchImpl, persist });
  ctx.tiktokProfile = await ctx.tiktok.profile();
  if (ctx.tiktokProfile?.open_id !== bundle.openId) throw new TikTokError(true);
}

export async function syncTikTokAccount(ctx, account) {
  if (account.external_id !== ctx.tiktokProfile.open_id) throw new TikTokError(true);
  if (!ctx.dryRun) await supabaseUpsert(ctx.supabase, SOCIAL_T.ACCOUNT_DAYS, [{
    shop_id: ctx.shopId, account_id: account.id, day: ctx.today,
    followers: ctx.tiktokProfile.follower_count ?? null, fetched_at: ctx.now.toISOString()
  }], 'account_id,day');
  ctx.stats.days += 1;
  ctx.stats.unanswered.add('TikTok daily views, reach, audience and profile visits');
  const floor = ctx.now.getTime() - 365 * 86400000;
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 500; page++) {
    const result = await ctx.tiktok.videos(cursor);
    if (!Array.isArray(result?.videos)) throw new TikTokError();
    const recent = result.videos.filter(video => Number(video.create_time) * 1000 >= floor);
    const rows = recent.map(video => ({
      ...foldTikTokVideo(video), shop_id: ctx.shopId, account_id: account.id,
      fetched_at: ctx.now.toISOString(), insights_at: ctx.now.toISOString()
    }));
    // No daily allocation of lifetime counters; no writes to manual annotations.
    if (rows.length && !ctx.dryRun) await supabaseUpsert(ctx.supabase, SOCIAL_T.POSTS, rows, 'account_id,external_id');
    ctx.stats.posts += rows.length;
    ctx.stats.post_insights += rows.length;
    if (!result.has_more || recent.length < result.videos.length) return;
    const next = Number(result.cursor);
    if (!Number.isFinite(next) || next <= 0 || seen.has(next)) throw new Error('TikTok returned a repeated or invalid video cursor.');
    seen.add(next);
    cursor = next;
  }
  throw new Error('TikTok video paging exceeded the sync limit.');
}
