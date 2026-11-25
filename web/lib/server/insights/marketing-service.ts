/**
 * The Marketing & funnel panel: two tabs over one range, chosen by `?tab=`.
 *
 *  - Marketing Performance (default): the executive figures, provider against
 *    Shopify attribution per channel, paid highlights, Klaviyo and the
 *    newsletter. ./marketing-performance-service.ts
 *  - Funnel & Website (`?tab=funnel`): the session funnel with its filters,
 *    landing pages, collections, products, devices, checkout and the
 *    optimisation list. ./website-funnel-service.ts
 *
 * Only the open tab is read: each costs ShopifyQL points, and the other tab
 * is one click (one render) away. Promotions and discounting moved to Sales
 * (./promotions-service.ts).
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { KLAVIYO_RPC } from "../../../../scripts/lib/tables.mjs";
import { readKlaviyoConnection } from "../../../../scripts/lib/klaviyo-sync.mjs";
import { summariseKlaviyoMessages } from "../../../../scripts/lib/klaviyo-reports.mjs";
import { parseAttributionModel } from "../../../../scripts/lib/storefront-marketing.mjs";
import type { AttributionModel, KlaviyoSection, MarketingFunnelPanel, MarketingTab } from "../../marketing-types";
import type { KlaviyoMessageRow } from "../../types";
import { rangeArgs, type InsightsContext, type SearchParams } from "./context";
import { getNewsletterActivity } from "./customer-activity-service";
import { readMarketingPerformance } from "./marketing-performance-service";
import { readWebsitePerformance } from "./website-funnel-service";
import { callRpc, getSupabaseClient } from "./shared";

export interface MarketingParams {
  tab: MarketingTab;
  model: AttributionModel;
  country: string | null;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseMarketingParams(searchParams: SearchParams): MarketingParams {
  return {
    tab: first(searchParams.tab) === "funnel" ? "funnel" : "marketing",
    model: parseAttributionModel(first(searchParams.attr)) as AttributionModel,
    country: first(searchParams.country)?.trim() || null,
  };
}

export async function getMarketingPanel(ctx: InsightsContext, params: MarketingParams): Promise<MarketingFunnelPanel> {
  if (params.tab === "funnel") {
    return { tab: "funnel", performance: readWebsitePerformance(ctx, params.country) };
  }
  const [klaviyo, newsletter] = await Promise.all([getKlaviyoSection(ctx), getNewsletterActivity(ctx)]);
  const own = klaviyo.blockedReason || !klaviyo.summary ? null : { revenue: klaviyo.summary.revenue, conversions: klaviyo.conversions ?? 0 };
  return {
    tab: "marketing",
    model: params.model,
    // Not awaited: the view streams it in while the database figures render.
    performance: readMarketingPerformance(ctx, params.model, own, klaviyo.lastSyncAt, klaviyo.blockedReason),
    klaviyo,
    newsletter,
  };
}

function klaviyoBlocked(blockedReason: string, lastSyncAt: string | null = null): KlaviyoSection {
  return { blockedReason, lastSyncAt, summary: null, rows: [], hiddenWithoutClicks: 0, hiddenTooSmall: 0, byKind: null, conversions: null };
}

/**
 * Flows and campaigns in the range. Klaviyo credits its messages with Shopify
 * online-store orders only, so on a marketplace platform there is nothing of
 * Klaviyo's to show. A failed read blocks this card alone, never the panel.
 */
async function getKlaviyoSection(ctx: InsightsContext): Promise<KlaviyoSection> {
  if (ctx.marketplaces.isMarketplace(ctx.platform)) {
    return klaviyoBlocked("insights.marketing.klaviyoMarketplace");
  }
  try {
    const connection = await readKlaviyoConnection(getSupabaseClient(), ctx.shopId);
    if (!connection) return klaviyoBlocked("insights.marketing.klaviyoNotConnected");
    const lastSyncAt: string | null = connection.last_sync_at ?? null;
    if (!lastSyncAt) return klaviyoBlocked("insights.marketing.klaviyoNoSync");

    const rows = await callRpc<Record<string, unknown>>(KLAVIYO_RPC.MESSAGES, rangeArgs(ctx));
    const { summary, byKind, rows: clicked, hiddenWithoutClicks, hiddenTooSmall } = summariseKlaviyoMessages(rows);
    // Dates leave here as YYYY-MM-DD on the SHOP's clock: a campaign sent at
    // 00:00 Paris is 22:00 UTC the day before, and the card slices the date.
    const local = (iso: string | null) => (iso ? shopDate(iso, ctx.tz) : null);
    return {
      blockedReason: null,
      lastSyncAt: local(lastSyncAt),
      summary,
      rows: clicked.map((row: KlaviyoMessageRow) => ({ ...row, sentAt: local(row.sentAt) })),
      hiddenWithoutClicks,
      hiddenTooSmall,
      byKind,
      conversions: summary.conversions,
    };
  } catch (error) {
    return klaviyoBlocked(`Klaviyo figures could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** YYYY-MM-DD of an instant on the shop's clock. */
function shopDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
