/**
 * Everything a panel needs to know before it reads a figure: which shop, whose
 * clock, which range, which platform, and how current each source is.
 *
 * Resolved once per request from the URL, so a panel is a pure function of its
 * address — linkable, bookmarkable, and identical for two people reading it.
 *
 * Server-only.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";
import {
  isValidTimeZone,
  monthOptions,
  resolveRange,
} from "../../../../scripts/lib/insights-range.mjs";
import { getMarketplaces, type Marketplaces } from "../marketplaces";
import { describeFreshness } from "../../../../scripts/lib/insights-freshness.mjs";
import type { Freshness, FreshnessItem, InsightsRange, PlatformId } from "../../types";
import { getShop } from "../shop";
import { callRpcOne } from "./shared";

export interface InsightsContext {
  shopId: string;
  tz: string;
  /** True when the shop has no timezone yet and days are cut in UTC. */
  tzFallback: boolean;
  range: InsightsRange;
  platform: PlatformId;
  /** The shop's marketplaces (`sales_channels`): the platform filter's choices and their handles. */
  marketplaces: Marketplaces;
  freshness: Freshness;
  /** When this render read the database — what "Updated" on the page means. */
  renderedAt: string;
  /** The calendar months a reader can pick, newest first: first order month to now. */
  months: { id: string; label: string }[];
}

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Just the freshness pills, for a page outside Insights (Tickets). The same
 * RPC and the same `describeFreshness` as the panels, so the two agree.
 * Never throws: a page must not fail because this line could not be read.
 */
export async function readFreshnessItems(shopId: string, now: Date = new Date()): Promise<FreshnessItem[]> {
  try {
    const row = await callRpcOne<Record<string, string | null>>(RPC.INSIGHTS_FRESHNESS, { p_shop: shopId });
    return describeFreshness(row, now) as FreshnessItem[];
  } catch (error) {
    console.warn("freshness unreadable", (error as Error).message);
    return [];
  }
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function resolveInsightsContext(searchParams: SearchParams = {}): Promise<InsightsContext> {
  const shop = await getShop();
  if (!shop) {
    const config = loadConfig(process.env as Record<string, string | undefined>);
    throw new Error(`No shop record found for ${config.shopDomain}. Run a Shopify sync first.`);
  }

  const tzFallback = !isValidTimeZone(shop.ianaTimezone);
  const tz = tzFallback ? "UTC" : (shop.ianaTimezone as string);
  const now = new Date();

  // Freshness first: "All time" starts at the first synced order, which only
  // this row knows. It needs nothing from the range, so the order costs nothing.
  const [freshnessRow, marketplaces] = await Promise.all([
    callRpcOne<Record<string, string | null>>(RPC.INSIGHTS_FRESHNESS, { p_shop: shop.id }),
    getMarketplaces(),
  ]);

  const range = resolveRange(
    {
      range: first(searchParams.range),
      from: first(searchParams.from),
      to: first(searchParams.to),
      month: first(searchParams.month),
    },
    { tz, now, earliest: freshnessRow?.first_order_at ?? null }
  ) as unknown as InsightsRange;

  return {
    shopId: shop.id,
    tz,
    tzFallback,
    range,
    platform: marketplaces.parsePlatform(first(searchParams.platform)) as PlatformId,
    marketplaces,
    freshness: {
      items: describeFreshness(freshnessRow, now) as FreshnessItem[],
      ordersFrom: freshnessRow?.first_order_at ?? null,
      ordersThrough: freshnessRow?.orders_synced_at ?? null,
      mailFrom: freshnessRow?.first_mail_at ?? null,
      mailThrough: freshnessRow?.mail_synced_through ?? null,
      topicMapBuiltAt: freshnessRow?.topic_map_built_at ?? null,
    },
    renderedAt: now.toISOString(),
    months: monthOptions({ tz, now, earliest: freshnessRow?.first_order_at ?? null }),
  };
}

/** The range arguments every ranged function takes. */
export function rangeArgs(ctx: InsightsContext, window: { from: string; to: string } = ctx.range) {
  return { p_shop: ctx.shopId, p_from: window.from, p_to: window.to, p_tz: ctx.tz };
}

/** The range arguments plus the platform's channel filter, for the order functions. */
export function orderArgs(
  ctx: InsightsContext,
  window: { from: string; to: string } = ctx.range,
  platform: PlatformId = ctx.platform
) {
  const { channels, notChannels } = ctx.marketplaces.channelFilter(platform);
  return { ...rangeArgs(ctx, window), p_channels: channels, p_not_channels: notChannels };
}
