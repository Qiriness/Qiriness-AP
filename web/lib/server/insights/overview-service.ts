/**
 * The Overview panel: the month-to-month view management opens first —
 * headline figures, the trend, what moved revenue, gross sales down to net,
 * rule-based signals and where revenue came from.
 *
 * ALMOST NOTHING NEW IS MEASURED HERE. Every figure from our own database is
 * one the other panels already print (insights_orders_summary, _series,
 * _by_channel, _product_sales) or the basket read beside it
 * (insights_sales_overview); the judgements are in
 * scripts/lib/sales-overview.mjs, which the monthly report shares.
 *
 * SESSIONS AND CONVERSION COME FROM SHOPIFY, LIVE (./analytics.ts), and are the
 * one figure here not read from our database. REVENUE PER SESSION DIVIDES
 * STOREFRONT REVENUE BY STOREFRONT SESSIONS: the panel's headline revenue
 * includes Amazon and Yves Rocher, whose buyers never touched the storefront,
 * so dividing that by sessions would flatter every marketplace sale.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { lastCompleteMonth } from "../../../../scripts/lib/insights-range.mjs";
import { managementSignals } from "../../../../scripts/lib/sales-overview.mjs";
import type {
  Compared,
  InventoryExceptions,
  ManagementSignal,
  OrdersSummary,
  OverviewPanel,
  SalesOverviewFigures,
} from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getStorefrontAnalytics } from "./analytics";
import { getInventoryExceptions } from "./inventory";
import { getOrderSeries, getOrdersSummary, getSalesOverviewFigures, ordersCoverage } from "./orders";
import { foldPlatforms, mapProduct } from "./sales-service";
import { toSeries } from "./series";
import { callRpc } from "./shared";

/** How many products the sales-mix card names. */
const TOP_PRODUCTS = 5;

export async function getOverviewPanel(ctx: InsightsContext): Promise<OverviewPanel> {
  const coverage = ordersCoverage(ctx);
  const [summary, figures, seriesRows, channelRows, productRows, inventory, storefront, storefrontOrders] = await Promise.all([
    getOrdersSummary(ctx),
    getSalesOverviewFigures(ctx),
    getOrderSeries(ctx),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_BY_CHANNEL, {
      p_shop: ctx.shopId,
      p_from: ctx.range.from,
      p_to: ctx.range.to,
      p_tz: ctx.tz,
    }),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_SALES, orderArgs(ctx)),
    getInventoryExceptions(ctx),
    getStorefrontAnalytics(ctx),
    // Storefront revenue only, for revenue per session. Free when the reader is
    // already filtered to Shopify: it is the summary above.
    ctx.platform === "shopify" ? Promise.resolve(null) : getOrdersSummary(ctx, "shopify"),
  ]);

  const products = productRows.map((row) => mapProduct(row));
  const reportMonth =
    ctx.range.preset === "month" && ctx.range.query.month ? ctx.range.query.month : lastCompleteMonth({ tz: ctx.tz });

  const storefrontSales = storefrontOrders ?? summary;

  return {
    summary,
    storefront,
    storefrontRevenue: {
      current: storefrontSales.current.revenue,
      previous: storefrontSales.previous ? storefrontSales.previous.revenue : null,
    },
    figures,
    revenue: toSeries(ctx.range, seriesRows, (row) => row?.revenue ?? 0, coverage),
    orders: toSeries(ctx.range, seriesRows, (row) => row?.orders ?? 0, coverage),
    // A bucket with no order has no average, not an average of zero.
    aov: toSeries(ctx.range, seriesRows, (row) => (row && row.orders > 0 ? row.revenue / row.orders : null), coverage),
    platforms: foldPlatforms(channelRows),
    topProducts: products.slice(0, TOP_PRODUCTS),
    productRevenue: products.reduce((sum, p) => sum + p.revenue, 0),
    inventory,
    signals: signalsFor(ctx.range.compareLabel, summary, figures, inventory),
    // Only months that have ended: the report is a closed month's account.
    reportMonths: ctx.months.filter((m) => m.id <= lastCompleteMonth({ tz: ctx.tz })),
    reportMonth,
  };
}

/** The signal inputs, folded from the two reads they come from. */
export function signalsFor(
  compareLabel: string,
  summary: Compared<OrdersSummary>,
  figures: Compared<SalesOverviewFigures>,
  inventory: InventoryExceptions | null
): ManagementSignal[] {
  const fold = (s: OrdersSummary, f: SalesOverviewFigures) => ({
    revenue: s.revenue,
    paidOrders: f.paidOrders,
    grossRevenue: s.grossRevenue,
    discounts: f.discounts,
    measured: s.measured,
    over72h: s.over72h,
  });
  return managementSignals({
    compareLabel,
    current: fold(summary.current, figures.current),
    previous: summary.previous && figures.previous ? fold(summary.previous, figures.previous) : null,
    inventory: inventory ? inventory.items : null,
  }) as ManagementSignal[];
}
