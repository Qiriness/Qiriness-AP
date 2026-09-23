/**
 * The storefront figures, read live from Shopify Analytics (ShopifyQL) at
 * render time: sessions, conversion rate, pageviews, bounce rate, and traffic
 * by source.
 *
 * LIVE, NOT SYNCED — see scripts/lib/storefront-analytics.mjs for why a rate
 * cannot be stored daily and summed back. The whole panel's worth of figures is
 * ONE HTTP REQUEST: five ShopifyQL queries aliased into a single GraphQL
 * document, cached for five minutes (the interval the page re-renders itself
 * at), so a reader flipping between Overview and Marketing does not re-ask.
 *
 * `available` DESCRIBES THE SESSION FIGURES ONLY. `sales` — Shopify's money
 * ladder — is separately nullable, because a marketplace platform has no
 * storefront traffic but does have sales.
 *
 * IT CAN FAIL, AND FAILING IS A BLOCKED CARD. Shopify being slow or down must
 * not take the panel with it: every failure resolves to `blockedReason`, which
 * the views render as a dash with the reason — the house rule that a figure
 * which could not be measured never renders as zero. Nothing here throws.
 *
 * THE RESPONSE SHAPE IS THE ONE MEASURED ON 2026-07: `parseErrors` is a list of
 * strings and `rows` is JSON already keyed by column name. If a later version
 * renames either, every card blocks with the GraphQL error in its reason and
 * `npm run probe:analytics` prints the current schema.
 *
 * Server-only.
 */

import { createShopifyClient, shopifyGraphql } from "../../../../scripts/lib/shopify-admin-client.mjs";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";
import { bucketCoverage, isMarketplacePlatform } from "../../../../scripts/lib/insights-range.mjs";
import {
  channelSalesQuery,
  channelSessionsQuery,
  foldMonthlyLadder,
  foldMonthlySessions,
  foldSalesLadder,
  foldSeries,
  funnelSteps,
  joinChannels,
  isMonthAligned,
  landingTypesQuery,
  monthlyLadderQuery,
  monthlySessionsQuery,
  productPagesQuery,
  readLandingTypes,
  readProductPages,
  readTotals,
  salesLadderQuery,
  seriesQuery,
  totalsQuery,
} from "../../../../scripts/lib/storefront-analytics.mjs";
import type {
  BucketState,
  FunnelStep,
  LandingType,
  ProductPage,
  SeriesPoint,
  StorefrontAnalytics,
  StorefrontChannel,
  StorefrontSales,
  StorefrontTotals,
} from "../../types";
import { bucketLabel, bucketTitle } from "../../../../scripts/lib/insights-range.mjs";
import type { InsightsContext } from "./context";

/**
 * Long enough for the seven aggregates AND one throttle retry, short enough
 * that a stalled Shopify does not stall the page. Measured 2026-09-23: the
 * whole document answers in 1.7-2.0 s; at 8 s a retried 429 ran out of budget
 * and blocked cards that would have loaded.
 */
const TIMEOUT_MS = 12_000;

/** The page re-renders itself every five minutes; asking more often than that buys nothing. */
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; value: Promise<StorefrontAnalytics> }>();

/**
 * One Shopify client for the process. `createShopifyClient` exchanges the app
 * credentials for a token when no admin token is configured, and doing that on
 * every panel render would put an OAuth round trip (and its five retries) in
 * front of every figure. A failure is not remembered, so the next render retries.
 */
let shopifyClient: Promise<{ endpoint: string; token: string }> | null = null;

function client() {
  if (!shopifyClient) {
    shopifyClient = createShopifyClient(loadConfig(process.env as Record<string, string | undefined>)).catch(
      (error: unknown) => {
        shopifyClient = null;
        throw error;
      }
    );
  }
  return shopifyClient;
}

const EMPTY_TOTALS: StorefrontTotals = {
  sessions: null,
  visitors: null,
  conversionRate: null,
  pageviews: null,
  bounceRate: null,
  cartSessions: null,
  checkoutSessions: null,
  convertedSessions: null,
};

const BLOCKED_MARKETPLACE =
  "Not measured for a marketplace: Shopify Analytics counts storefront traffic, and Amazon and Yves Rocher orders never touch the storefront.";

