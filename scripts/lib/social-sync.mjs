import { createGoogleAdsClient, exchangeGoogleCode, GoogleAdsError } from './google-ads-client.mjs';
import { CLIENTS_QUERY, CUSTOMER_QUERY, campaignDailyQuery, dailyQuery, foldCampaignDaily, foldDaily, foldDiscovery } from './google-ads-reports.mjs';
import { createMetaClient, exchangeMetaCode, MetaError } from './meta-client.mjs';
import {
  DEFAULT_META_CONVERSION_ACTION,
  META_METRICS,
  PAGE_DAYS_PER_REQUEST,
  dayWindows,
  daysBetween,
  foldAdInsights,
  foldCampaignInsights,
  foldMetaCampaigns,
  foldAudience,
  foldInstagramDay,
  foldInstagramMedia,
  foldPageDays,
  foldPagePost,
  isoDay,
  postsPerDay
} from './meta-insights.mjs';
import { SOCIAL_PROVIDERS } from './social-model.mjs';
import { socialAppConfig } from './social-oauth.mjs';
import { supabaseRpc, supabaseSelect, supabaseSelectAll, supabaseUpdate, supabaseUpsert } from './supabase-rest-client.mjs';
import { CAMPAIGN_T, SOCIAL_RPC, SOCIAL_T } from './tables.mjs';

// Connecting Meta and Google Ads, and pulling what they report into Supabase.
// The Klaviyo sync's shape (klaviyo-sync.mjs): connect checks before it saves,
// the token lives in Vault, NOT CONNECTED IS NOT AN ERROR, and a failure is
// written on the connection row — what the dashboard shows — then thrown.
//
// HOW FAR BACK, AND HOW OFTEN. The first sync of an account backfills; every
// sync after rewrites a trailing window, because the platforms keep revising
// recent days (late attribution, late interactions).
//   Instagram days: one request per day (Meta answers `total_value` metrics as
//     a single total), so the first sync reads 30 days and each later sync
//     reaches 30 days further back, until a year is stored.
//   Facebook Page days: a daily series, 365 days in 90-day requests.
//   Posts: listed a year back (cheap: no insights); insights re-read for the
//     posts of the last 30 days (90 on the first sync), when counts still move,
//     and read once for any older post never read (`insights_at` null, 81), at
//     most POST_BACKFILL_PER_SYNC per account per sync, newest first.
//   Ads: 395 days (13 months, a full year-on-year), then the last 28.
//
// EVERY UPSERT WRITES ONE COLUMN SET. The REST client pads a batch's rows to the
// union of their keys with nulls, so a row without `followers` would erase a
// stored follower count. Day metrics, follower counts, post fields and post
// insights are therefore four separate upserts, each with uniform rows.

export const IG_FIRST_DAYS = 30;
export const IG_HISTORY_DAYS = 365;
export const IG_DEEPEN_DAYS = 30;
export const TRAILING_DAYS = 3;
export const PAGE_FIRST_DAYS = 365;
export const PAGE_TRAILING_DAYS = 7;
export const POST_LIST_DAYS = 365;
export const POST_REFRESH_DAYS = 30;
export const POST_FIRST_REFRESH_DAYS = 90;
export const POST_BACKFILL_PER_SYNC = 50;
export const ADS_FIRST_DAYS = 395;
export const ADS_TRAILING_DAYS = 28;
export const AUDIENCE_EVERY_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;
const UPSERT_CHUNK = 500;
const ACCOUNT_COLUMNS = 'id,provider,kind,external_id,name,handle,currency,login_customer_id,enabled';

const addDays = (day, n) => isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
const unix = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

// --- connect -------------------------------------------------------------------------

/**
 * A Meta OAuth code -> a long-lived token in Vault, and the accounts it sees.
 * Nothing is saved when the token sees no Page, no Instagram account and no ad
 * account: a connection with nothing to read would only fail every night.
 *
 * @param {{ supabase: any, shopId: string, code: string, redirect: string, userId?: string | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: true, accounts: number } | { ok: false, code: string, error: string }>}
 */
