/**
 * Orders still waiting to ship, with who is waiting — the list under the
 * Fulfilment panel's first row.
 *
 * NOW, NOT RANGED. An order placed a fortnight ago and still unshipped is the
 * one that matters, so the range does not cut this list; the platform filter
 * does. Current as of the last order sync, which the panel's freshness strip
 * states.
 *
 * VIP COMES FROM THE SHOP'S RULE through `open_orders()` -> `vip_customers()`,
 * never compared here.
 *
 * PERSONAL DATA: names and email addresses are read here and rendered on the
 * page, as the Customers call list does, so the card carries the same warning.
 * A marketplace buyer's record holds a placeholder address (example.com,
 * mail.codisto.com), so their email is withheld rather than shown as if real.
 *
 * Server-only.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";
import {
  ALL_MARKETPLACE_HANDLES,
  PLATFORMS,
  channelFilter,
  formatDay,
  isMarketplacePlatform,
  platformOfChannel,
  wallClock,
} from "../../../../scripts/lib/insights-range.mjs";
import { loadVipRule } from "../../../../scripts/lib/vip-rule.mjs";
import type { OpenOrder, PlatformId } from "../../types";
import type { InsightsContext } from "./context";
import { callRpc, count, getSupabaseClient } from "./shared";

/** Waiting this many whole days or more is late — the same three days the dispatch figures use. */
export const LATE_AFTER_DAYS = 3;

const DAY_MS = 86_400_000;

export async function getOpenOrders(ctx: InsightsContext): Promise<{ orders: OpenOrder[]; vipRuleSet: boolean }> {
  const supabase = getSupabaseClient();
  const rule = await loadVipRule(supabase, ctx.shopId);
  const { channels, notChannels } = channelFilter(ctx.platform);

  const rows = await callRpc<Record<string, unknown>>(RPC.OPEN_ORDERS, {
    p_shop: ctx.shopId,
    p_min_spend: rule?.minSpend ?? null,
    p_min_orders: rule?.minOrders ?? null,
    p_window_months: rule?.windowMonths ?? null,
    p_vip_not_channels: [...ALL_MARKETPLACE_HANDLES],
    p_channels: channels,
    p_not_channels: notChannels,
  });

  const now = Date.now();
  const adminBase = adminOrdersUrl();

  return {
    vipRuleSet: Boolean(rule),
    orders: rows.map((row) => {
      const placedAt = String(row.processed_at);
      const daysWaiting = Math.max(0, Math.floor((now - Date.parse(placedAt)) / DAY_MS));
      const platform = platformOfChannel(String(row.channel ?? "")) as PlatformId;
      const legacyId = (row.legacy_resource_id as string | null) ?? null;
      return {
        orderId: String(row.order_id),
        name: String(row.order_name ?? "—"),
        adminUrl: adminBase && legacyId ? `${adminBase}/${legacyId}` : null,
        placedAt,
        // The shop's day, not UTC's: 00:30 in Paris is the next day there.
        placedLabel: formatDay(wallClock(placedAt, ctx.tz)),
        daysWaiting,
        late: daysWaiting >= LATE_AFTER_DAYS,
        platform,
        platformLabel: PLATFORMS.find((p) => p.id === platform)?.label ?? platform,
        channelLabel: (row.channel_label as string | null) ?? null,
        status: String(row.fulfillment_status ?? ""),
        total: count(row.total_price),
        units: count(row.units),
        customerName: (row.customer_name as string | null) ?? null,
        email: isMarketplacePlatform(platform) ? null : ((row.customer_email as string | null) ?? null),
        isVip: row.is_vip === true,
      };
    }),
  };
}

/** `https://<shop>.myshopify.com/admin/orders` — Shopify redirects it to the current admin. */
function adminOrdersUrl(): string | null {
  try {
    const { shopDomain } = loadConfig(process.env as Record<string, string | undefined>);
    return shopDomain ? `https://${shopDomain}/admin/orders` : null;
  } catch {
    return null;
  }
}
