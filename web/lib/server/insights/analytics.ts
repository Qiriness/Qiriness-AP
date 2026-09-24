/**
 * The storefront figures from Shopify Analytics (ShopifyQL): the money ladder
 * (net sales, AOV), sessions, conversion and the funnel, the sessions trend,
 * and traffic by channel, landing page and product page.
 *
 * ONE FUNCTION PER CARD GROUP, EACH ITS OWN PROMISE. A panel renders its
 * database figures at once and each Shopify card streams in when its own
 * queries answer, so a card waiting on the rate limit never holds up the page
 * — and never blanks a card whose queries were answered.
 *
 * MONEY IS ALWAYS LIVE, FOR THE EXACT RANGE. Net sales and AOV are the figures
 * the owner reads first (their rule, 2026-09-24), so the ladder is Shopify's
 * answer for the window asked, at every length, and goes first in the queue.
 *
 * SESSIONS COME FROM STORED MONTHS WHERE THEY CAN. Closed months older than the
 * live window are read from `storefront_session_months` (written nightly), and
 * only the last two months and a range's stray edge days are asked live — see
 * scripts/lib/storefront-months.mjs. A range inside the live window is one
 * live query and Shopify's answer untouched.
 *
 * IT CAN FAIL, AND FAILING IS A BLOCKED CARD. Every part resolves — never
 * rejects — to a value plus `blockedReason`, which the views render as a dash
 * with the reason: a figure that could not be measured never renders as zero.
 *
 * Server-only.
 */

import { STOREFRONT_T } from "../../../../scripts/lib/tables.mjs";
import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import {
  bucketCoverage,
  bucketLabel,
  bucketTitle,
  isMarketplacePlatform,
  wallClock,
} from "../../../../scripts/lib/insights-range.mjs";
import {
  channelSalesQuery,
  channelSessionsQuery,
  foldSalesLadder,
  foldSalesSeries,
  foldSeries,
  funnelSteps,
  joinChannels,
  landingTypesQuery,
  platformMix,
  productPagesQuery,
  readLandingTypes,
  readProductPages,
  readTotals,
  salesLadderQuery,
  salesSeriesQuery,
  seriesQuery,
  totalsQuery,
} from "../../../../scripts/lib/storefront-analytics.mjs";
import { combineSessionTotals, liveFrom, planSessionWindow } from "../../../../scripts/lib/storefront-months.mjs";
import type {
  BucketState,
  Compared,
  FunnelStep,
  SalesSeries,
  StorefrontMoney,
  LandingType,
  LivePart,
  ProductPage,
  SeriesPoint,
  StorefrontChannel,
  StorefrontSales,
  StorefrontTotals,
} from "../../types";
import type { InsightsContext } from "./context";
import { getSupabaseClient } from "./shared";
import { PRIORITY, shopifyql, type Row } from "./shopifyql";

type Window = { from: string; to: string };

export const EMPTY_TOTALS: StorefrontTotals = {
  sessions: null,
  visitors: null,
  conversionRate: null,
  pageviews: null,
  bounceRate: null,
  cartSessions: null,
  checkoutSessions: null,
  convertedSessions: null,
};

export const BLOCKED_MARKETPLACE =
  "Not measured for a marketplace: Shopify Analytics counts storefront traffic, and Amazon and Yves Rocher orders never touch the storefront.";

/** What a card prints while its Shopify queries are waiting. */
export const LOADING_REASON = "Loading from Shopify Analytics…";

/** Resolve, never reject: a failure becomes the reason the card prints. */
async function part<T>(empty: T, read: () => Promise<T>): Promise<LivePart<T>> {
  try {
    return { blockedReason: null, value: await read() };
  } catch (error) {
    return { blockedReason: error instanceof Error ? error.message : String(error), value: empty };
  }
}

const previousWindow = (ctx: InsightsContext): Window => ({ from: ctx.range.previous.from, to: ctx.range.previous.to });

/**
 * "All time" has no earlier period to compare with (its label says so), and at
 * up to 1,000 points a query, asking for one anyway would cost a whole minute.
 */
const hasComparison = (ctx: InsightsContext) => ctx.range.preset !== "all";

// --- money: always live ------------------------------------------------------

/** Shopify's money ladder for one window, folded onto the platform filter. Live, exact. */
async function ladderFor(ctx: InsightsContext, window: Window): Promise<StorefrontSales | null> {
  const rows = await shopifyql(salesLadderQuery({ ...ctx.range, ...window }), PRIORITY.money);
  return foldSalesLadder(rows, ctx.platform) as StorefrontSales | null;
}

const NO_MONEY: StorefrontMoney = { current: null, previous: null, storefront: { current: null, previous: null }, platforms: [] };