export async function connectMeta({ supabase, shopId, code, redirect, userId = null, env = process.env, fetchImpl = fetch }) {
  const config = socialAppConfig(env).meta;
  if (!config.canConnect) return { ok: false, code: 'not_configured', error: `Meta is not configured: ${config.connectMissing.join(', ')}.` };

  const { token, expiresAt } = await exchangeMetaCode({
    appId: config.appId,
    appSecret: config.appSecret,
    redirect,
    code,
    graphVersion: config.graphVersion,
    fetchImpl
  });
  const meta = createMetaClient({ token, appSecret: config.appSecret, graphVersion: config.graphVersion, fetchImpl });
  const scopes = await meta.grantedScopes().catch(() => []);
  const accounts = await discoverMetaAccounts(meta);
  if (accounts.length === 0) {
    return { ok: false, code: 'no_accounts', error: 'This Meta login sees no Facebook Page, Instagram professional account or ad account. Connect with a login that manages them, and tick them all when Meta asks.' };
  }

  await supabaseRpc(supabase, SOCIAL_RPC.SAVE_TOKEN, {
    p_shop: shopId,
    p_provider: 'meta',
    p_token: token,
    p_expires_at: expiresAt.toISOString(),
    p_scopes: scopes,
    p_connected_by: userId
  });
  await upsertAccounts(supabase, shopId, 'meta', accounts);
  return { ok: true, accounts: accounts.length };
}

/**
 * A Google OAuth code -> a refresh token in Vault, and the ad accounts it reads.
 *
 * @param {{ supabase: any, shopId: string, code: string, redirect: string, userId?: string | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: true, accounts: number } | { ok: false, code: string, error: string }>}
 */
export async function connectGoogle({ supabase, shopId, code, redirect, userId = null, env = process.env, fetchImpl = fetch }) {
  const config = socialAppConfig(env).google;
  if (!config.canConnect) return { ok: false, code: 'not_configured', error: `Google Ads is not configured: ${config.connectMissing.join(', ')}.` };

  const { refreshToken, scopes } = await exchangeGoogleCode({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirect,
    code,
    fetchImpl
  });
  const ads = googleClient(refreshToken, config, { fetchImpl });
  const accounts = await discoverGoogleAccounts(ads);
  if (accounts.length === 0) {
    return { ok: false, code: 'no_accounts', error: 'This Google login reaches no Google Ads account that serves ads. Connect with a login that has access to the ad account, or to the manager account above it.' };
  }

  await supabaseRpc(supabase, SOCIAL_RPC.SAVE_TOKEN, {
    p_shop: shopId,
    p_provider: 'google',
    p_token: refreshToken,
    p_expires_at: null,
    p_scopes: scopes,
    p_connected_by: userId
  });
  await upsertAccounts(supabase, shopId, 'google', accounts);
  return { ok: true, accounts: accounts.length };
}

/** The token leaves Vault. Accounts and everything synced stay, like Klaviyo's figures. */
export async function disconnectSocial({ supabase, shopId, provider }) {
  assertProvider(provider);
  await supabaseRpc(supabase, SOCIAL_RPC.CLEAR_TOKEN, { p_shop: shopId, p_provider: provider });
}

/** What Connections shows: each connection (never its token) and every account. */
export async function readSocialStatus(supabase, shopId) {
  const [connections, accounts] = await Promise.all([
    supabaseSelect(
      supabase,
      SOCIAL_T.CONNECTIONS,
      { shop_id: shopId },
      'provider,token_expires_at,scopes,connected_at,last_sync_at,last_sync_status,last_sync_error'
    ),
    supabaseSelect(supabase, SOCIAL_T.ACCOUNTS, { shop_id: shopId }, ACCOUNT_COLUMNS, { order: 'kind.asc,name.asc', limit: 200 })
  ]);
  return { connections: connections ?? [], accounts: accounts ?? [] };
}

/** Track or stop tracking one account. Its stored figures stay; every read skips a disabled one. */
export async function setAccountEnabled({ supabase, shopId, accountId, enabled }) {
  const rows = await supabaseUpdate(supabase, SOCIAL_T.ACCOUNTS, { shop_id: shopId, id: accountId }, { enabled: Boolean(enabled) });
  return rows?.[0] ?? null;
}

