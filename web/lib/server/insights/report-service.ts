/**
 * The monthly sales report's data: one calendar month on every platform, set
 * against the month before (MoM) and the same month a year earlier (YoY).
 *
 * THE SAME READS AS THE PANELS. Each figure comes from the function the
 * Overview, Sales, Marketing, Customers or Fulfilment panel prints it from, and
 * the rules — AOV, the bridge, the signals, stock status — from
 * scripts/lib/sales-overview.mjs. So the report and the dashboard for the same
 * month agree to the cent; the report adds no definition of its own.
 *
 * A comparison period that starts before a source's history is null, never a
 * quiet period: the orders from the first synced order, the newsletter from
 * the earliest recorded unsubscribe.
 *
 * The rendering is scripts/lib/sales-report.mjs, pure, so a mail job can use it.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { SALES_COLLECTION_HANDLES } from "../../../../scripts/lib/sales-collections.mjs";
import {
  ALL_MARKETPLACE_HANDLES,
  bucketLabel,
  fromKey,
  monthLabel,
  resolveRange,
  step,
  toKey,
  windowCovered,
  yearEarlier,
} from "../../../../scripts/lib/insights-range.mjs";
import type { InsightsRange, PlatformSplit } from "../../types";
import { orderArgs, rangeArgs, resolveInsightsContext, type InsightsContext } from "./context";
import { getStorefrontAnalytics, getStorefrontTotalsFor } from "./analytics";
import { getInventoryExceptions } from "./inventory";
import { getPromotions } from "./marketing-service";
import { mapFigures, mapSummary, ordersCoverage } from "./orders";
import { signalsFor } from "./overview-service";
import { foldPlatforms, mapProduct } from "./sales-service";
import { toSeries } from "./series";
import { callRpc, callRpcOne, count, num } from "./shared";

/** How many products the report ranks. */
const REPORT_PRODUCTS = 10;

/** The six ranges; the row after them is everything outside them. */
const REPORT_COLLECTIONS = 10;

/** One collection row for the report, with its change on the previous month. */
function mapReportCollection(row: Record<string, unknown>, previousRows: Record<string, unknown>[] | null) {
  const key = (r: Record<string, unknown>) =>
    r.collection_id === null || r.collection_id === undefined ? "__outside" : String(r.collection_id);
  const previous = previousRows ? new Map(previousRows.map((r) => [key(r), count(r.revenue)])) : null;
  const collectionId = row.collection_id === null || row.collection_id === undefined ? null : String(row.collection_id);
  return {
    collectionId,
    title: collectionId === null ? "Outside these ranges" : String(row.title ?? "Untitled collection"),
    products: count(row.products),
    orders: count(row.orders),
    revenue: count(row.revenue),
    previousRevenue: previous ? previous.get(key(row)) ?? 0 : null,
  };
}

type Window = { from: string; to: string };

/** A month the report cannot be built for: malformed, or not started yet. */
export class ReportMonthError extends Error {}

