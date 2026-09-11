/**
 * Who counts as a VIP: the shop's rule, read, validated and asked about.
 *
 * THE RULE IS DATA, ITS SHAPE IS CODE. Three numbers on `shops` — spend, orders,
 * window in months — set on the Customers panel. How they combine is written
 * once, in `vip_customers()` (06_analytics.sql): net spend in the window MORE
 * THAN the amount, AND more orders than the count. Every reader — the ticket
 * queue, the Customers panel, the agent's customer lookup — asks that function
 * through this module rather than comparing numbers itself, so a VIP on a ticket
 * is a VIP on the panel and in the case file.
 *
 * NO RULE, NO VIPS. Unset columns mean nobody has chosen the numbers, and the
 * answer is "nobody is a VIP", never a default somebody did not pick.
 *
 * REPLACES THE RFM RULE (CHAMPIONS + LOYAL), which the owner found did not
 * match who the business treats as a VIP. Shopify's segments are still shown,
 * as Shopify's — see customer-segments.mjs.
 */

import { ALL_MARKETPLACE_HANDLES } from './insights-range.mjs';
import { supabaseRpc, supabaseSelect, supabaseUpdateById } from './supabase-rest-client.mjs';
import { RPC, T } from './tables.mjs';

export const VIP_WINDOW_MONTHS = Object.freeze({ min: 1, max: 120 });

/** The rule on a shop row, or null when it has not been set. */
export function readVipRule(shop) {
  if (!shop) return null;
  const minSpend = toNumber(shop.vip_min_spend);
  const minOrders = toNumber(shop.vip_min_orders);
  const windowMonths = toNumber(shop.vip_window_months);
  if (minSpend === null || minOrders === null || windowMonths === null) return null;
  return { minSpend, minOrders, windowMonths };
}

/**
 * Check a rule someone typed. Returns the rule, or the first thing wrong with
 * it in words that can go straight under the form.
 */
export function validateVipRule(input) {
  const minSpend = toNumber(input?.minSpend);
  const minOrders = toNumber(input?.minOrders);
  const windowMonths = toNumber(input?.windowMonths);

  if (minSpend === null || minSpend < 0) return { ok: false, error: 'Spend must be a number of euros, 0 or more.' };
  if (minOrders === null || minOrders < 0 || !Number.isInteger(minOrders)) {
    return { ok: false, error: 'Orders must be a whole number, 0 or more.' };
  }
  if (
    windowMonths === null ||
    !Number.isInteger(windowMonths) ||
    windowMonths < VIP_WINDOW_MONTHS.min ||
    windowMonths > VIP_WINDOW_MONTHS.max
  ) {
    return { ok: false, error: `The window must be ${VIP_WINDOW_MONTHS.min} to ${VIP_WINDOW_MONTHS.max} whole months.` };
  }
  return { ok: true, rule: { minSpend: Math.round(minSpend * 100) / 100, minOrders, windowMonths } };
}

/** The rule in one sentence, as the form and every tooltip state it. */
export function describeVipRule(rule) {
  if (!rule) return 'No VIP rule is set';
  const spend = `€${rule.minSpend.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
  const window = rule.windowMonths === 1 ? 'the last month' : `the last ${rule.windowMonths} months`;
  return `More than ${spend} spent and more than ${rule.minOrders} ${rule.minOrders === 1 ? 'order' : 'orders'} in ${window}`;
}

/** The arguments every VIP function takes. Marketplaces mint a customer per order, so they never count. */
export function vipArgs(shopId, rule) {
  return {
    p_shop: shopId,
    p_min_spend: rule.minSpend,
    p_min_orders: rule.minOrders,
    p_window_months: rule.windowMonths,
    p_not_channels: [...ALL_MARKETPLACE_HANDLES]
  };
}

// --- reads ---------------------------------------------------------------------

export async function loadVipRule(supabase, shopId) {
  const rows = await supabaseSelect(
    supabase,
    T.SHOPS,
    { id: shopId },
    'id,vip_min_spend,vip_min_orders,vip_window_months,vip_rule_changed_at'
  );
  return readVipRule(rows?.[0] ?? null);
}

/**
 * The VIP tickets among `ticketIds` (or among every live ticket, when omitted).
 *
 * @param {string[] | null} [ticketIds]
 * @returns {Promise<Set<string>>}
 */
export async function loadVipTicketIds(supabase, shopId, rule, ticketIds = null) {
  if (!rule) return new Set();
  if (Array.isArray(ticketIds) && ticketIds.length === 0) return new Set();
  const rows = await supabaseRpc(supabase, RPC.VIP_TICKETS, { ...vipArgs(shopId, rule), p_ticket_ids: ticketIds });
  return new Set((rows ?? []).map((row) => row.ticket_id));
}

/** The VIPs among `customerIds`, with their windowed orders and spend. */
export async function loadVipCustomers(supabase, shopId, rule, customerIds) {
  const out = new Map();
  if (!rule || !customerIds?.length) return out;
  const rows = await supabaseRpc(supabase, RPC.VIP_CUSTOMERS, { ...vipArgs(shopId, rule), p_customer_ids: customerIds });
  for (const row of rows ?? []) {
    out.set(row.customer_id, { orders: Number(row.orders), spend: Number(row.spend) });
  }
  return out;
}

/** How many customers a rule admits, and how many ordered at all in its window. */
export async function summariseVipRule(supabase, shopId, rule) {
  if (!rule) return null;
  const rows = await supabaseRpc(supabase, RPC.VIP_SUMMARY, vipArgs(shopId, rule));
  const row = rows?.[0] ?? {};
  return { vipCustomers: Number(row.vip_customers ?? 0), buyersInWindow: Number(row.buyers_in_window ?? 0) };
}

/** Save a validated rule (or clear it with null). The only writer of these columns. */
export async function saveVipRule(supabase, shopId, rule) {
  await supabaseUpdateById(supabase, T.SHOPS, shopId, {
    vip_min_spend: rule ? rule.minSpend : null,
    vip_min_orders: rule ? rule.minOrders : null,
    vip_window_months: rule ? rule.windowMonths : null,
    vip_rule_changed_at: new Date().toISOString()
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