export async function discoverMetaAccounts(meta, { pages = null } = {}) {
  const accounts = [];
  for (const page of pages ?? (await meta.listPages())) {
    accounts.push({ kind: 'facebook', external_id: String(page.id), name: page.name ?? null, handle: page.username ?? null, currency: null, login_customer_id: null });
    const ig = page.instagram_business_account;
    if (ig?.id) {
      accounts.push({ kind: 'instagram', external_id: String(ig.id), name: ig.name ?? page.name ?? null, handle: ig.username ?? null, currency: null, login_customer_id: null });
    }
  }
  for (const ad of await meta.listAdAccounts()) {
    // account_status 1 is active; a closed account (101) has nothing to report.
    if (ad.account_status !== undefined && Number(ad.account_status) === 101) continue;
    accounts.push({ kind: 'meta_ads', external_id: String(ad.account_id), name: ad.name ?? null, handle: null, currency: ad.currency ?? null, login_customer_id: null });
  }
  return dedupe(accounts);
}

export async function discoverGoogleAccounts(ads, { log = () => {} } = {}) {
  const reached = [];
  for (const id of await ads.listAccessibleCustomers()) {
    try {
      const [customer] = await ads.search(id, CUSTOMER_QUERY, { loginCustomerId: id });
      const entry = { id, customer: customer?.customer };
      if (entry.customer?.manager) entry.clients = await ads.search(id, CLIENTS_QUERY, { loginCustomerId: id });
      reached.push(entry);
    } catch (error) {
      if (error instanceof GoogleAdsError && error.needsReconnect) throw error;
      // A cancelled or suspended customer answers with an error; it is skipped, not fatal.
      log(`Google Ads customer ${id} skipped: ${error instanceof Error ? error.message : String(error)}`);
      reached.push({ id, error: true });
    }
  }
  return foldDiscovery(reached).map((a) => ({ kind: 'google_ads', handle: null, ...a }));
}

async function upsertAccounts(supabase, shopId, provider, accounts) {
  if (accounts.length === 0) return [];
  // `enabled` is not sent, so a re-discovery never re-enables what the team switched off.
  const rows = accounts.map((a) => ({
    shop_id: shopId,
    provider,
    kind: a.kind,
    external_id: a.external_id,
    name: a.name ?? null,
    handle: a.handle ?? null,
    currency: a.currency ?? null,
    login_customer_id: a.login_customer_id ?? null
  }));
  return supabaseUpsert(supabase, SOCIAL_T.ACCOUNTS, rows, 'shop_id,kind,external_id');
}

// --- sync -----------------------------------------------------------------------------

/**
 * Pull every enabled account of every connected provider (or of one).
 * Not connected, or the app's credentials missing, is a skip — the nightly
 * calls this for every shop. One account failing does not stop the others;
 * the provider's row then says `failed` with each account's reason, or
 * `needs_reconnect` when the token itself was refused.
 */
export async function runSocialSync({
  supabase,
  shopRow,
  provider = null,
  env = process.env,
  now = new Date(),
  log = console.log,
  fetchImpl = fetch,
  dryRun = false,
  createMeta = (token, appConfig) => createMetaClient({ token, appSecret: appConfig.appSecret, graphVersion: appConfig.graphVersion, fetchImpl, log }),
  createAds = (token, appConfig) => googleClient(token, appConfig, { fetchImpl, log })
}) {
  const shopId = shopRow.id;
  const config = socialAppConfig(env);
  const { connections } = await readSocialStatus(supabase, shopId);
  const results = {};

  for (const connection of connections) {
    if (provider && connection.provider !== provider) continue;
    const appConfig = config[connection.provider];
    if (!appConfig?.canSync) {
      results[connection.provider] = { status: 'skipped', reason: `app credentials missing: ${appConfig?.missing?.join(', ')}` };
      continue;
    }
    results[connection.provider] = await syncProvider({ supabase, shopId, connection, appConfig, now, log, dryRun, createMeta, createAds });
  }
  if (provider && !results[provider]) results[provider] = { status: 'skipped', reason: 'not connected' };
  return results;
}

/**
 * One provider, every enabled account. Never throws: the outcome is written on
 * the connection row and returned as `{ status, error, ...counts }`, so one
 * provider's failure cannot cost the other its night.
 */