/**
 * Every money figure the Overview prints, from the ladder for the window and
 * the one before: folded onto the platform filter, onto the storefront (for
 * revenue per session), and per platform (for the mix). Asked for on a
 * marketplace too: the ladder is per sales channel. Two queries, whatever is
 * folded out of them.
 */
export function liveSales(ctx: InsightsContext): Promise<LivePart<StorefrontMoney>> {
  return part(NO_MONEY, async () => {
    const [rows, before] = await Promise.all([
      shopifyql(salesLadderQuery(ctx.range), PRIORITY.money),
      hasComparison(ctx) ? shopifyql(salesLadderQuery({ ...ctx.range, ...previousWindow(ctx) }), PRIORITY.money) : Promise.resolve(null),
    ]);
    const fold = (r: Row[] | null, platform: string) => (r ? (foldSalesLadder(r, platform) as StorefrontSales | null) : null);
    return {
      current: fold(rows, ctx.platform),
      previous: fold(before, ctx.platform),
      storefront: { current: fold(rows, "shopify"), previous: fold(before, "shopify") },
      platforms: platformMix(rows) as StorefrontMoney["platforms"],
    };
  });
}

/** Net sales, orders and AOV per bucket — the trend, on the headline's basis. */
export function liveSalesSeries(ctx: InsightsContext): Promise<LivePart<SalesSeries | null>> {
  return part(null, async () => {
    const folded = foldSalesSeries(await shopifyql(salesSeriesQuery(ctx.range), PRIORITY.money), ctx.range, ctx.platform) as {
      netSales: Map<string, number>;
      orders: Map<string, number>;
      aov: Map<string, number>;
    };
    const states = bucketCoverage(ctx.range, { from: null, through: null }) as BucketState[];
    const points = (values: Map<string, number>, empty: number | null) =>
      ctx.range.keys.map(
        (key, i): SeriesPoint => ({
          key,
          label: bucketLabel(key, ctx.range.grain) as string,
          title: bucketTitle(key, ctx.range.grain) as string,
          value: states[i] === "missing" ? null : values.get(key) ?? empty,
          state: states[i],
        })
      );
    // A bucket with no order has no average, not an average of zero.
    return { netSales: points(folded.netSales, 0), orders: points(folded.orders, 0), aov: points(folded.aov, null) };
  });
}

/** The ladder for several windows — the monthly report's five. Live, one query per window. */
export async function salesFor(ctx: InsightsContext, windows: Window[]): Promise<(StorefrontSales | null)[]> {
  return Promise.all(windows.map((window) => ladderFor(ctx, window).catch(() => null)));
}

// --- sessions: stored closed months + live -----------------------------------

const MONTHS_TTL_MS = 10 * 60 * 1000;
const monthsCache = new Map<string, { at: number; value: Promise<Map<string, Record<string, unknown>>> }>();

/** Every stored month for the shop — 36 rows — by `YYYY-MM-01`. A failed read is an empty store: everything goes live. */
function storedMonths(shopId: string): Promise<Map<string, Record<string, unknown>>> {
  const hit = monthsCache.get(shopId);
  if (hit && Date.now() - hit.at < MONTHS_TTL_MS) return hit.value;
  const value = (
    supabaseSelect(getSupabaseClient(), STOREFRONT_T.SESSION_MONTHS, { shop_id: shopId }, "*", { limit: 1000 }) as Promise<
      Record<string, unknown>[]
    >
  )
    .then((rows) => new Map((rows ?? []).map((row) => [String(row.month).slice(0, 10), row])))
    .catch(() => new Map<string, Record<string, unknown>>());
  monthsCache.set(shopId, { at: Date.now(), value });
  return value;
}

/**
 * Sessions totals for one window: stored whole closed months, plus live
 * ShopifyQL for the rest. With the shop's timezone unknown the months would be
 * cut on the wrong clock, so nothing stored is used.
 */
export async function sessionTotalsFor(ctx: InsightsContext, window: Window, priority: number): Promise<StorefrontTotals> {
  const store = ctx.tzFallback ? new Map<string, Record<string, unknown>>() : await storedMonths(ctx.shopId);
  const plan = planSessionWindow(window, { liveFrom: liveFrom(wallClock(new Date(), ctx.tz)), stored: store.keys() });
  const live = await Promise.all(
    plan.live.map(async (piece) => readTotals(await shopifyql(totalsQuery({ ...ctx.range, ...piece }), priority)) as StorefrontTotals)
  );
  return combineSessionTotals(
    plan.months.map((month) => store.get(month)!),
    live
  ) as StorefrontTotals;
}

