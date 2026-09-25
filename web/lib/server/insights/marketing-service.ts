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
 * Klaviyo is read from the nightly sync's tables (klaviyo_flow_days,
 * klaviyo_campaigns) through insights_klaviyo_messages. The ad platforms and
 * social are unchosen integrations; the revenue each channel is credited with
 * comes from Shopify's own attribution instead.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { KLAVIYO_RPC, RPC, T } from "../../../../scripts/lib/tables.mjs";
import { readKlaviyoConnection } from "../../../../scripts/lib/klaviyo-sync.mjs";
import { summariseKlaviyoMessages } from "../../../../scripts/lib/klaviyo-reports.mjs";
import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { ALL_MARKETPLACE_HANDLES, isMarketplacePlatform } from "../../../../scripts/lib/insights-range.mjs";
import type { KlaviyoMessageRow, KlaviyoPerformance, MarketingPanel, PromotionRow } from "../../types";
import { orderArgs, rangeArgs, type InsightsContext } from "./context";
import { liveChannels, liveFunnel, liveLandingTypes, liveProductPages, liveTotals } from "./analytics";
import { getNewsletterActivity } from "./customer-activity-service";
import { getOrdersSummary, getSalesOverviewFigures } from "./orders";
import { callRpc, count, getSupabaseClient } from "./shared";

/** How many promotions the table lists before full price. */
const PROMOTIONS = 12;

export async function getMarketingPanel(ctx: InsightsContext): Promise<MarketingPanel> {
  // Shopify's cards, started first and awaited card by card by the view. The
  // panel shows no comparison for traffic, so the earlier period is not asked.
  const totals = liveTotals(ctx, { compare: false });
  const landingTypes = liveLandingTypes(ctx);
  const titles = productTitlesByHandle(ctx.shopId).catch(() => new Map<string, string>());
  const live = {
    totals,
    funnel: liveFunnel(totals, landingTypes),
    channels: liveChannels(ctx),
    landingTypes,
    // The traffic rows name a URL; the catalogue names the product. Matching on
    // handle is exact — every one of this shop's 116 products has one — and a
    // page whose handle no longer exists keeps its path rather than going blank.
    productPages: Promise.all([liveProductPages(ctx), titles]).then(([pages, byHandle]) => ({
      ...pages,
      value: pages.value.map((page) => ({ ...page, title: page.handle ? byHandle.get(page.handle) ?? null : null })),
    })),
  };

  const [summary, figures, promotions, newsletter, klaviyo] = await Promise.all([
    getOrdersSummary(ctx),
    getSalesOverviewFigures(ctx),
    getPromotions(ctx),
    getNewsletterActivity(ctx),
    getKlaviyoPerformance(ctx),
  ]);

  return { summary, live, figures, promotions, newsletter, klaviyo };
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

function klaviyoBlocked(blockedReason: string, lastSyncAt: string | null = null): KlaviyoPerformance {
  return { blockedReason, lastSyncAt, summary: null, rows: [], hiddenWithoutClicks: 0 };
}

/**
 * Flows and campaigns in the range. Klaviyo credits its messages with Shopify
 * online-store orders only, so on a marketplace platform there is nothing of
 * Klaviyo's to show. A failed read blocks this card alone, never the panel.
 */
async function getKlaviyoPerformance(ctx: InsightsContext): Promise<KlaviyoPerformance> {
  if (isMarketplacePlatform(ctx.platform)) {
    return klaviyoBlocked("Klaviyo credits online-store orders only — not this marketplace.");
  }
  try {
    const connection = await readKlaviyoConnection(getSupabaseClient(), ctx.shopId);
    if (!connection) return klaviyoBlocked("Klaviyo is not connected — add the private key in Settings → Integrations.");
    const lastSyncAt: string | null = connection.last_sync_at ?? null;
    if (!lastSyncAt) return klaviyoBlocked("Klaviyo is connected; flows and campaigns arrive with the next nightly sync.");

    const rows = await callRpc<Record<string, unknown>>(KLAVIYO_RPC.MESSAGES, rangeArgs(ctx));
    const { summary, rows: clicked, hiddenWithoutClicks } = summariseKlaviyoMessages(rows);
    // Dates leave here as YYYY-MM-DD on the SHOP's clock: a campaign sent at
    // 00:00 Paris is 22:00 UTC the day before, and the card slices the date.
    const local = (iso: string | null) => (iso ? shopDate(iso, ctx.tz) : null);
    return {
      blockedReason: null,
      lastSyncAt: local(lastSyncAt),
      summary,
      rows: clicked.map((row: KlaviyoMessageRow) => ({ ...row, sentAt: local(row.sentAt) })),
      hiddenWithoutClicks,
    };
  } catch (error) {
    return klaviyoBlocked(`Klaviyo figures could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** YYYY-MM-DD of an instant on the shop's clock. */
function shopDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