export async function buildSalesReport(month: string) {
  const ctx = await resolveInsightsContext({ month });
  if (ctx.range.preset !== "month" || ctx.range.query.month !== month) {
    throw new ReportMonthError(`No report for "${month}": expected a month in YYYY-MM form, not in the future.`);
  }
  const range = ctx.range;
  const yoyWindow = yearEarlier(range) as Window;
  // SIX MONTHS ENDING WITH THIS ONE, against the six before: the trend
  // comparison, where a single month is too small to read. The month itself is
  // included, so "6M" always ends where the report does.
  const sixWindow: Window = { from: toKey(step(fromKey(range.from), "month", -5)), to: range.to };
  const sixPreviousWindow: Window = { from: toKey(step(fromKey(range.from), "month", -11)), to: sixWindow.from };
  const coverage = ordersCoverage(ctx);
  const momCovered = windowCovered(range.previous, coverage, range.tz);
  const yoyCovered = windowCovered(yoyWindow, coverage, range.tz);
  const sixCovered = windowCovered(sixWindow, coverage, range.tz);
  const sixPreviousCovered = windowCovered(sixPreviousWindow, coverage, range.tz);

  const trendRange = twelveMonths(ctx);
  const [
    current,
    mom,
    yoy,
    six,
    sixPrevious,
    trendRows,
    channelRows,
    productRows,
    previousProductRows,
    promotions,
    inventory,
    carrierRows,
    collectionRows,
    previousCollectionRows,
  ] =
    await Promise.all([
      readPeriod(ctx, range),
      momCovered ? readPeriod(ctx, range.previous) : Promise.resolve(null),
      yoyCovered ? readPeriod(ctx, yoyWindow) : Promise.resolve(null),
      sixCovered ? readPeriod(ctx, sixWindow) : Promise.resolve(null),
      sixPreviousCovered ? readPeriod(ctx, sixPreviousWindow) : Promise.resolve(null),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SERIES, {
        ...orderArgs(ctx, trendRange),
        p_grain: "month",
      }),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_BY_CHANNEL, rangeArgs(ctx)),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_SALES, orderArgs(ctx)),
      momCovered
        ? callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_SALES, orderArgs(ctx, range.previous))
        : Promise.resolve(null),
      getPromotions(ctx),
      getInventoryExceptions(ctx),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_FULFILMENT_CARRIERS, orderArgs(ctx)),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_COLLECTION_SALES, {
        ...orderArgs(ctx),
        p_limit: REPORT_COLLECTIONS,
        p_handles: [...SALES_COLLECTION_HANDLES],
      }),
      momCovered
        ? callRpc<Record<string, unknown>>(RPC.INSIGHTS_COLLECTION_SALES, {
            ...orderArgs(ctx, range.previous),
            p_limit: REPORT_COLLECTIONS,
            p_handles: [...SALES_COLLECTION_HANDLES],
          })
        : Promise.resolve(null),
    ]);

  // Storefront traffic, live from Shopify: the three windows' totals in one
  // request, and the channel table for the month itself.
  const [storefrontTotals, storefront, storefrontRevenue] = await Promise.all([
    getStorefrontTotalsFor(ctx, [range, range.previous, yoyWindow, sixWindow, sixPreviousWindow]),
    getStorefrontAnalytics(ctx),
    // Revenue per session divides storefront revenue, not the headline revenue
    // — marketplace buyers never had a session. Same rule as Overview.
    Promise.all([
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, range, "shopify")),
      momCovered
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, range.previous, "shopify"))
        : Promise.resolve(null),
      yoyCovered
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, yoyWindow, "shopify"))
        : Promise.resolve(null),
      sixCovered
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, sixWindow, "shopify"))
        : Promise.resolve(null),
      sixPreviousCovered
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, sixPreviousWindow, "shopify"))
        : Promise.resolve(null),
    ]),
  ]);

  // Newsletter coverage is its own: before the earliest recorded unsubscribe,
  // losses read as zero because they were never kept, so that period is null.
  const unsubscribesFrom = current.unsubscribesFrom;
  const newsletterEdge = { from: unsubscribesFrom, through: null };
  const keepNewsletter = (p: Period | null, w: Window) =>
    p && !windowCovered(w, newsletterEdge, range.tz) ? { ...p, newsletter: null } : p;

  const previousRevenue = new Map(
    (previousProductRows ?? []).map((row) => [String(row.product_id), count(row.revenue)] as const)
  );
  const monthly = trendRows.map((r) => ({ bucket: String(r.bucket), revenue: count(r.revenue), orders: count(r.orders) }));
  const trend = toSeries(trendRange, monthly, (row) => row?.revenue ?? 0, coverage);
  const trendOrders = toSeries(trendRange, monthly, (row) => row?.orders ?? 0, coverage);

  // The storefront figures ride on each period beside the figures from our own
  // database, so the renderer reads one object per period.
  const withStorefront = (period: Period | null, i: number) => {
    if (!period) return null;
    const { totals, sales } = storefrontTotals[i];
    const summaryRow = storefrontRevenue[i];
    return {
      ...strip(period),
      sessions: totals?.sessions ?? null,
      visitors: totals?.visitors ?? null,
      conversionRate: totals?.conversionRate ?? null,
      bounceRate: totals?.bounceRate ?? null,
      cartSessions: totals?.cartSessions ?? null,
      checkoutSessions: totals?.checkoutSessions ?? null,
      convertedSessions: totals?.convertedSessions ?? null,
      // Shopify's ladder: what the admin's Sales report prints for this window.
      netSales: sales?.netSales ?? null,
      grossSales: sales?.grossSales ?? null,
      ladderDiscounts: sales?.discounts ?? null,
      ladderReturns: sales?.returns ?? null,
      taxes: sales?.taxes ?? null,
      shipping: sales?.shipping ?? null,
      totalSales: sales?.totalSales ?? null,
      shopifyOrders: sales?.orders ?? null,
      averageOrderValue: sales?.averageOrderValue ?? null,
      storefrontRevenue: summaryRow ? mapSummary(summaryRow).revenue : null,
    };
  };

  const periods = {
    current: withStorefront(keepNewsletter(current, range), 0)!,
    mom: mom ? withStorefront(keepNewsletter(mom, range.previous), 1) : null,
    yoy: yoy ? withStorefront(keepNewsletter(yoy, yoyWindow), 2) : null,
    six: six ? withStorefront(keepNewsletter(six, sixWindow), 3) : null,
    sixPrevious: sixPrevious ? withStorefront(keepNewsletter(sixPrevious, sixPreviousWindow), 4) : null,
  };

  return {
    month,
    label: range.label,
    inProgress: range.currentKey !== null,
    generatedAt: ctx.renderedAt,
    timezone: ctx.tz,
    compare: {
      mom: range.compareLabel,
      yoy: range.currentKey !== null ? `same days of ${monthLabel(yoyWindow.from)}` : monthLabel(yoyWindow.from),
      // The last month INSIDE the earlier window, not the exclusive end: Sep 2025
      // to Feb 2026 reads "to February 2026", not "to March".
      six: `the 6 months to ${monthLabel(step(fromKey(sixPreviousWindow.to), "month", -1))}`,
      sixLabel: `6 months to ${range.label}`,
    },
    periods,
    trend: trend.map((point, i) => ({
      key: point.key.slice(0, 7),
      label: bucketLabel(point.key, "month"),
      revenue: point.value,
      orders: trendOrders[i].value,
    })),
    platforms: foldPlatforms(channelRows).map((p: PlatformSplit) => ({ label: p.label, revenue: p.revenue, orders: p.orders })),
    products: productRows
      .map((row) => mapProduct(row))
      .slice(0, REPORT_PRODUCTS)
      .map((p) => ({
        title: p.title,
        revenue: p.revenue,
        orders: p.orders,
        units: p.units,
        // Absent last month means it sold nothing then — unless last month is
        // outside the order history, where nothing is known.
        previousRevenue: previousProductRows ? previousRevenue.get(p.productId) ?? 0 : null,
      })),
    promotions,
    collections: collectionRows.map((row) => mapReportCollection(row, previousCollectionRows)),
    // The denominator a collection's share is taken of: every paid product line
    // in the month, not the collections summed — they overlap.
    productRevenue: productRows.reduce((sum, row) => sum + count(row.revenue), 0),
    funnel: storefront.available ? storefront.funnel : [],
    channels: storefront.available ? storefront.channels : [],
    channelsBlockedReason: storefront.blockedReason,
    inventory: {
      items: inventory.items.map((i) => ({
        title: i.title,
        stock: i.stock,
        unitsOut: i.unitsOut,
        coverDays: i.coverDays,
        status: i.status,
      })),
      windowDays: inventory.windowDays,
      syncedAt: inventory.syncedAt,
    },
    carriers: carrierRows.map((row) => ({
      carrier: String(row.carrier ?? "Unknown"),
      shipments: count(row.shipments),
      p50Hours: num(row.p50_hours),
      over72h: count(row.over_72h),
    })),
    signals: signalsFor(
      range.compareLabel,
      { current: mapSummary(current.summaryRow), previous: mom ? mapSummary(mom.summaryRow) : null },
      { current: mapFigures(current.figuresRow), previous: mom ? mapFigures(mom.figuresRow) : null },
      inventory
    ),
  };
}

