/**
 * A shop's VIP rule (`shops.vip_*`, set on Insights -> Customers), kept for a
 * few minutes per shop (./remembered.ts) and forgotten when the rule is saved.
 * Orders, Sales, Customers and the open orders each read it per request: 4% of
 * the dashboard's REST requests on 2026-10-27. The worker reads its own.
 *
 * Server-only.
 */

import { loadVipRule } from "../../../scripts/lib/vip-rule.mjs";
import { getSupabaseClient } from "./insights/shared";
import { remembered } from "./remembered";

export type VipRule = Awaited<ReturnType<typeof loadVipRule>>;

const byShop = remembered<VipRule>((shopId) => loadVipRule(getSupabaseClient(), shopId));

export function getVipRule(shopId: string): Promise<VipRule> {
  return byShop.read(shopId);
}

/** After the rule is saved or cleared. */
export function forgetVipRule(shopId: string): void {
  byShop.forget(shopId);
}
