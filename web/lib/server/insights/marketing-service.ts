/**
 * The Marketing & funnel panel.
 *
 * WHAT IS MEASURED: sessions, conversion and traffic by source, live from
 * Shopify Analytics (./analytics.ts); purchases; the promotions every order
 * recorded (insights_promotions); the basket split with and without one
 * (insights_sales_overview); and the newsletter list (the Customers panel's
 * reads, Shopify customers only).
 *
 * WHAT IS NOT, AND WHY IT IS NOT A PERMISSION: the funnel between a session and
 * a purchase — product views, add to cart, reached checkout. ShopifyQL has no
 * cart or checkout dataset (measured 2026-09-23; see DECISIONS.md § Insights),
 * so those steps stay blocked with the reason rather than drawn as zeros.
 * Klaviyo, the ad platforms and social are unchosen integrations; the revenue
 * each channel is credited with comes from Shopify's own attribution instead.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC, T } from "../../../../scripts/lib/tables.mjs";
import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { ALL_MARKETPLACE_HANDLES, isMarketplacePlatform } from "../../../../scripts/lib/insights-range.mjs";
import type { MarketingPanel, PromotionRow } from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getStorefrontAnalytics } from "./analytics";
import { getNewsletterActivity } from "./customer-activity-service";
import { getOrdersSummary, getSalesOverviewFigures } from "./orders";
import { callRpc, count, getSupabaseClient } from "./shared";

/** How many promotions the table lists before full price. */
const PROMOTIONS = 12;

export async function getMarketingPanel(ctx: InsightsContext): Promise<MarketingPanel> {
  const [summary, figures, promotions, newsletter, storefront, titles] = await Promise.all([
    getOrdersSummary(ctx),
    getSalesOverviewFigures(ctx),
    getPromotions(ctx),
    getNewsletterActivity(ctx),
    getStorefrontAnalytics(ctx),
    productTitlesByHandle(ctx.shopId),
  ]);

  // The traffic rows name a URL; the catalogue names the product. Matching on
  // handle is exact — every one of this shop's 116 products has one — and a
  // page whose handle no longer exists keeps its path rather than going blank.
  const productPages = storefront.productPages.map((page) => ({
    ...page,
    title: page.handle ? titles.get(page.handle) ?? null : null,
  }));

  return { summary, storefront: { ...storefront, productPages }, figures, promotions, newsletter };
}

/**
 * Handle -> title for the whole catalogue: 116 rows on this shop, two columns,
 * one read. Small enough to take whole, unlike anything customer- or
 * order-sized (see ./shared.ts on why nothing here pages).
 */
async function productTitlesByHandle(shopId: string): Promise<Map<string, string>> {
  const rows = (await supabaseSelect(getSupabaseClient(), T.PRODUCTS, { shop_id: shopId }, "handle,title", {
    limit: 500,
  })) as { handle: string | null; title: string | null }[];
  const titles = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.handle && row.title) titles.set(row.handle, row.title);
  }
  return titles;
}

/**
 * Promotions in the range, full price last. On a marketplace the new-customer
 * column is null: every Amazon or Yves Rocher buyer is a new record per order.
 */
export async function getPromotions(ctx: InsightsContext, window = ctx.range): Promise<PromotionRow[]> {
  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_PROMOTIONS, {
    ...orderArgs(ctx, window),
    p_people_not_channels: [...ALL_MARKETPLACE_HANDLES],
    p_limit: PROMOTIONS,
  });
  const marketplace = isMarketplacePlatform(ctx.platform);
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
