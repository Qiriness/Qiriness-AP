/**
 * The Fulfilment panel's reads, over the range and platform in the URL.
 *
 * FULFILMENT IS MEASURABLE; DELIVERY IS NOT. Fulfilment time is `processed_at`
 * -> the first `fulfillments[].created_at`, populated on essentially every
 * order. Delivery needs `delivered_at`, which no carrier feeds back to Shopify
 * for this store — so the panel reports the first and explicitly blocks the
 * second, never rendering "parcels late" as a confident zero.
 *
 * AMAZON NO LONGER HAS ITS OWN SECTION: the platform filter does that job for
 * every marketplace at once, with the same component and the same 72-hour line,
 * so the comparison is the store view and the filtered view side by side.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import type { FulfilmentBucket, FulfilmentCarrier, FulfilmentPanel, OrdersSummary } from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getOpenOrders } from "./open-orders";
import { logDashboardAccess } from "../access-log";
import { getOrderSeries, getOrdersSummary, ordersCoverage } from "./orders";
import { toSeries } from "./series";
import { callRpc, count, num } from "./shared";

/** Every bucket the histogram draws, so an empty one is a visible zero rather than a missing bar. */
const BUCKETS = ["<12h", "12-24h", "24-48h", "48-72h", "72-96h", ">96h"];

export async function getFulfilmentPanel(ctx: InsightsContext): Promise<FulfilmentPanel> {
  const coverage = ordersCoverage(ctx);
  const [summary, seriesRows, bucketRows, carrierRows, open] = await Promise.all([
    getOrdersSummary(ctx),
    getOrderSeries(ctx),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_FULFILMENT_BUCKETS, orderArgs(ctx)),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_FULFILMENT_CARRIERS, orderArgs(ctx)),
    getOpenOrders(ctx),
  ]);

  // The waiting-orders list names customers and shows their addresses.
  if (open.orders.length) {
    await logDashboardAccess({
      shopId: ctx.shopId,
      action: "view",
      resourceType: "orders",
      purpose: "insights_open_orders",
      metadata: { panel: "fulfilment", orders: open.orders.length, platform: ctx.platform },
    });
  }

  return {
    summary,
    openOrders: open.orders,
    vipRuleSet: open.vipRuleSet,
    orders: toSeries(ctx.range, seriesRows, (row) => row?.orders ?? 0, coverage),
    // No orders in a bucket means no median, not a median of zero hours.
    medianHours: toSeries(ctx.range, seriesRows, (row) => row?.p50Hours ?? null, coverage),
    lateShare: toSeries(
      ctx.range,
      seriesRows,
      (row) => (row && row.measured > 0 ? (row.over72h / row.measured) * 100 : null),
      coverage
    ),
    buckets: mapBuckets(bucketRows),
    carriers: carrierRows.map(mapCarrier),
    hasDeliveryData: hasUsableDeliveryData(summary.current),
  };
}

/**
 * Is there enough delivery data to compute anything? A tenth of orders is the
 * floor — below that a median describes a handful of rows marked by hand.
 */
export function hasUsableDeliveryData(summary: OrdersSummary | null): boolean {
  if (!summary || summary.orders === 0) return false;
  return summary.withDeliveryEvent / summary.orders >= 0.1;
}

function mapBuckets(rows: Record<string, unknown>[]): FulfilmentBucket[] {
  const byLabel = new Map(rows.map((row) => [String(row.bucket), count(row.orders)]));
  return BUCKETS.map((bucket, i) => ({
    bucket,
    order: i + 1,
    orders: byLabel.get(bucket) ?? 0,
    // 72-96h and >96h: the two past the three-day mark.
    late: i >= 4,
  }));
}

function mapCarrier(row: Record<string, unknown>): FulfilmentCarrier {
  return {
    carrier: String(row.carrier ?? "Unknown"),
    shipments: count(row.shipments),
    p50Hours: num(row.p50_hours),
    over72h: count(row.over_72h),
    withoutTracking: count(row.without_tracking),
    ordersWithTicket: count(row.orders_with_ticket),
    tickets: count(row.tickets),
    // Placeholders, and `null` is the point: `count()` would turn a column
    // nothing writes into a confident "0 lost parcels".
    lost: null,
    damaged: null,
    late: null,
  };
}
