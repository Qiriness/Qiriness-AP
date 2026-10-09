/**
 * The Social media panel: organic (Instagram, Facebook Page) or paid (Meta
 * Ads, Google Ads), over the URL's range, for one network or all of them.
 *
 * SQL sums days and posts (70_social.sql); every judgement — growth, rates,
 * what moved, which currency — is in scripts/lib/social-figures.mjs, tested.
 *
 * REACH IS READ LIVE, AND ONLY WHERE IT CAN BE TRUE. Reach is unique people,
 * so a range's reach is not the sum of its days and nothing stores it. For a
 * range of 30 days or less Instagram answers it directly, and that is read at
 * render time with a 5-minute cache, like the Shopify Analytics cards. Beyond
 * 30 days, and for a Facebook Page, it is a dash with its reason.
 *
 * Server-only.
 */

import { createMetaClient } from "../../../../scripts/lib/meta-client.mjs";
import {
  bucketSeries,
  driverSummary,
  netFollows,
  organicDrivers,
  organicTotals,
  postActivity,
  paidTotals,
  postEngagementRate,
  ratio,
  withRates,
  sumKnown,
} from "../../../../scripts/lib/social-figures.mjs";
import { DEFAULT_ENGAGEMENT_BASIS, ENGAGEMENT_BASES, ORGANIC_KINDS, PAID_KINDS, campaignUrl } from "../../../../scripts/lib/social-model.mjs";
import { socialAppConfig } from "../../../../scripts/lib/social-oauth.mjs";
import { supabaseRpc, supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { CAMPAIGN_RPC, SOCIAL_RPC, SOCIAL_T } from "../../../../scripts/lib/tables.mjs";
import { readSocialStatus } from "../../../../scripts/lib/social-sync.mjs";
import type {
  AudienceBucket,
  Band,
  BandMetric,
  BandRule,
  EngagementBasis,
  MarketingSocial,
  Compared,
  LiveReach,
  OrganicKind,
  OrganicPanel,
  OrganicTotals,
  OrganicView,
  PaidCampaign,
  PaidKind,
  PaidPanel,
  PaidTotals,
  SocialAudience,
  SocialKind,
  SocialMode,
  SocialPanel,
  SocialPost,
} from "../../social-types";
import type { InsightsRange, SeriesPoint } from "../../types";
import { getSocialConnections } from "../social-connections-service";
import { readSocialTags } from "../social-tags-service";
import { readBandRows } from "../social-bands-service";
import { readNonFollowers } from "../social-post-manual-service";
import { bandPosts, effectiveRules } from "../../../../scripts/lib/social-bands.mjs";
import type { InsightsContext, SearchParams } from "./context";
import { callRpc, getSupabaseClient } from "./shared";
import { previousCovered, toSeries, type Coverage } from "./series";

const POST_LIMIT = 200;
const CAMPAIGN_LIMIT = 200;
const LIVE_REACH_MAX_DAYS = 30;
const REACH_CACHE_MS = 5 * 60 * 1000;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export interface SocialParams {
  mode: SocialMode;
  network: string;
  view: OrganicView;
}

export function parseSocialParams(searchParams: SearchParams): SocialParams {
  const mode = first(searchParams.mode) === "paid" ? "paid" : "organic";
  const view = first(searchParams.view);
  return {
    mode,
    network: first(searchParams.network) ?? "all",
    view: view === "content" || view === "posts" ? view : "profile",
  };
}

export async function getSocialPanel(ctx: InsightsContext, params: SocialParams): Promise<SocialPanel> {
  const connections = await getSocialConnections();
  const tracked = connections.providers.flatMap((p) => p.accounts).filter((a) => a.enabled);
  const has = (kind: SocialKind) => tracked.some((a) => a.kind === kind);

  if (params.mode === "paid") {
    const kinds = (PAID_KINDS as PaidKind[]).filter(has);
    const network = (kinds as string[]).includes(params.network) ? (params.network as PaidKind) : "all";
    return {
      mode: "paid",
      network,
      view: params.view,
      connections,
      organic: null,
      paid: kinds.length ? await readPaid(ctx, kinds, network === "all" ? kinds : [network]) : emptyPaid(),
    };
  }

  const kinds = (ORGANIC_KINDS as OrganicKind[]).filter(has);
  const network = (kinds as string[]).includes(params.network) ? (params.network as OrganicKind) : "all";
  return {
    mode: "organic",
    network,
    view: network === "all" ? "profile" : params.view,
    connections,
    organic: kinds.length ? await readOrganic(ctx, kinds, network === "all" ? kinds : [network]) : null,
    paid: null,
  };
}

// --- organic ----------------------------------------------------------------------------

type DayRow = {
  kind: string;
  account_id: string;
  bucket: string;
  views: number | null;
  engagement: number | null;
  profile_visits: number | null;
  link_taps: number | null;
  follows: number | null;
  unfollows: number | null;
  posts: number | null;
};

interface OrganicRows {
  series: DayRow[];
  followers: Record<string, unknown>[];
  postTotals: Record<string, unknown>[];
}

async function readOrganicRows(ctx: InsightsContext, window: { from: string; to: string }): Promise<OrganicRows> {
  const [series, followers, postTotals] = await Promise.all([
    callRpc<DayRow>(SOCIAL_RPC.SERIES, { p_shop: ctx.shopId, p_from: window.from, p_to: window.to, p_grain: ctx.range.grain }),
    callRpc(SOCIAL_RPC.FOLLOWERS, { p_shop: ctx.shopId, p_from: window.from, p_to: window.to }),
    callRpc(SOCIAL_RPC.POST_TOTALS, { p_shop: ctx.shopId, p_from: window.from, p_to: window.to, p_tz: ctx.tz }),
  ]);
  return { series, followers, postTotals };
}

async function readOrganic(ctx: InsightsContext, kinds: OrganicKind[], selected: OrganicKind[]): Promise<OrganicPanel> {
  const coverage = await coverageOf(SOCIAL_T.ACCOUNT_DAYS, ctx.shopId);
  const compare = previousCovered(ctx.range, coverage);

  const [current, previous, audienceRows, postRows, reach, tags, bases, bandRows, nonFollowers] = await Promise.all([
    readOrganicRows(ctx, ctx.range),
    compare ? readOrganicRows(ctx, ctx.range.previous) : Promise.resolve(null),
    callRpc<{ kind: string; captured_on: string; dimension: string; key: string; value: number }>(SOCIAL_RPC.AUDIENCE, { p_shop: ctx.shopId }),
    callRpc<Record<string, unknown>>(SOCIAL_RPC.POSTS, { p_shop: ctx.shopId, p_from: ctx.range.from, p_to: ctx.range.to, p_tz: ctx.tz, p_limit: POST_LIMIT }),
    selected.includes("instagram") ? liveReach(ctx) : Promise.resolve<LiveReach>({ reach: null, accountsEngaged: null, blockedReason: "insights.social.reach.pageNotUnique" }),
    readSocialTags(ctx.shopId),
    readEngagementBases(ctx.shopId),
    readBandRows(ctx.shopId),
    readNonFollowers(ctx.shopId),
  ]);

  const totalsFor = (only: OrganicKind[]): Compared<OrganicTotals> => ({
    current: organicTotals(current, only, bases),
    previous: previous ? organicTotals(previous, only, bases) : null,
  });
  const totals = totalsFor(selected);
  const drivers = organicDrivers(totals.current, totals.previous);

  const followersByAccount = new Map(
    (current.followers as { account_id: string; followers_end: number | null }[]).map((f) => [f.account_id, f.followers_end === null ? null : Number(f.followers_end)])
  );
  const listed = postRows
    .filter((p) => (selected as string[]).includes(p.kind as string))
    .map((row) => toPost(row, bases, followersByAccount));
  const bandRules = Object.fromEntries(
    kinds.map((kind) => [kind, effectiveRules(bandRows.filter((r) => r.kind === kind))])
  ) as Record<OrganicKind, Record<BandMetric, BandRule>>;
  // Medians are of each platform's own posts, so bands are decided per platform.
  const bandOfPost = new Map<SocialPost, Partial<Record<BandMetric, Band>>>();
  for (const kind of selected) {
    const ofKind = listed.filter((p) => p.kind === kind);
    bandPosts(ofKind, bandRules[kind], followersByAccount).forEach((bands: Partial<Record<BandMetric, Band>>, i: number) => bandOfPost.set(ofKind[i], bands));
  }
  const posts = listed.map((p) => ({ ...p, bands: bandOfPost.get(p) ?? {}, nonFollowersPct: nonFollowers.get(`${p.accountId}|${p.id}`) ?? null }));
  const publishedCount = sumKnown(current.postTotals.filter((p) => (selected as string[]).includes(p.kind as string)).map((p) => p.posts as number)) ?? 0;

  return {
    kinds,
    totals,
    byKind: kinds.map((kind) => ({ kind, totals: totalsFor([kind]) })),
    reach,
    series: ctx.range.grain === "hour" ? null : organicSeries(ctx.range, current.series, selected, coverage),
    drivers,
    driverSummary: driverSummary(drivers),
    audience: selected.includes("instagram") ? toAudience(audienceRows.filter((r) => r.kind === "instagram")) : null,
    posts,
    postsCapped: publishedCount > posts.length,
    engagementBases: Object.fromEntries(kinds.map((kind) => [kind, bases[kind] ?? DEFAULT_ENGAGEMENT_BASIS])) as OrganicPanel["engagementBases"],
    bandRules,
    bandsCustom: Object.fromEntries(kinds.map((kind) => [kind, bandRows.some((r) => r.kind === kind)])),
    postTags: tags.tags,
    postTagLinks: tags.links,
    activity: selected.length === 1 ? postActivity(posts, tags.tags, tags.links, ctx.tz) : null,
  };
}

function organicSeries(range: InsightsRange, rows: DayRow[], kinds: OrganicKind[], coverage: Coverage) {
  const line = (field: string | ((row: DayRow) => number | null)): SeriesPoint[] =>
    toSeries(range, bucketSeries(rows, field, kinds), (r: { value: number | null } | null) => r?.value ?? null, coverage);
  return { views: line("views"), engagement: line("engagement"), growth: line(netFollows), posts: line("posts") };
}

/**
 * Each platform's chosen basis, read live (not through the Insights cache) so a
 * change shows on the next render. A missing column or a failed read is the
 * default basis, never an error: the panel works without the choice.
 */
async function readEngagementBases(shopId: string): Promise<Record<string, EngagementBasis>> {
  try {
    const rows = (await supabaseSelect(getSupabaseClient(), SOCIAL_T.ACCOUNTS, { shop_id: shopId, enabled: true }, "kind,engagement_basis", { limit: 50 })) as {
      kind: string;
      engagement_basis: string;
    }[];
    return Object.fromEntries(
      rows.filter((r) => (ENGAGEMENT_BASES as string[]).includes(r.engagement_basis)).map((r) => [r.kind, r.engagement_basis as EngagementBasis])
    );
  } catch {
    return {};
  }
}

function toPost(row: Record<string, unknown>, bases: Record<string, EngagementBasis>, followersByAccount: Map<string, number | null>): SocialPost {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const engagement = n(row.engagement);
  const reach = n(row.reach);
  const views = n(row.views);
  const basis = bases[row.kind as string] ?? (DEFAULT_ENGAGEMENT_BASIS as EngagementBasis);
  const rate = postEngagementRate({ engagement, reach, views }, basis, followersByAccount.get(String(row.account_id)) ?? null);
  return {
    id: String(row.external_id),
    accountId: String(row.account_id),
    kind: row.kind as OrganicKind,
    publishedAt: String(row.published_at),
    mediaType: (row.media_type as string) ?? null,
    caption: (row.caption_excerpt as string) ?? null,
    permalink: (row.permalink as string) ?? null,
    thumbnailUrl: (row.thumbnail_url as string) ?? null,
    views,
    reach,
    engagement,
    engagementRate: rate,
    engagementBasis: basis,
    bands: {},
    nonFollowersPct: null,
    likes: n(row.likes),
    comments: n(row.comments),
    shares: n(row.shares),
    saves: n(row.saves),
    follows: n(row.follows),
  };
}

const TOP = { gender: 3, age: 6, country: 5, city: 5 } as const;

function toAudience(rows: { captured_on: string; dimension: string; key: string; value: number }[]): SocialAudience | null {
  if (rows.length === 0) return null;
  const dimension = (name: keyof typeof TOP): AudienceBucket[] => {
    const summed = new Map<string, number>();
    for (const r of rows.filter((x) => x.dimension === name)) summed.set(r.key, (summed.get(r.key) ?? 0) + Number(r.value));
    const total = [...summed.values()].reduce((a, b) => a + b, 0);
    return [...summed]
      .map(([key, value]) => ({ key, value, share: total > 0 ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP[name]);
  };
  return {
    capturedOn: rows.map((r) => r.captured_on).sort().at(-1) ?? null,
    gender: dimension("gender"),
    age: dimension("age"),
    country: dimension("country"),
    city: dimension("city"),
  };
}

const reachCache = new Map<string, { at: number; value: LiveReach }>();

/** Instagram reach and accounts engaged over the range, summed across tracked accounts. */
async function liveReach(ctx: { shopId: string; range: { from: string; to: string } }): Promise<LiveReach> {
  const fromMs = Date.parse(`${ctx.range.from}Z`);
  const toMs = Math.min(Date.parse(`${ctx.range.to}Z`), Date.now());
  if (toMs - fromMs > LIVE_REACH_MAX_DAYS * 24 * 3600 * 1000 + 3600 * 1000) {
    return { reach: null, accountsEngaged: null, blockedReason: "insights.social.reach.tooLong" };
  }
  const key = `${ctx.shopId}|${ctx.range.from}|${ctx.range.to}`;
  const hit = reachCache.get(key);
  if (hit && Date.now() - hit.at < REACH_CACHE_MS) return hit.value;

  const value = await readLiveReach(ctx, Math.floor(fromMs / 1000), Math.floor(toMs / 1000)).catch((error) => {
    console.warn("instagram reach unreadable", (error as Error).message);
    return { reach: null, accountsEngaged: null, blockedReason: "insights.social.reach.unreadable" } as LiveReach;
  });
  if (!value.blockedReason) reachCache.set(key, { at: Date.now(), value });
  return value;
}

async function readLiveReach(ctx: { shopId: string; range: { from: string; to: string } }, since: number, until: number): Promise<LiveReach> {
  const app = socialAppConfig(process.env).meta;
  const supabase = getSupabaseClient();
  const token = app.canSync ? await supabaseRpc(supabase, SOCIAL_RPC.READ_TOKEN, { p_shop: ctx.shopId, p_provider: "meta" }) : null;
  if (!token) return { reach: null, accountsEngaged: null, blockedReason: "insights.social.reach.disconnected" };

  const accounts = (await supabaseSelect(supabase, SOCIAL_T.ACCOUNTS, { shop_id: ctx.shopId, kind: "instagram", enabled: true }, "external_id", { limit: 20 })) as { external_id: string }[];
  const meta = createMetaClient({ token, appSecret: app.appSecret, graphVersion: app.graphVersion });
  const reach: (number | null)[] = [];
  const engaged: (number | null)[] = [];
  for (const account of accounts) {
    const { data } = await meta.insights(account.external_id, ["reach", "accounts_engaged"], { period: "day", metric_type: "total_value", since, until });
    const value = (name: string) => {
      const item = data.find((d: { name: string }) => d.name === name);
      return item?.total_value?.value ?? null;
    };
    reach.push(value("reach"));
    engaged.push(value("accounts_engaged"));
  }
  return { reach: sumKnown(reach), accountsEngaged: sumKnown(engaged), blockedReason: null };
}

// --- paid ---------------------------------------------------------------------------------

type PaidRow = {
  kind: string;
  account_id: string;
  currency: string;
  publisher: string;
  bucket: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
};

function emptyPaid(): PaidPanel {
  return {
    kinds: [],
    currency: null,
    totals: { current: [], previous: null },
    byKind: [],
    series: null,
    seriesBlockedReason: null,
    campaigns: [],
    campaignsCapped: false,
    campaignsBlockedReason: null,
  };
}

async function readPaid(ctx: InsightsContext, kinds: PaidKind[], selected: PaidKind[]): Promise<PaidPanel> {
  const coverage = await coverageOf(SOCIAL_T.AD_DAYS, ctx.shopId);
  const compare = previousCovered(ctx.range, coverage);
  const read = (window: { from: string; to: string }) =>
    callRpc<PaidRow>(SOCIAL_RPC.PAID_SERIES, { p_shop: ctx.shopId, p_from: window.from, p_to: window.to, p_grain: ctx.range.grain });
  const [current, previous, campaignCut] = await Promise.all([
    read(ctx.range),
    compare ? read(ctx.range.previous) : Promise.resolve(null),
    readCampaigns(ctx, selected),
  ]);

  const totalsFor = (only: PaidKind[]): Compared<PaidTotals[]> => ({
    current: paidTotals(current, only) as PaidTotals[],
    previous: previous ? (paidTotals(previous, only) as PaidTotals[]) : null,
  });
  const totals = totalsFor(selected);
  const currencies = [...new Set(current.filter((r) => (selected as string[]).includes(r.kind)).map((r) => r.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;

  let series: PaidPanel["series"] = null;
  let seriesBlockedReason: string | null = null;
  if (currencies.length > 1) seriesBlockedReason = "insights.social.paid.mixedCurrency";
  else if (ctx.range.grain === "hour") seriesBlockedReason = "insights.social.hourly";
  else {
    const sums = (field: keyof PaidRow) => bucketSeries(current, field, selected) as { bucket: string; value: number | null }[];
    const line = (rows: { bucket: string; value: number | null }[]) =>
      toSeries(ctx.range, rows, (r: { value: number | null } | null) => (r ? r.value : 0), coverage);
    const spend = sums("spend");
    const revenue = sums("conversion_value");
    const revenueBy = new Map(revenue.map((r) => [r.bucket, r.value]));
    series = {
      spend: line(spend),
      revenue: line(revenue),
      conversions: line(sums("conversions")),
      roas: toSeries(ctx.range, spend.map((s) => ({ bucket: s.bucket, value: ratio(revenueBy.get(s.bucket) ?? null, s.value) })), (r: { value: number | null } | null) => r?.value ?? null, coverage),
    };
  }

  return {
    kinds,
    currency,
    totals,
    byKind: kinds.map((kind) => ({ kind, totals: totalsFor([kind]) })),
    series,
    seriesBlockedReason,
    ...campaignCut,
  };
}

/**
 * The campaign table: every campaign with delivery in the range, rates rebuilt,
 * a link to it. Never throws: a database without 71 says so in the card and
 * leaves the rest of the panel standing.
 */
async function readCampaigns(
  ctx: InsightsContext,
  selected: PaidKind[]
): Promise<Pick<PaidPanel, "campaigns" | "campaignsCapped" | "campaignsBlockedReason">> {
  try {
    const rows = await callRpc<Record<string, unknown>>(CAMPAIGN_RPC.CAMPAIGNS, {
      p_shop: ctx.shopId,
      p_from: ctx.range.from,
      p_to: ctx.range.to,
      p_limit: CAMPAIGN_LIMIT,
    });
    const campaigns: PaidCampaign[] = rows
      .filter((r) => (selected as string[]).includes(r.kind as string))
      .map((r) => {
        const t = withRates({
          spend: Number(r.spend) || 0,
          impressions: Number(r.impressions) || 0,
          clicks: Number(r.clicks) || 0,
          conversions: Number(r.conversions) || 0,
          conversionValue: Number(r.conversion_value) || 0,
        });
        const kind = r.kind as PaidKind;
        const campaignId = String(r.campaign_id);
        return {
          key: `${r.account_id}|${campaignId}|${r.currency}`,
          kind,
          accountName: (r.account_name as string) ?? null,
          campaignId,
          name: (r.name as string) ?? null,
          status: (r.status as string) ?? null,
          objective: (r.objective as string) ?? null,
          currency: String(r.currency),
          spend: t.spend,
          impressions: t.impressions,
          clicks: t.clicks,
          conversions: t.conversions,
          conversionValue: t.conversionValue,
          ctr: t.ctr,
          cpc: t.cpc,
          cpa: t.cpa,
          roas: t.roas,
          url: campaignUrl({ kind, accountExternalId: (r.account_external_id as string) ?? null, campaignId }),
        };
      });
    return { campaigns, campaignsCapped: rows.length >= CAMPAIGN_LIMIT, campaignsBlockedReason: null };
  } catch (error) {
    console.warn("ad campaigns unreadable", (error as Error).message);
    return { campaigns: [], campaignsCapped: false, campaignsBlockedReason: "insights.social.campaigns.unreadable" };
  }
}

/**
 * From the first stored day to now: before it is not measured, so a bucket or
 * a comparison there is missing rather than zero.
 */
async function coverageOf(table: string, shopId: string): Promise<Coverage> {
  const rows = (await supabaseSelect(getSupabaseClient(), table, { shop_id: shopId }, "day", { order: "day.asc", limit: 1 })) as { day: string }[];
  const now = new Date().toISOString();
  // Nothing stored yet (connected, first sync still queued): everything is
  // before coverage, so every bucket draws missing and nothing is compared.
  return { from: rows?.[0]?.day ? `${rows[0].day}T00:00:00Z` : now, through: now };
}

// --- the Marketing panel's tabs -----------------------------------------------------

/**
 * Paid and organic sums for the Marketing panel's Paid and Social tabs, over the
 * current range. No live reach and no comparison: the Social panel has those.
 * Never throws — a failure reads as not connected, and the Marketing panel is
 * not the place to report a social sync.
 */
export async function getMarketingSocial(ctx: InsightsContext): Promise<MarketingSocial> {
  const empty: MarketingSocial = { paid: { connected: false, total: null, rows: [] }, organic: { connected: false, total: null, rows: [] } };
  try {
    const { accounts } = (await readSocialStatus(getSupabaseClient(), ctx.shopId)) as { accounts: { kind: string; enabled: boolean }[] };
    const tracked = new Set(accounts.filter((a) => a.enabled).map((a) => a.kind));
    const paidKinds = (PAID_KINDS as PaidKind[]).filter((k) => tracked.has(k));
    const organicKinds = (ORGANIC_KINDS as OrganicKind[]).filter((k) => tracked.has(k));

    const [paidRows, organicRows] = await Promise.all([
      paidKinds.length
        ? callRpc<PaidRow>(SOCIAL_RPC.PAID_SERIES, { p_shop: ctx.shopId, p_from: ctx.range.from, p_to: ctx.range.to, p_grain: "month" })
        : Promise.resolve([] as PaidRow[]),
      organicKinds.length ? readOrganicRows(ctx, ctx.range) : Promise.resolve(null),
    ]);

    const paidTotal = paidTotals(paidRows) as PaidTotals[];
    return {
      paid: {
        connected: paidKinds.length > 0,
        total: paidTotal.length === 1 ? paidTotal[0] : null,
        rows: paidKinds.map((kind) => ({ kind, totals: paidTotals(paidRows, [kind]) as PaidTotals[] })),
      },
      organic: {
        connected: organicKinds.length > 0,
        total: organicRows ? organicTotals(organicRows) : null,
        rows: organicRows ? organicKinds.map((kind) => ({ kind, totals: organicTotals(organicRows, [kind]) })) : [],
      },
    };
  } catch (error) {
    console.warn("marketing social unreadable", (error as Error).message);
    return empty;
  }
}

/** Exact-period unique figures shared with the calendar report; the same 30-day/provider limits apply. */
export function getSocialReportReach(shopId: string, from: string, to: string): Promise<LiveReach> {
  return liveReach({ shopId, range: { from, to } });
}