async function syncProvider({ supabase, shopId, connection, appConfig, now, log, dryRun, createMeta, createAds }) {
  const provider = connection.provider;
  const stats = { accounts: 0, days: 0, posts: 0, post_insights: 0, ad_days: 0, campaign_days: 0, audience: 0, failed: [], unanswered: new Set() };
  let status = 'ok';
  let error = null;

  try {
    const token = await supabaseRpc(supabase, SOCIAL_RPC.READ_TOKEN, { p_shop: shopId, p_provider: provider });
    if (!token) throw new Error(`The ${provider} token is missing from Vault. Connect again from Insights → Social media → Connections.`);

    const ctx = { supabase, shopId, now, today: isoDay(now), log, dryRun, stats };
    if (provider === 'meta') {
      const meta = createMeta(token, appConfig);
      ctx.meta = meta;
      const pages = await meta.listPages();
      ctx.pageTokens = new Map(pages.map((p) => [String(p.id), p.access_token]));
      await upsertAccounts(supabase, shopId, 'meta', await discoverMetaAccounts(meta, { pages }));
      const fullConnection = await supabaseSelect(supabase, SOCIAL_T.CONNECTIONS, { shop_id: shopId, provider }, 'conversion_action', { limit: 1 });
      ctx.conversionAction = fullConnection?.[0]?.conversion_action || DEFAULT_META_CONVERSION_ACTION;
    } else {
      const ads = createAds(token, appConfig);
      ctx.ads = ads;
      await upsertAccounts(supabase, shopId, 'google', await discoverGoogleAccounts(ads, { log }));
    }

    const accounts = await supabaseSelect(supabase, SOCIAL_T.ACCOUNTS, { shop_id: shopId, provider, enabled: true }, ACCOUNT_COLUMNS, { limit: 200 });
    for (const account of accounts ?? []) {
      try {
        if (account.kind === 'instagram') await syncInstagram(ctx, account);
        else if (account.kind === 'facebook') await syncFacebookPage(ctx, account);
        else if (account.kind === 'meta_ads') await syncMetaAds(ctx, account);
        else if (account.kind === 'google_ads') await syncGoogleAds(ctx, account);
        stats.accounts += 1;
      } catch (accountError) {
        if (accountError?.needsReconnect) throw accountError;
        const message = accountError instanceof Error ? accountError.message : String(accountError);
        log(`social sync: ${account.kind} ${account.name ?? account.external_id} failed: ${message}`);
        stats.failed.push(`${account.name ?? account.external_id}: ${message}`);
      }
    }
    if (stats.failed.length) {
      status = 'failed';
      error = stats.failed.join(' | ');
    }
  } catch (fatal) {
    status = fatal?.needsReconnect ? 'needs_reconnect' : 'failed';
    error = fatal instanceof Error ? fatal.message : String(fatal);
    log(`social sync: ${provider} ${status}: ${error}`);
  }

  if (stats.unanswered.size) log(`social sync: ${provider} metrics not answered (recorded as not measured): ${[...stats.unanswered].join(', ')}`);
  if (!dryRun) {
    await supabaseUpdate(
      supabase,
      SOCIAL_T.CONNECTIONS,
      { shop_id: shopId, provider },
      { last_sync_at: now.toISOString(), last_sync_status: status, last_sync_error: error ? error.slice(0, 500) : null }
    ).catch(() => {});
  }
  const { unanswered, failed, ...counts } = stats;
  return { status, error, ...counts, unanswered: [...unanswered] };
}

function googleClient(refreshToken, config, { fetchImpl, log = () => {} }) {
  return createGoogleAdsClient({
    refreshToken,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    developerToken: config.developerToken,
    apiVersion: config.apiVersion,
    fetchImpl,
    log
  });
}

/** The oldest and newest day stored for an account, or nulls. */
async function storedSpan(supabase, table, accountId) {
  const [oldest, newest] = await Promise.all([
    supabaseSelect(supabase, table, { account_id: accountId }, 'day', { order: 'day.asc', limit: 1 }),
    supabaseSelect(supabase, table, { account_id: accountId }, 'day', { order: 'day.desc', limit: 1 })
  ]);
  return { oldest: oldest?.[0]?.day ?? null, newest: newest?.[0]?.day ?? null };
}