/**
 * Sessions, conversion and the funnel counts, now and one period earlier.
 * `previous` is null when there is nothing to compare: no earlier period, or
 * no session at all in it — a live store with zero sessions in a whole period
 * is unmeasured, not quiet.
 */
export function liveTotals(
  ctx: InsightsContext,
  { compare = true }: { compare?: boolean } = {}
): Promise<LivePart<Compared<StorefrontTotals>>> {
  if (isMarketplacePlatform(ctx.platform)) {
    return Promise.resolve({ blockedReason: BLOCKED_MARKETPLACE, value: { current: EMPTY_TOTALS, previous: null } });
  }
  return part({ current: EMPTY_TOTALS, previous: null }, async () => {
    const [current, earlier] = await Promise.all([
      sessionTotalsFor(ctx, ctx.range, PRIORITY.headline),
      compare && hasComparison(ctx) ? sessionTotalsFor(ctx, previousWindow(ctx), PRIORITY.headline) : Promise.resolve(null),
    ]);
    return { current, previous: earlier?.sessions ? earlier : null };
  });
}

/** The sessions trend, one point per bucket of the range. Live: a year costs 78 points. */
export function liveSessionSeries(ctx: InsightsContext): Promise<LivePart<SeriesPoint[] | null>> {
  if (isMarketplacePlatform(ctx.platform)) return Promise.resolve({ blockedReason: BLOCKED_MARKETPLACE, value: null });
  return part(null, async () => {
    const folded = foldSeries(await shopifyql(seriesQuery(ctx.range), PRIORITY.trend), ctx.range) as Map<string, number>;
    const states = bucketCoverage(ctx.range, { from: null, through: null }) as BucketState[];
    return ctx.range.keys.map(
      (key, i): SeriesPoint => ({
        key,
        label: bucketLabel(key, ctx.range.grain) as string,
        title: bucketTitle(key, ctx.range.grain) as string,
        value: states[i] === "missing" ? null : folded.get(key) ?? 0,
        state: states[i],
      })
    );
  });
}

// --- the detail tables: live, last in the queue ------------------------------

export function liveChannels(ctx: InsightsContext): Promise<LivePart<StorefrontChannel[]>> {
  if (isMarketplacePlatform(ctx.platform)) return Promise.resolve({ blockedReason: BLOCKED_MARKETPLACE, value: [] });
  return part([], async () => {
    const [sessions, sales] = await Promise.all([
      shopifyql(channelSessionsQuery(ctx.range), PRIORITY.detail),
      shopifyql(channelSalesQuery(ctx.range), PRIORITY.detail),
    ]);
    return joinChannels(sessions, sales) as StorefrontChannel[];
  });
}

export function liveLandingTypes(ctx: InsightsContext): Promise<LivePart<LandingType[]>> {
  if (isMarketplacePlatform(ctx.platform)) return Promise.resolve({ blockedReason: BLOCKED_MARKETPLACE, value: [] });
  return part([], async () => readLandingTypes(await shopifyql(landingTypesQuery(ctx.range), PRIORITY.detail)) as LandingType[]);
}

export function liveProductPages(ctx: InsightsContext): Promise<LivePart<ProductPage[]>> {
  if (isMarketplacePlatform(ctx.platform)) return Promise.resolve({ blockedReason: BLOCKED_MARKETPLACE, value: [] });
  return part([], async () => readProductPages(await shopifyql(productPagesQuery(ctx.range), PRIORITY.detail)) as ProductPage[]);
}

/**
 * The funnel: the four session steps from the totals, with product-page
 * ENTRIES beside them (outside the chain — see funnelSteps). Blocked if the
 * totals are; the entries row alone says "not measured" if only it failed.
 */
export async function liveFunnel(
  totals: Promise<LivePart<Compared<StorefrontTotals>>>,
  landing: Promise<LivePart<LandingType[]>>
): Promise<LivePart<FunnelStep[]>> {
  const [t, l] = await Promise.all([totals, landing]);
  const productEntries = l.value.find((row) => row.type.toLowerCase() === "product")?.sessions ?? null;
  return { blockedReason: t.blockedReason, value: funnelSteps(t.value.current, productEntries) as FunnelStep[] };
}

/** Sessions totals for several windows — the monthly report's five. A failure is null per window, never a zero. */
export async function sessionTotalsForWindows(ctx: InsightsContext, windows: Window[]): Promise<(StorefrontTotals | null)[]> {
  if (isMarketplacePlatform(ctx.platform)) return windows.map(() => null);
  return Promise.all(
    windows.map((window) =>
      sessionTotalsFor(ctx, window, PRIORITY.headline)
        .then((totals) => (totals.sessions !== null ? totals : null))
        .catch(() => null)
    )
  );
}