export function getStorefrontAnalytics(ctx: InsightsContext): Promise<StorefrontAnalytics> {
  // Sessions are the storefront's whatever the order filter says, but the money
  // ladder is folded per platform, so the platform belongs in the key.
  const key = `${ctx.shopId}|${ctx.range.from}|${ctx.range.to}|${ctx.range.grain}|${ctx.range.previous.from}|${ctx.platform}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const entry = { at: Date.now(), value: read(ctx) };
  cache.set(key, entry);
  // A failed read is not worth keeping: the next render should try again. A
  // marketplace's blocked sessions are by design, and its ladder is real, so
  // that answer stays cached.
  entry.value.then((result) => {
    if (!result.available && !result.sales.current && cache.get(key) === entry) cache.delete(key);
  });
  return entry.value;
}

/**
 * The sessions totals and the money ladder for several windows at once — what
 * the monthly report needs for the month, the month before, the same month a
 * year earlier and the two half-years.
 *
 * TWO QUERIES, NOT TWO PER WINDOW. ShopifyQL is throttled on a bucket of its
 * own, separate from the GraphQL point budget, and asking for five windows of
 * both datasets came back THROTTLED with that bucket at zero while the
 * top-level budget still read 1,990 of 2,000. Every window a monthly report
 * asks for is whole months, so the span is read once as monthly buckets and
 * each window sums the months inside it.
 *
 * A window that is NOT month-aligned — an in-progress month compares the same
 * DAYS of the month before — cannot be summed from months without inventing a
 * fall, so those windows are still asked for directly.
 *
 * Uncached and one request: a report is built once, and its windows are not the
 * ones a panel asks for. A failure is null per window, never a zero.
 */
export async function getStorefrontTotalsFor(
  ctx: InsightsContext,
  windows: { from: string; to: string }[]
): Promise<{ totals: StorefrontTotals | null; sales: StorefrontSales | null }[]> {
  const nothing = windows.map(() => ({ totals: null, sales: null }));
  if (windows.length === 0) return nothing;
  const marketplace = isMarketplacePlatform(ctx.platform);
  // The monthly ladder has no sales channel to fold on, so a report filtered to
  // one platform still asks per window.
  const monthly = ctx.platform === "all" && windows.every(isMonthAligned);

  const queries: Record<string, string> = {};
  if (monthly) {
    const span = {
      ...ctx.range,
      from: windows.reduce((min, w) => (w.from < min ? w.from : min), windows[0].from),
      to: windows.reduce((max, w) => (w.to > max ? w.to : max), windows[0].to),
    };
    if (!marketplace) queries.months = monthlySessionsQuery(span);
    queries.ladderMonths = monthlyLadderQuery(span);
  } else {
    for (const [i, window] of windows.entries()) {
      const range = { ...ctx.range, from: window.from, to: window.to };
      if (!marketplace) queries[`s${i}`] = totalsQuery(range);
      queries[`m${i}`] = salesLadderQuery(range);
    }
  }

  try {
    const answers = await withTimeout(runAll(queries), TIMEOUT_MS);
    const ok = (key: string) => {
      const answer = answers[key];
      return answer && answer.parseErrors.length === 0 ? answer.rows : null;
    };
    if (monthly) {
      const sessionMonths = ok("months");
      const ladderMonths = ok("ladderMonths");
      return windows.map((window) => {
        const totals = sessionMonths ? (foldMonthlySessions(sessionMonths, window) as StorefrontTotals | null) : null;
        return {
          totals: totals && totals.sessions !== null ? totals : null,
          sales: ladderMonths ? (foldMonthlyLadder(ladderMonths, window) as StorefrontSales | null) : null,
        };
      });
    }
    return windows.map((_, i) => {
      const sessions = ok(`s${i}`);
      const money = ok(`m${i}`);
      const totals = sessions ? (readTotals(sessions) as StorefrontTotals) : null;
      return {
        totals: totals && totals.sessions !== null ? totals : null,
        sales: money ? (foldSalesLadder(money, ctx.platform) as StorefrontSales | null) : null,
      };
    });
  } catch {
    return nothing;
  }
}

async function read(ctx: InsightsContext): Promise<StorefrontAnalytics> {
  // A MARKETPLACE HAS NO SESSIONS BUT IT DOES HAVE SALES. Amazon and Yves
  // Rocher orders never touch the storefront, so traffic, the funnel and the
  // channel table are blocked — but Shopify's money ladder is per sales
  // channel, so net sales and AOV are still answerable and are still asked for.
  const marketplace = isMarketplacePlatform(ctx.platform);
  const previousWindow = { ...ctx.range, from: ctx.range.previous.from, to: ctx.range.previous.to };
  const queries: Record<string, string> = {
    ladder: salesLadderQuery(ctx.range),
    ladderPrevious: salesLadderQuery(previousWindow),
  };
  if (!marketplace) {
    queries.totals = totalsQuery(ctx.range);
    queries.previous = totalsQuery(previousWindow);
    queries.series = seriesQuery(ctx.range);
    queries.channelSessions = channelSessionsQuery(ctx.range);
    queries.channelSales = channelSalesQuery(ctx.range);
    queries.landingTypes = landingTypesQuery(ctx.range);
    queries.productPages = productPagesQuery(ctx.range);
  }

  let answers: Record<string, { rows: Record<string, unknown>[]; parseErrors: string[] }>;
  try {
    answers = await withTimeout(runAll(queries), TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(ctx, `Shopify Analytics could not be read: ${message.slice(0, 200)}`);
  }

  // A refusal is Shopify saying the query is wrong, not that the store is
  // quiet. It is reported rather than rendered as an empty chart.
  const refusal = Object.entries(answers).find(([, answer]) => answer.parseErrors.length > 0);
  if (refusal) {
    return blocked(ctx, `Shopify Analytics refused the query: ${refusal[1].parseErrors.join("; ").slice(0, 200)}`);
  }

  const landingTypes = readLandingTypes(answers.landingTypes?.rows ?? []) as LandingType[];
  const productEntries = landingTypes.find((row) => row.type.toLowerCase() === "product")?.sessions ?? null;
  const ladder = foldSalesLadder(answers.ladder.rows, ctx.platform) as StorefrontSales | null;
  const ladderBefore = foldSalesLadder(answers.ladderPrevious.rows, ctx.platform) as StorefrontSales | null;
  if (marketplace) return { ...blocked(ctx, BLOCKED_MARKETPLACE), sales: { current: ladder, previous: ladderBefore } };

  const current = readTotals(answers.totals.rows) as StorefrontTotals;
  const earlier = readTotals(answers.previous.rows) as StorefrontTotals;
  const folded = foldSeries(answers.series.rows, ctx.range) as Map<string, number>;
  const states = bucketCoverage(ctx.range, { from: null, through: null }) as BucketState[];

  return {
    available: true,
    blockedReason: null,
    totals: {
      current,
      // No session at all in a whole earlier period is an unmeasured period on
      // a live store, not a quiet one — so there is no comparison, rather than
      // a −100% against zero.
      previous: earlier.sessions ? earlier : null,
    },
    sales: { current: ladder, previous: ladderBefore },
    funnel: funnelSteps(current, productEntries) as FunnelStep[],
    sessions: ctx.range.keys.map((key, i): SeriesPoint => ({
      key,
      label: bucketLabel(key, ctx.range.grain) as string,
      title: bucketTitle(key, ctx.range.grain) as string,
      value: states[i] === "missing" ? null : folded.get(key) ?? 0,
      state: states[i],
    })),
    channels: joinChannels(answers.channelSessions.rows, answers.channelSales.rows) as StorefrontChannel[],
    landingTypes,
    productPages: readProductPages(answers.productPages.rows) as ProductPage[],
  };
}

/** The five queries as one document, so the panel costs one request. */
async function runAll(queries: Record<string, string>) {
  const names = Object.keys(queries);
  const document = `#graphql
    query StorefrontAnalytics(${names.map((name) => `$${name}: String!`).join(", ")}) {
      ${names.map((name) => `${name}: shopifyqlQuery(query: $${name}) { parseErrors tableData { rows } }`).join("\n      ")}
    }
  `;
  const data = (await shopifyGraphql(await client(), document, queries)) as Record<string, unknown>;

  return Object.fromEntries(
    names.map((name) => {
      const answer = (data?.[name] ?? {}) as { parseErrors?: unknown; tableData?: { rows?: unknown } };
      const rows = answer.tableData?.rows;
      return [
        name,
        {
          rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
          parseErrors: Array.isArray(answer.parseErrors) ? answer.parseErrors.map(String) : [],
        },
      ];
    })
  ) as Record<string, { rows: Record<string, unknown>[]; parseErrors: string[] }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Every figure absent, with the one reason the views print. */
function blocked(ctx: InsightsContext, reason: string): StorefrontAnalytics {
  return {
    available: false,
    blockedReason: reason,
    totals: { current: EMPTY_TOTALS, previous: null },
    sales: { current: null, previous: null },
    funnel: funnelSteps(EMPTY_TOTALS) as FunnelStep[],
    sessions: ctx.range.keys.map((key) => ({
      key,
      label: bucketLabel(key, ctx.range.grain) as string,
      title: bucketTitle(key, ctx.range.grain) as string,
      value: null,
      state: "missing" as BucketState,
    })),
    channels: [],
    landingTypes: [],
    productPages: [],
  };
}