/**
 * Which days to (re)read: a first window when nothing is stored, else the
 * trailing days plus, while history is short of `historyDays`, one step further
 * back than the oldest stored day.
 */
export function daysToRead({ today, oldest, firstDays, trailingDays, historyDays = firstDays, deepenDays = 0 }) {
  if (!oldest) return daysBetween(addDays(today, -(firstDays - 1)), today);
  const days = new Set(daysBetween(addDays(today, -(trailingDays - 1)), today));
  const limit = addDays(today, -(historyDays - 1));
  if (deepenDays > 0 && oldest > limit) {
    const from = addDays(oldest, -deepenDays) < limit ? limit : addDays(oldest, -deepenDays);
    for (const day of daysBetween(from, addDays(oldest, -1))) days.add(day);
  }
  return [...days].sort();
}

async function syncInstagram(ctx, account) {
  const { meta, supabase, shopId, today, stats } = ctx;
  const igId = account.external_id;
  const { oldest } = await storedSpan(supabase, SOCIAL_T.ACCOUNT_DAYS, account.id);
  const days = daysToRead({ today, oldest, firstDays: IG_FIRST_DAYS, trailingDays: TRAILING_DAYS, historyDays: IG_HISTORY_DAYS, deepenDays: IG_DEEPEN_DAYS });

  // Posts: listed back to the oldest day being read (or a year), so each day's
  // post count is complete; insights only for the recent ones.
  const listFrom = [days[0], addDays(today, -(POST_LIST_DAYS - 1))].sort()[0];
  const media = (await meta.instagramMedia(igId, new Date(`${listFrom}T00:00:00Z`))).filter((m) => m.media_product_type !== 'STORY');
  const perDay = postsPerDay(media.map((m) => m.timestamp));

  const dayRows = [];
  for (const day of days) {
    const params = { period: 'day', metric_type: 'total_value', since: unix(day), until: unix(addDays(day, 1)) };
    const core = await meta.insights(igId, Object.keys(META_METRICS.instagramDay), params);
    const follows = await meta.insights(igId, [META_METRICS.instagramFollows.metric], { ...params, breakdown: META_METRICS.instagramFollows.breakdown });
    for (const name of [...core.failed, ...follows.failed]) stats.unanswered.add(`instagram:${name}${core.denied || follows.denied ? ' (permission refused)' : ''}`);
    dayRows.push(dayRow(account, shopId, day, { ...foldInstagramDay(core.data, follows.data), posts: perDay.get(day) ?? 0 }));
  }
  await writeDays(ctx, dayRows);

  const profile = await meta.instagramProfile(igId);
  await writeFollowers(ctx, [{ account_id: account.id, shop_id: shopId, day: today, followers: numberOrNull(profile?.followers_count) }]);

  await writePosts(ctx, account, media, {
    refreshSince: addDays(today, -((oldest ? POST_REFRESH_DAYS : POST_FIRST_REFRESH_DAYS) - 1)),
    timestampOf: (m) => m.timestamp,
    base: (m) => foldInstagramMedia(m, []),
    withInsights: async (m) => {
      const metrics = META_METRICS.instagramMedia.filter((name) => !(ctx.mediaSkip?.get(m.media_product_type) ?? new Set()).has(name));
      const result = await meta.insights(m.id, metrics, {});
      // Some names refused while others answer: those names are retired for
      // this media type. ALL refused is this post (e.g. published before the
      // account became a business account), and must not blind the rest.
      if (result.failed.length && result.data.length) {
        ctx.mediaSkip ??= new Map();
        const skip = ctx.mediaSkip.get(m.media_product_type) ?? new Set();
        for (const name of result.failed) skip.add(name);
        ctx.mediaSkip.set(m.media_product_type, skip);
      }
      return { row: foldInstagramMedia(m, result.data), read: !result.denied };
    }
  });

  await syncAudience(ctx, account);
}

