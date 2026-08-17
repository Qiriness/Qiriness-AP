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
  FulfilmentChannelPanel,
  FulfilmentMonth,
  FulfilmentPanel,
  FulfilmentSummary,
} from "../../types";
import { count, isCurrentMonth, num, readOne, readView } from "./shared";

/**
 * The marketplace whose fulfilment is reported on its own, below the store's.
 *
 * Shopify's channel HANDLE, not the label: the label is a display string that
 * can be restyled ('Amazon', 'Amazon by CedCommerce') and matching on it would
 * turn a cosmetic change upstream into an empty panel. The handle is the key.
 *
 * Named here rather than in SQL because which channel deserves its own section
 * is a business judgement, and the views deliberately group by every channel so
 * a second one costs a constant and no migration.
 */
const AMAZON_CHANNEL = "amazon";

export async function getFulfilmentPanel(shopId: string): Promise<FulfilmentPanel> {
  const [summaryRow, monthRows, carrierRows, bucketRows, amazon, coverageRow] = await Promise.all([
    readOne<Record<string, unknown>>(V.FULFILMENT_SUMMARY, shopId),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_MONTH, shopId, { order: "month.asc" }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_CARRIER, shopId, { order: "shipments.desc" }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_BUCKET, shopId, { order: "bucket_order.asc" }),
    getChannelPanel(shopId, AMAZON_CHANNEL),
    readOne<Record<string, unknown>>(V.FULFILMENT_TICKET_COVERAGE, shopId),
  ]);

  const summary = summaryRow ? mapSummary(summaryRow) : null;

  return {
    summary,
    byMonth: monthRows.map(mapMonth),
    byCarrier: carrierRows.map(mapCarrier),
    byBucket: bucketRows.map(mapBucket),
    amazon,
    ticketCoverage: coverageRow
      ? {
          tickets: count(coverageRow.tickets),
          withOrderNumber: count(coverageRow.with_order_number),
        }
      : null,
    // One order in two thousand carries a delivery timestamp, which is noise
    // rather than coverage. The threshold is deliberately not "> 0": a single
    // manually-closed fulfilment must not switch a whole section on.
    hasDeliveryData: hasUsableDeliveryData(summary),
  };
}

/**
 * One channel's fulfilment, in the same shape as the store-wide panel.
 *
 * Returns null when the channel has no orders at all, which is the difference
 * between "this store does not sell there" — render nothing — and "it sells
 * there and ships slowly", which is the whole point of the section. A channel
 * with orders but no measurable durations still returns a panel, so the reader
 * sees the coverage caveat instead of an absence they would read as absence of
 * a problem.
 *
 * Carriers are deliberately not cut by channel: a marketplace order still ships
 * on the same carriers as the rest, and the store-wide carrier table already
 * answers that question without a denominator small enough to mislead.
 */
async function getChannelPanel(
  shopId: string,
  channel: string
): Promise<FulfilmentChannelPanel | null> {
  const filters = { channel };
  const [summaryRows, monthRows, bucketRows] = await Promise.all([
    readView<Record<string, unknown>>(V.FULFILMENT_SUMMARY_BY_CHANNEL, shopId, {
      filters,
      limit: 1,
    }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_CHANNEL_MONTH, shopId, {
      filters,
      order: "month.asc",
    }),
    readView<Record<string, unknown>>(V.FULFILMENT_BY_CHANNEL_BUCKET, shopId, {
      filters,
      order: "bucket_order.asc",
    }),
  ]);

  const row = summaryRows[0];
  if (!row) return null;

  const summary = mapSummary(row);
  if (summary.orders === 0) return null;

  return {
    channel,
    label: (row.channel_label as string) || channel,
    summary,
    byMonth: monthRows.map(mapMonth),
    byBucket: bucketRows.map(mapBucket),
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
    // `num`, not `count`. These four columns are newer than the deployed view,
    // and a database that has not had 06_analytics.sql re-applied returns no key
    // at all — which `count()` would turn into "0 orders were ever refunded",
    // a claim, from a column that does not exist. Null instead, and the tile
    // renders blocked until the view catches up.
    refundedOrders: num(row.refunded_orders),
    fullyRefundedOrders: num(row.fully_refunded_orders),
    returnsOpened: num(row.returns_opened),
    refundedAmount: num(row.refunded_amount),
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
    ordersWithTicket: count(row.orders_with_ticket),
    tickets: count(row.tickets),
    // Placeholders, and `null` is the whole point — `count()` would turn a
    // column nothing writes into a confident "0 lost parcels". When a source
    // exists these become three more reads off the carrier view; until then the
    // table renders them as em dashes with the reason attached.
    lost: null,
    damaged: null,
    late: null,
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
