/**
 * Stock at risk: the Fulfilment card, the Overview's stock signal and the
 * report's inventory table all read it here.
 *
 * NOW, NOT RANGED. Stock is what the last product sync saw, so a range cannot
 * cut it — like the orders waiting to ship. The rate a product's cover is read
 * at is the last INVENTORY_WINDOW_DAYS on the shop clock, whatever range the
 * reader picked, so "3 days of cover" means the same thing on every panel.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { fromKey, toKey } from "../../../../scripts/lib/insights-range.mjs";
import {
  INVENTORY_MAX_COVER_DAYS,
  INVENTORY_MIN_STOCK_UNITS,
  INVENTORY_WINDOW_DAYS,
  inventoryStatus,
  isAlertStatus,
  rankInventoryByRisk,
} from "../../../../scripts/lib/sales-overview.mjs";
import type { InventoryException, InventoryExceptions, InventoryStatus } from "../../types";
import type { InsightsContext } from "./context";
import { callRpc, count, num } from "./shared";

export async function getInventoryExceptions(ctx: InsightsContext): Promise<InventoryExceptions> {
  const { items, syncedAt } = await readInventory(ctx, INVENTORY_MAX_COVER_DAYS, INVENTORY_MIN_STOCK_UNITS);
  // Most at risk first, on every panel and in the report (sales-overview.mjs).
  return {
    items: rankInventoryByRisk(items.filter((item) => item.status !== "ok")),
    windowDays: INVENTORY_WINDOW_DAYS,
    minStockUnits: INVENTORY_MIN_STOCK_UNITS,
    syncedAt,
  };
}

/** Products past the out-of-stock and critical ones that the Fulfilment card adds. */
export const WATCHLIST_EXTRA = 10;

/**
 * The Fulfilment card (owner, 2026-10-27): EVERY product out of stock or
 * critical, then the next WATCHLIST_EXTRA most at risk, whether or not they are
 * exceptions — so the card always shows what is coming next. Reads every active
 * product with known stock (no thresholds); a shop has a few hundred at most.
 */
export async function getInventoryWatchlist(ctx: InsightsContext, extra = WATCHLIST_EXTRA): Promise<InventoryExceptions> {
  const { items, syncedAt } = await readInventory(ctx, 1_000_000_000, 2_147_483_647);
  const ranked = rankInventoryByRisk(items) as InventoryException[];
  const alerts = ranked.filter((item) => isAlertStatus(item.status));
  const next = ranked.filter((item) => !isAlertStatus(item.status)).slice(0, extra);
  return { items: [...alerts, ...next], windowDays: INVENTORY_WINDOW_DAYS, minStockUnits: INVENTORY_MIN_STOCK_UNITS, syncedAt };
}

async function readInventory(ctx: InsightsContext, maxCoverDays: number, maxStockUnits: number) {
  const to = ctx.range.now;
  const from = toKey(new Date(fromKey(to).getTime() - INVENTORY_WINDOW_DAYS * 86_400_000));
  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_INVENTORY_EXCEPTIONS, {
    p_shop: ctx.shopId,
    p_from: from,
    p_to: to,
    p_tz: ctx.tz,
    p_max_cover_days: maxCoverDays,
    p_max_stock_units: maxStockUnits,
  });

  const items: InventoryException[] = [];
  let syncedAt: string | null = null;
  for (const row of rows) {
    const stock = count(row.stock);
    const coverDays = num(row.cover_days);
    // `ok`: not an exception; only the Fulfilment watchlist keeps those.
    const status = ((inventoryStatus(stock, coverDays) as InventoryStatus | null) ?? "ok") as InventoryStatus;
    const synced = (row.synced_at as string | null) ?? null;
    if (synced && (!syncedAt || synced > syncedAt)) syncedAt = synced;
    items.push({
      productId: String(row.product_id),
      title: String(row.title ?? "Unknown product"),
      productType: (row.product_type as string | null) || null,
      stock,
      unitsOut: count(row.units_out),
      coverDays,
      status,
    });
  }
  return { items, syncedAt };
}