async function syncAudience(ctx, account) {
  const { meta, supabase, shopId, today, stats, dryRun } = ctx;
  const latest = await supabaseSelect(supabase, SOCIAL_T.AUDIENCE, { account_id: account.id }, 'captured_on', { order: 'captured_on.desc', limit: 1 });
  const last = latest?.[0]?.captured_on;
  if (last && last > addDays(today, -AUDIENCE_EVERY_DAYS)) return;

  const { metric, breakdowns, timeframe } = META_METRICS.instagramAudience;
  const rows = [];
  for (const dimension of breakdowns) {
    const result = await meta.insights(account.external_id, [metric], { period: 'lifetime', metric_type: 'total_value', timeframe, breakdown: dimension });
    // Meta answers demographics only past 100 followers; below that, nothing is drawn.
    if (result.failed.length) stats.unanswered.add(`instagram:${metric}:${dimension}`);
    for (const row of foldAudience(dimension, result.data)) rows.push({ account_id: account.id, shop_id: shopId, captured_on: today, ...row });
  }
  stats.audience += rows.length;
  if (!dryRun && rows.length) await upsertChunks(supabase, SOCIAL_T.AUDIENCE, rows, 'account_id,captured_on,dimension,key');
}

async function syncFacebookPage(ctx, account) {
  const { meta, supabase, shopId, today, stats } = ctx;
  const pageId = account.external_id;
  const pageToken = ctx.pageTokens.get(pageId);
  if (!pageToken) throw new Error('Meta no longer gives this login a token for the Page. Reconnect with a login that manages it.');

  const { oldest } = await storedSpan(supabase, SOCIAL_T.ACCOUNT_DAYS, account.id);
  const days = daysToRead({ today, oldest, firstDays: PAGE_FIRST_DAYS, trailingDays: PAGE_TRAILING_DAYS });

  const listFrom = [days[0], addDays(today, -(POST_LIST_DAYS - 1))].sort()[0];
  const posts = await meta.pagePosts(pageId, pageToken, new Date(`${listFrom}T00:00:00Z`));
  const perDay = postsPerDay(posts.map((p) => p.created_time));

  const measured = new Map();
  for (const window of dayWindows(days[0], days[days.length - 1], PAGE_DAYS_PER_REQUEST)) {
    const result = await meta.insights(pageId, Object.keys(META_METRICS.facebookDay), { period: 'day', since: window.since, until: addDays(window.until, 1) }, { asToken: pageToken });
    for (const name of result.failed) stats.unanswered.add(`facebook:${name}${result.denied ? ' (permission refused)' : ''}`);
    for (const [day, row] of foldPageDays(result.data)) measured.set(day, row);
  }

  const followerRows = [];
  const dayRows = days.map((day) => {
    const { followers, ...counts } = measured.get(day) ?? {};
    if (followers !== undefined && followers !== null) followerRows.push({ account_id: account.id, shop_id: shopId, day, followers });
    return dayRow(account, shopId, day, { ...counts, posts: perDay.get(day) ?? 0 });
  });
  await writeDays(ctx, dayRows);

  const profile = await meta.pageProfile(pageId, pageToken).catch(() => null);
  const today_followers = numberOrNull(profile?.followers_count ?? profile?.fan_count);
  if (today_followers !== null) {
    const index = followerRows.findIndex((r) => r.day === today);
    if (index >= 0) followerRows.splice(index, 1);
    followerRows.push({ account_id: account.id, shop_id: shopId, day: today, followers: today_followers });
  }
  await writeFollowers(ctx, followerRows);

  await writePosts(ctx, account, posts, {
    refreshSince: addDays(today, -((oldest ? POST_REFRESH_DAYS : POST_FIRST_REFRESH_DAYS) - 1)),
    timestampOf: (p) => p.created_time,
    base: (p) => foldPagePost(p, []),
    withInsights: async (p) => {
      const metrics = Object.keys(META_METRICS.facebookPost).filter((name) => !(ctx.pagePostSkip ?? new Set()).has(name));
      const result = metrics.length ? await meta.insights(p.id, metrics, { period: 'lifetime' }, { asToken: pageToken }) : null;
      for (const name of result?.failed ?? []) {
        ctx.pagePostSkip ??= new Set();
        ctx.pagePostSkip.add(name);
        stats.unanswered.add(`facebook:${name}${result.denied ? ' (permission refused)' : ''}`);
      }
      return { row: foldPagePost(p, result?.data ?? []), read: Boolean(result) && !result.denied };
    }
  });
}

