/**
 * Promotions, discounts and gifts: what each promotion recorded on its orders,
 * and how much of the range was sold at full price.
 *
 * Read by the Sales panel (moved there from Marketing & funnel on 2026-11-25,
 * when Marketing became a channel and funnel tool) and by the monthly report.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import type { Compared, OrdersSummary, PromotionRow, SalesOverviewFigures } from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getSalesOverviewFigures } from "./orders";
import { callRpc, count } from "./shared";

/** How many promotions the table lists before full price. */
const PROMOTIONS = 12;

export interface PromotionsSection {
  figures: Compared<SalesOverviewFigures>;
  rows: PromotionRow[];
}

/**
 * Promotions in the range, full price last. On a marketplace the new-customer
 * column is null: every marketplace buyer is a new record per order.
 */
export async function getPromotions(ctx: InsightsContext, window = ctx.range): Promise<PromotionRow[]> {
  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_PROMOTIONS, {
    ...orderArgs(ctx, window),
    p_people_not_channels: [...ctx.marketplaces.handles],
    p_limit: PROMOTIONS,
  });
  const marketplace = ctx.marketplaces.isMarketplace(ctx.platform);
  const mapped = rows.map(
    (row): PromotionRow => ({
      name: (row.promotion as string | null) ?? null,
      kind: (row.kind as string | null) ?? null,
      target: (row.target as string | null) ?? null,
      orders: count(row.orders),
      revenue: count(row.revenue),
      discount: count(row.discount),
      newCustomerOrders: marketplace ? null : count(row.new_customer_orders),
    })
  );
  // SQL returns full price last already; kept explicit so a reorder there cannot move it.
  return [...mapped.filter((p) => p.name !== null), ...mapped.filter((p) => p.name === null)];
}

export async function getPromotionsSection(ctx: InsightsContext): Promise<PromotionsSection> {
  const [figures, rows] = await Promise.all([getSalesOverviewFigures(ctx), getPromotions(ctx)]);
  return { figures, rows };
}

/** Gross revenue a discount share is taken of: the summary's revenue plus the discounts given. */
export function grossOf(summary: OrdersSummary, figures: SalesOverviewFigures): number {
  return summary.grossRevenue + figures.discounts;
}