export type SalesReportData = Awaited<ReturnType<typeof buildSalesReport>>;

type Period = Awaited<ReturnType<typeof readPeriod>>;

/**
 * One window's figures: the orders summary, the basket, the customer split
 * (Shopify customers only — marketplaces mint one per order) and the
 * newsletter's movement.
 */
async function readPeriod(ctx: InsightsContext, window: Window) {
  const [summaryRow, figuresRow, mixRow, newsletterRow] = await Promise.all([
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, window)),
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SALES_OVERVIEW, orderArgs(ctx, window)),
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_CUSTOMER_MIX, {
      ...orderArgs(ctx, window),
      p_channels: null,
      p_not_channels: [...ALL_MARKETPLACE_HANDLES],
    }),
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_MARKETING_SUMMARY, rangeArgs(ctx, window)),
  ]);
  const summary = mapSummary(summaryRow ?? {});
  const figures = mapFigures(figuresRow ?? {});
  const customers = {
    newCustomers: count(mixRow?.new_customers),
    returningCustomers: count(mixRow?.returning_customers),
    newCustomerOrders: count(mixRow?.new_customer_orders),
    returningCustomerOrders: count(mixRow?.returning_customer_orders),
  };
  return {
    summaryRow: summaryRow ?? {},
    figuresRow: figuresRow ?? {},
    unsubscribesFrom: (newsletterRow?.unsubscribes_from as string | null) ?? null,
    revenue: summary.revenue,
    grossRevenue: summary.grossRevenue,
    paidOrders: figures.paidOrders,
    units: figures.units,
    discounts: figures.discounts,
    discountedOrders: figures.discountedOrders,
    discountedRevenue: figures.discountedRevenue,
    fullPriceRevenue: figures.fullPriceRevenue,
    measured: summary.measured,
    over72h: summary.over72h,
    p50Hours: summary.p50Hours,
    refundedOrders: summary.refundedOrders,
    refundedAmount: summary.refundedAmount,
    cancelledOrders: summary.cancelledOrders,
    returnsOpened: summary.returnsOpened,
    customers: customers.newCustomers + customers.returningCustomers > 0 ? customers : null,
    newsletter: newsletterRow
      ? {
          subscribed: count(newsletterRow.subscribed),
          unsubscribed: count(newsletterRow.unsubscribed),
          subscribersNow: count(newsletterRow.subscribers_now),
        }
      : null,
  };
}

/** The period without the raw rows it was read from — what the renderer takes. */
function strip(period: Period) {
  const { summaryRow: _s, figuresRow: _f, unsubscribesFrom: _u, ...rest } = period;
  return rest;
}

/** The twelve months ending with the report's month, as a month-grain range. */
function twelveMonths(ctx: InsightsContext): InsightsRange {
  const first = step(fromKey(ctx.range.from), "month", -11);
  const lastDay = toKey(step(fromKey(ctx.range.to), "day", -1)).slice(0, 10);
  const range = resolveRange(
    { from: toKey(first).slice(0, 10), to: lastDay },
    { tz: ctx.tz, now: new Date(ctx.renderedAt) }
  ) as unknown as InsightsRange;
  // A twelve-month custom span always resolves to months; asserted so a change
  // to grainForSpan cannot quietly turn the report's trend into weeks.
  if (range.grain !== "month") throw new Error(`Report trend resolved to ${range.grain}, expected month.`);
  return range;
}