async function syncMetaAds(ctx, account) {
  const { meta, supabase, today } = ctx;
  const { oldest } = await storedSpan(supabase, SOCIAL_T.AD_DAYS, account.id);
  const span = oldest ? ADS_TRAILING_DAYS : ADS_FIRST_DAYS;
  const rows = [];
  for (const window of dayWindows(addDays(today, -(span - 1)), today, 31)) {
    rows.push(...foldAdInsights(await meta.adInsights(account.external_id, window), { currency: account.currency, conversionAction: ctx.conversionAction }));
  }
  await writeAdDays(ctx, account, rows);

  await campaignStep(ctx, account, async (span) => {
    const days = [];
    for (const window of dayWindows(addDays(today, -(span - 1)), today, 31)) {
      days.push(...foldCampaignInsights(await meta.campaignInsights(account.external_id, window), { currency: account.currency, conversionAction: ctx.conversionAction }));
    }
    const listed = foldMetaCampaigns(await meta.listCampaigns(account.external_id));
    // A campaign deleted since it ran is no longer listed; its name comes from the insights.
    const known = new Set(listed.map((c) => c.external_id));
    for (const d of days) {
      if (!known.has(d.campaign_id)) {
        listed.push({ external_id: d.campaign_id, name: d.campaign_name ?? null, status: null, objective: null });
        known.add(d.campaign_id);
      }
    }
    return { campaigns: listed, days: days.map(({ campaign_name, ...d }) => d) };
  });
}

async function syncGoogleAds(ctx, account) {
  const { ads, supabase, today } = ctx;
  const { oldest } = await storedSpan(supabase, SOCIAL_T.AD_DAYS, account.id);
  const span = oldest ? ADS_TRAILING_DAYS : ADS_FIRST_DAYS;
  const result = await ads.search(account.external_id, dailyQuery(addDays(today, -(span - 1)), today), { loginCustomerId: account.login_customer_id });
  await writeAdDays(ctx, account, foldDaily(result, { currency: account.currency }));

  await campaignStep(ctx, account, async (campaignSpan) => {
    const rows = await ads.search(account.external_id, campaignDailyQuery(addDays(today, -(campaignSpan - 1)), today), { loginCustomerId: account.login_customer_id });
    return foldCampaignDaily(rows, { currency: account.currency });
  });
}

/**
 * The campaign cut of an ad account (71_ad_campaigns.sql): its own backfill, so
 * an account synced before campaigns existed still gets 13 months of them, and
 * its own failure — recorded against the account, after the account-level
 * figures are already written, so a campaign error never costs the totals.
 */
async function campaignStep(ctx, account, read) {
  try {
    const { oldest } = await storedSpan(ctx.supabase, CAMPAIGN_T.CAMPAIGN_DAYS, account.id);
    const { campaigns, days } = await read(oldest ? ADS_TRAILING_DAYS : ADS_FIRST_DAYS);
    ctx.stats.campaign_days += days.length;
    if (ctx.dryRun) return;
    const scoped = (rows) => rows.map((r) => ({ account_id: account.id, shop_id: ctx.shopId, ...r }));
    await upsertChunks(ctx.supabase, CAMPAIGN_T.CAMPAIGNS, stamp(scoped(campaigns), ctx.now), 'account_id,external_id');
    await upsertChunks(ctx.supabase, CAMPAIGN_T.CAMPAIGN_DAYS, stamp(scoped(days), ctx.now), 'account_id,campaign_id,day');
  } catch (error) {
    if (error?.needsReconnect) throw error;
    const message = error instanceof Error ? error.message : String(error);
    ctx.log(`social sync: campaigns of ${account.name ?? account.external_id} failed: ${message}`);
    ctx.stats.failed.push(`${account.name ?? account.external_id} (campaigns): ${message}`);
  }
}

// --- writes ---------------------------------------------------------------------------

const DAY_COUNTS = ['follows', 'unfollows', 'views', 'engagement', 'profile_visits', 'link_taps', 'posts'];

function dayRow(account, shopId, day, counts) {
  const row = { account_id: account.id, shop_id: shopId, day };
  for (const column of DAY_COUNTS) row[column] = counts[column] ?? null;
  return row;
}

async function writeDays(ctx, rows) {
  ctx.stats.days += rows.length;
  if (ctx.dryRun || rows.length === 0) return;
  await upsertChunks(ctx.supabase, SOCIAL_T.ACCOUNT_DAYS, stamp(rows, ctx.now), 'account_id,day');
}

