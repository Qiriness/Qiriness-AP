/**
 * The ranged half of the Customers panel: how often people ordered, how the
 * newsletter moved, and how many first-time buyers it had captured.
 *
 * PEOPLE, SO NEVER MARKETPLACES. Amazon and Yves Rocher mint one customer per
 * order; counted here they would fill the "ordered once" column and read as
 * first-time buyers who never subscribed. Every read passes the Shopify filter,
 * whatever the platform control says — which is why it is disabled here.
 *
 * NEWSLETTER FIGURES ARE FLOORS. `customers` holds each person's current consent
 * and when it last changed, not a history (see insights_marketing_series), so
 * the chart's edge is the newest consent change and the churn denominator is an
 * estimate. The view labels both.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import {
  bucketCoverage,
  bucketLabel,
  bucketTitle,
  fillSeries,
  windowCovered,
} from "../../../../scripts/lib/insights-range.mjs";
import type { BucketState, CapturePoint, CustomerActivity, MarketingSummary } from "../../types";
import { orderArgs, rangeArgs, type InsightsContext } from "./context";
import { foldOrdersPerCustomer } from "./order-frequency";
import { ordersCoverage } from "./orders";
import { toSeries } from "./series";
import { callRpc, callRpcOne, count } from "./shared";

/**
 * A consent change this close to a customer's first order is a checkout opt-in
 * rather than a subscriber who later bought. A judgement, so it lives here and
 * is passed to SQL.
 */
const CHECKOUT_MINUTES = 60;

export async function getCustomerActivity(ctx: InsightsContext): Promise<CustomerActivity> {
  const people = orderArgs(ctx, ctx.range, "shopify");
  const [perCustomerRows, marketingNow, marketingBefore, marketingRows, captureRows] = await Promise.all([
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_PER_CUSTOMER, people),
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_MARKETING_SUMMARY, rangeArgs(ctx)),
    callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_MARKETING_SUMMARY, rangeArgs(ctx, ctx.range.previous)),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_MARKETING_SERIES, { ...rangeArgs(ctx), p_grain: ctx.range.grain }),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_CAPTURE_SERIES, {
      ...rangeArgs(ctx),
      p_grain: ctx.range.grain,
      p_checkout_minutes: CHECKOUT_MINUTES,
      p_channels: people.p_channels,
      p_not_channels: people.p_not_channels,
    }),
  ]);

  // The snapshot's two edges: nothing after the newest consent change is known,
  // and before the earliest recorded unsubscribe only subscribes can appear.
  const unsubscribesFrom = (marketingNow?.unsubscribes_from as string | null) ?? null;
  const consentCoverage = { from: unsubscribesFrom, through: (marketingNow?.consent_through as string | null) ?? null };
  const covered = windowCovered(ctx.range, consentCoverage, ctx.tz);
  const previousCovered = windowCovered(ctx.range.previous, consentCoverage, ctx.tz);
  const marketingSeries = marketingRows.map((row) => ({ ...row, bucket: String(row.bucket) }) as Record<string, unknown> & { bucket: string });

  return {
    ordersPerCustomer: foldOrdersPerCustomer(perCustomerRows),
    marketing: {
      current: mapMarketing(marketingNow, days(ctx.range.from, ctx.range.to, ctx.range.now)),
      previous: marketingBefore && previousCovered
        ? mapMarketing(marketingBefore, days(ctx.range.previous.from, ctx.range.previous.to, ctx.range.previous.to))
        : null,
      subscribed: toSeries(ctx.range, marketingSeries, (row) => (row ? count(row.subscribed) : 0), consentCoverage),
      unsubscribed: toSeries(ctx.range, marketingSeries, (row) => (row ? count(row.unsubscribed) : 0), consentCoverage),
      unsubscribesFrom,
      covered,
    },
    capture: capturePoints(ctx, captureRows),
  };
}

function mapMarketing(row: Record<string, unknown> | null, rangeDays: number): MarketingSummary {
  return {
    subscribed: count(row?.subscribed),
    unsubscribed: count(row?.unsubscribed),
    listAtStart: count(row?.list_at_start),
    subscribersNow: count(row?.subscribers_now),
    days: rangeDays,
  };
}

/** Days from `from` to the earlier of `to` and `now` — the elapsed span a rate divides by. */
function days(from: string, to: string, now: string): number {
  const start = Date.parse(`${from}Z`);
  const end = Math.min(Date.parse(`${to}Z`), Date.parse(`${now}Z`));
  return Math.max(1 / 24, (end - start) / 86_400_000);
}

function capturePoints(ctx: InsightsContext, rows: Record<string, unknown>[]): CapturePoint[] {
  const states = bucketCoverage(ctx.range, ordersCoverage(ctx)) as BucketState[];
  const filled = fillSeries(ctx.range.keys, rows, (row: Record<string, unknown>) => String(row.bucket), () => null) as (
    | Record<string, unknown>
    | null
  )[];
  return ctx.range.keys.map((key, i) => ({
    key,
    label: bucketLabel(key, ctx.range.grain),
    title: bucketTitle(key, ctx.range.grain),
    state: states[i],
    firstOrders: count(filled[i]?.first_orders),
    subscribedBefore: count(filled[i]?.subscribed_before),
    subscribedAtCheckout: count(filled[i]?.subscribed_at_checkout),
  }));
}
