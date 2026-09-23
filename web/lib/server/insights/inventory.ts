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
  INVENTORY_WINDOW_DAYS,
  inventoryStatus,
} from "../../../../scripts/lib/sales-overview.mjs";
import type { InventoryException, InventoryExceptions, InventoryStatus } from "../../types";
import type { InsightsContext } from "./context";
import { callRpc, count, num } from "./shared";

export async function getInventoryExceptions(ctx: InsightsContext): Promise<InventoryExceptions> {
  const to = ctx.range.now;
  const from = toKey(new Date(fromKey(to).getTime() - INVENTORY_WINDOW_DAYS * 86_400_000));
  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_INVENTORY_EXCEPTIONS, {
    p_shop: ctx.shopId,
    p_from: from,
    p_to: to,
    p_tz: ctx.tz,
    p_max_cover_days: INVENTORY_MAX_COVER_DAYS,
  });

  const items: InventoryException[] = [];
  let syncedAt: string | null = null;
  for (const row of rows) {
    const stock = count(row.stock);
    const coverDays = num(row.cover_days);
    const status = inventoryStatus(stock, coverDays) as InventoryStatus | null;
    const synced = (row.synced_at as string | null) ?? null;
    if (synced && (!syncedAt || synced > syncedAt)) syncedAt = synced;
    if (!status) continue;
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
  return { items, windowDays: INVENTORY_WINDOW_DAYS, syncedAt };
}
