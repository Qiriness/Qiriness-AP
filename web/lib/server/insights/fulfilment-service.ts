/**
 * The Fulfilment panel's reads.
 *
 * FULFILMENT IS MEASURABLE; DELIVERY IS NOT. Those are two different durations
 * and this service keeps them apart, because conflating them is what kept the
 * measurable half unbuilt. Fulfilment time is `processed_at` -> the first
 * `fulfillments[].created_at`, populated on 1,993 of 2,006 orders. Delivery
 * time needs `delivered_at`, which is set on exactly one order in the whole
 * table because no carrier feeds scan events back to Shopify for this store.
 *
 * So the panel reports the first and explicitly blocks the second. It does NOT
 * render delivery as zero — a zero on "parcels late" reads as "none are", which
 * is a claim nobody can currently make.
 *
 * Server-only; see ./shared.ts for why nothing here reduces rows.
 */

import { V } from "../../../../scripts/lib/tables.mjs";
import type {
  FulfilmentBucket,
  FulfilmentCarrier,
  FulfilmentMonth,
  FulfilmentPanel,
  FulfilmentSummary,
} from "../../types";
import { count, isCurrentMonth, num, readOne, readView } from "./shared";

export async function getFulfilmentPanel(shopId: string): Promise<FulfilmentPanel> {
  const [summaryRow, monthRows, carrierRows, bucketRows] = await Promise.all([
    readOne<Record<string, unknown>>(V.FULFILMENT_SUMMARY, shopId),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_MONTH, shopId, { order: "month.asc" }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_CARRIER, shopId, { order: "shipments.desc" }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_BUCKET, shopId, { order: "bucket_order.asc" }),
  ]);

  const summary = summaryRow ? mapSummary(summaryRow) : null;

  return {
    summary,
    byMonth: monthRows.map(mapMonth),
    byCarrier: carrierRows.map(mapCarrier),
    byBucket: bucketRows.map(mapBucket),
    // One order in two thousand carries a delivery timestamp, which is noise
    // rather than coverage. The threshold is deliberately not "> 0": a single
    // manually-closed fulfilment must not switch a whole section on.
    hasDeliveryData: hasUsableDeliveryData(summary),
  };
}

/**
 * Is there enough delivery data to compute anything?
 *
 * A tenth of orders is the floor — below that any median is describing a
 * handful of rows that happened to be marked by hand, and putting it on a tile
 * beside a figure drawn from two thousand orders implies a confidence that is
 * not there.
 */
export function hasUsableDeliveryData(summary: FulfilmentSummary | null): boolean {
  if (!summary || summary.orders === 0) return false;
  return summary.withDeliveryEvent / summary.orders >= 0.1;
}

function mapSummary(row: Record<string, unknown>): FulfilmentSummary {
  return {
    orders: count(row.orders),
    measured: count(row.measured),
    p50Hours: num(row.p50_hours),
    p90Hours: num(row.p90_hours),
    meanHours: num(row.mean_hours),
    over48h: count(row.over_48h),
    over72h: count(row.over_72h),
    shippedWithoutTracking: count(row.shipped_without_tracking),
    withDeliveryEvent: count(row.with_delivery_event),
    firstOrderAt: (row.first_order_at as string) ?? null,
    lastOrderAt: (row.last_order_at as string) ?? null,
  };
}

function mapMonth(row: Record<string, unknown>): FulfilmentMonth {
  const month = String(row.month);
  return {
    month,
    orders: count(row.orders),
    p50Hours: num(row.p50_hours),
    p90Hours: num(row.p90_hours),
    over72h: count(row.over_72h),
    measured: count(row.measured),
    // Marked here rather than in SQL: whether a month is partial depends on
    // when the page is read, which is not something a view can know.
    partial: isCurrentMonth(month),
  };
}

function mapCarrier(row: Record<string, unknown>): FulfilmentCarrier {
  return {
    carrier: String(row.carrier ?? "Unknown"),
    shipments: count(row.shipments),
    p50Hours: num(row.p50_hours),
    over72h: count(row.over_72h),
    withoutTracking: count(row.without_tracking),
  };
}

function mapBucket(row: Record<string, unknown>): FulfilmentBucket {
  const order = count(row.bucket_order);
  return {
    bucket: String(row.bucket),
    order,
    orders: count(row.orders),
    // Buckets 5 and 6 are 72-96h and >96h — the two past the three-day mark.
    late: order >= 5,
  };
}
