/**
 * The order reads the Sales and Fulfilment panels share: the one-row summary
 * for a range (and the same figures one period earlier), and the series.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import type { Compared, OrdersSummary, PlatformId, SalesOverviewFigures } from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { previousCovered, type Coverage } from "./series";
import { callRpc, callRpcOne, count, num } from "./shared";

export interface OrderSeriesRow {
  bucket: string;
  orders: number;
  revenue: number;
  measured: number;
  over72h: number;
  p50Hours: number | null;
}

/** Orders exist from the first synced order to the last sync. */
export function ordersCoverage(ctx: InsightsContext): Coverage {
  return { from: ctx.freshness.ordersFrom, through: ctx.freshness.ordersThrough };
}

/**
 * This range's summary beside the previous one.
 *
 * The previous is null when it starts before the first synced order: "the 30
 * days before our history begins" is not a quiet month, and a +400% chip
 * against it would be the loudest false thing on the page.
 */
export async function getOrdersSummary(
  ctx: InsightsContext,
  platform: PlatformId = ctx.platform
): Promise<Compared<OrdersSummary>> {
  const comparable = previousCovered(ctx.range, ordersCoverage(ctx));
  const [current, previous] = await Promise.all([
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, ctx.range, platform)),
    comparable
      ? callRpcOne<Record<string, unknown>>(
          RPC.INSIGHTS_ORDERS_SUMMARY,
          orderArgs(ctx, ctx.range.previous, platform)
        )
      : Promise.resolve(null),
  ]);
  return { current: mapSummary(current ?? {}), previous: previous ? mapSummary(previous) : null };
}

export async function getOrderSeries(ctx: InsightsContext): Promise<OrderSeriesRow[]> {
  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SERIES, {
    ...orderArgs(ctx),
    p_grain: ctx.range.grain,
  });
  return rows.map((row) => ({
    bucket: String(row.bucket),
    orders: count(row.orders),
    revenue: count(row.revenue),
    measured: count(row.measured),
    over72h: count(row.over_72h),
    p50Hours: num(row.p50_hours),
  }));
}

export function mapSummary(row: Record<string, unknown>): OrdersSummary {
  return {
    orders: count(row.orders),
    cancelledOrders: count(row.cancelled_orders),
    revenue: count(row.revenue),
    grossRevenue: count(row.gross_revenue),
    measured: count(row.measured),
    p50Hours: num(row.p50_hours),
    p90Hours: num(row.p90_hours),
    meanHours: num(row.mean_hours),
    over72h: count(row.over_72h),
    shippedWithoutTracking: count(row.shipped_without_tracking),
    withDeliveryEvent: count(row.with_delivery_event),
    refundedOrders: count(row.refunded_orders),
    fullyRefundedOrders: count(row.fully_refunded_orders),
    returnsOpened: count(row.returns_opened),
    refundedAmount: count(row.refunded_amount),
  };
}

/**
 * The basket beside the summary (insights_sales_overview): paid orders, paid
 * units, discounts, and revenue with and without a promotion — this range and
 * the previous one, withheld on the same coverage rule as the summary.
 */
export async function getSalesOverviewFigures(
  ctx: InsightsContext,
  platform: PlatformId = ctx.platform
): Promise<Compared<SalesOverviewFigures>> {
  const comparable = previousCovered(ctx.range, ordersCoverage(ctx));
  const [current, previous] = await Promise.all([
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SALES_OVERVIEW, orderArgs(ctx, ctx.range, platform)),
    comparable
      ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SALES_OVERVIEW, orderArgs(ctx, ctx.range.previous, platform))
      : Promise.resolve(null),
  ]);
  return { current: mapFigures(current ?? {}), previous: previous ? mapFigures(previous) : null };
}

export function mapFigures(row: Record<string, unknown>): SalesOverviewFigures {
  return {
    paidOrders: count(row.paid_orders),
    units: count(row.units),
    discounts: count(row.discounts),
    discountedOrders: count(row.discounted_orders),
    discountedRevenue: count(row.discounted_revenue),
    fullPriceRevenue: count(row.full_price_revenue),
  };
}