async function writeFollowers(ctx, rows) {
  const known = rows.filter((r) => r.followers !== null && r.followers !== undefined);
  if (ctx.dryRun || known.length === 0) return;
  await upsertChunks(ctx.supabase, SOCIAL_T.ACCOUNT_DAYS, known, 'account_id,day');
}

const POST_BASE = ['external_id', 'published_at', 'media_type', 'caption_excerpt', 'permalink', 'thumbnail_url', 'likes', 'comments'];
const POST_INSIGHTS = ['views', 'reach', 'shares', 'saves', 'follows', 'engagement'];

/**
 * Every listed post's fields, then insights — two upserts, so a post too old to
 * re-read keeps the insights it was last given.
 *
 * Insights are read for the recent posts, whose counts still move, and for
 * older posts never read before (`insights_at` null), newest first and at most
 * POST_BACKFILL_PER_SYNC of them, so a first connect to an account whose posts
 * are all older than the window still gets every post's views within a few
 * syncs, inside Meta's hourly call budget. `insights_at` is stamped when Meta
 * was asked and did not refuse the permission: a post it cannot answer (all
 * names refused) is not asked again, while a permission granted later still
 * reaches posts that were refused for want of it.
 */
async function writePosts(ctx, account, items, { refreshSince, timestampOf, base, withInsights }) {
  const { supabase, shopId, now, dryRun, stats } = ctx;
  const pick = (row, columns) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
  const baseRows = items.map((item) => ({ account_id: account.id, shop_id: shopId, ...pick(base(item), POST_BASE), fetched_at: now.toISOString() }));

  const read = new Set(
    ((await supabaseSelectAll(supabase, SOCIAL_T.POSTS, { account_id: account.id, insights_at: { operator: 'not.is', value: 'null' } }, 'external_id', { order: 'external_id.asc' })) ?? []).map((r) => String(r.external_id))
  );
  const newestFirst = [...items].sort((a, b) => Date.parse(timestampOf(b)) - Date.parse(timestampOf(a)));
  const recent = newestFirst.filter((item) => isoDay(timestampOf(item)) >= refreshSince);
  const backfill = newestFirst
    .filter((item) => isoDay(timestampOf(item)) < refreshSince && !read.has(String(item.id)))
    .slice(0, POST_BACKFILL_PER_SYNC);

  const insightRows = [];
  for (const item of [...recent, ...backfill]) {
    const { row, read: answered } = await withInsights(item);
    insightRows.push({
      account_id: account.id,
      shop_id: shopId,
      external_id: row.external_id,
      published_at: row.published_at,
      ...pick(row, POST_INSIGHTS),
      insights_at: answered ? now.toISOString() : null
    });
  }
  stats.post_insights += insightRows.length;
  stats.posts += baseRows.length;
  if (dryRun) return;
  await upsertChunks(supabase, SOCIAL_T.POSTS, baseRows, 'account_id,external_id');
  await upsertChunks(supabase, SOCIAL_T.POSTS, insightRows, 'account_id,external_id');
}

async function writeAdDays(ctx, account, rows) {
  ctx.stats.ad_days += rows.length;
  if (ctx.dryRun || rows.length === 0) return;
  const full = rows.map((r) => ({ account_id: account.id, shop_id: ctx.shopId, ...r }));
  await upsertChunks(ctx.supabase, SOCIAL_T.AD_DAYS, stamp(full, ctx.now), 'account_id,day,publisher');
}

function stamp(rows, now) {
  const fetchedAt = now.toISOString();
  return rows.map((row) => ({ ...row, fetched_at: fetchedAt }));
}

async function upsertChunks(supabase, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await supabaseUpsert(supabase, table, rows.slice(i, i + UPSERT_CHUNK), onConflict, { returning: 'minimal' });
  }
}

function dedupe(accounts) {
  const seen = new Map();
  for (const a of accounts) seen.set(`${a.kind}|${a.external_id}`, a);
  return [...seen.values()];
}

function assertProvider(provider) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw new Error(`Unknown social provider ${JSON.stringify(provider)}.`);
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export { MetaError, GoogleAdsError };
