/**
 * The Orders page: every Shopify order one page at a time, and one order in
 * full — the Shopify admin's order list, inside the app.
 *
 * PAGED IN SQL. `orders_list()` cuts the page and counts the filtered set in one
 * statement; nothing here pages rows or reduces them (DECISIONS.md § Insights).
 *
 * VIP COMES FROM THE SHOP'S RULE through `vip_customers()`, never compared here.
 *
 * THE TICKET RING is the queue's own judgement, not a second one: each ticket
 * arrives from `listTicketsWithOrders` carrying the `priorityBand` /tickets
 * shows, and `ticketMarksByOrder` only folds them per order.
 *
 * PERSONAL DATA: names on the list; name and email on one order, as the
 * Fulfilment panel's waiting orders show them. Both pages log the access.
 *
 * Server-only.
 */

import { RPC, T } from "../../../scripts/lib/tables.mjs";
import { supabaseRpc, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";
import {
  ALL_MARKETPLACE_HANDLES,
  PLATFORMS,
  formatDay,
  isMarketplacePlatform,
  isValidTimeZone,
  platformOfChannel,
  wallClock,
} from "../../../scripts/lib/insights-range.mjs";
import { loadVipCustomers, loadVipRule } from "../../../scripts/lib/vip-rule.mjs";
import {
  ORDER_PAGE_SIZE,
  delayDays,
  enumLabel,
  fulfillmentStatusLabel,
  orderListArgs,
  orderNumberKey,
  ticketMarksByOrder,
} from "../../../scripts/lib/order-list-query.mjs";
import { euros } from "../insights-format";
import { isClosed } from "../ticket-stats";
import type {
  OrderDetail,
  OrderFacet,
  OrderListPage,
  OrderListQuery,
  OrderListRow,
  OrderTicketMark,
  TicketListItem,
} from "../types";
import { LATE_AFTER_DAYS, adminOrdersUrl } from "./insights/open-orders";
import { getSupabaseClient } from "./insights/shared";
import { getShop } from "./shop";
import { listTicketsWithOrders } from "./tickets-service";
import { buildPromotions } from "../../../agent/src/resolution/order-context.mjs";

type Row = Record<string, any>;
type Supabase = ReturnType<typeof getSupabaseClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DETAIL_COLUMNS = [
  "id",
  "name",
  "order_number",
  "legacy_resource_id",
  "processed_at",
  "cancelled_at",
  "cancel_reason",
  "sales_channel",
  "sales_channel_handle",
  "financial_status",
  "fulfillment_status",
  "return_status",
  "currency_code",
  "subtotal_price",
  "total_discounts",
  "total_shipping_price",
  "total_tax",
  "total_price",
  "total_refunded",
  "total_outstanding",
  "tags",
  "customer_email_masked",
  "shopify_customer_id",
  "shipping_destination",
  "line_items",
  "discount_applications",
  "discount_codes",
  "fulfillments",
  "returns",
  "refunds",
].join(",");

export async function listOrders(shopId: string, query: OrderListQuery): Promise<OrderListPage> {
  const supabase = getSupabaseClient();
  const [tz, rule, facetRows, tickets] = await Promise.all([
    shopTimeZone(supabase, shopId),
    loadVipRule(supabase, shopId),
    supabaseRpc(supabase, RPC.ORDERS_LIST_FACETS, { p_shop: shopId }),
    listTicketsWithOrders(shopId),
  ]);

  const vip = {
    p_min_spend: rule?.minSpend ?? null,
    p_min_orders: rule?.minOrders ?? null,
    p_window_months: rule?.windowMonths ?? null,
    p_vip_not_channels: [...ALL_MARKETPLACE_HANDLES],
  };
  const readPage = async (q: OrderListQuery): Promise<Row[]> => {
    const rows = await supabaseRpc(supabase, RPC.ORDERS_LIST, { p_shop: shopId, ...vip, ...orderListArgs(q) });
    return Array.isArray(rows) ? rows : [];
  };

  let served = query;
  let rows = await readPage(served);
  // A page past the end — an old link, or a filter that shrank the set — shows
  // the first page, rather than an empty table that cannot say how many match.
  if (rows.length === 0 && served.page > 1) {
    served = { ...query, page: 1 };
    rows = await readPage(served);
  }

  const marks = ticketMarksByOrder(tickets.map(ticketFacts)) as Map<string, OrderTicketMark>;

  return {
    rows: rows.map((row) => mapListRow(row, tz, marks)),
    total: Number(rows[0]?.total_count ?? 0),
    pageSize: ORDER_PAGE_SIZE,
    query: served,
    facets: mapFacets((facetRows ?? []) as Row[]),
    vipRuleSet: Boolean(rule),
  };
}

/** One order in full, or null when the id names no live order of this shop. */
export async function getOrderDetail(shopId: string, orderId: string): Promise<OrderDetail | null> {
  if (!UUID.test(orderId)) return null;
  const supabase = getSupabaseClient();

  const [orders, tz, rule, tickets] = await Promise.all([
    supabaseSelect(
      supabase,
      T.ORDERS,
      { shop_id: shopId, id: orderId, deleted_at: { operator: "is", value: "null" } },
      DETAIL_COLUMNS,
      { limit: 1 }
    ) as Promise<Row[]>,
    shopTimeZone(supabase, shopId),
    loadVipRule(supabase, shopId),
    listTicketsWithOrders(shopId),
  ]);
  const order = orders?.[0];
  if (!order) return null;

  const platform = platformOfChannel(String(order.sales_channel_handle ?? ""));
  const currency = (order.currency_code as string | null) ?? null;
  const customer = await loadCustomer(supabase, shopId, order.shopify_customer_id);
  const vips = customer && rule ? await loadVipCustomers(supabase, shopId, rule, [customer.id]) : new Map();

  const lineItems = list(order.line_items);
  const key = orderNumberKey(order.order_number) ?? orderNumberKey(order.name);
  const linked = key ? tickets.filter((t) => orderNumberKey(t.orderNumber) === key) : [];

  return {
    orderId: String(order.id),
    name: String(order.name),
    adminUrl: adminLink(order.legacy_resource_id),
    placedLabel: dateTime(order.processed_at, tz) ?? "—",
    cancelledLabel: dateTime(order.cancelled_at, tz),
    cancelReason: order.cancel_reason ? enumLabel(order.cancel_reason) : null,
    platformLabel: PLATFORMS.find((p) => p.id === platform)?.label ?? platform,
    channelLabel: (order.sales_channel as string | null) ?? null,
    financialLabel: order.financial_status ? enumLabel(order.financial_status) : null,
    fulfillmentStatus: (order.fulfillment_status as string | null) ?? null,
    fulfillmentLabel: fulfillmentStatusLabel(order.fulfillment_status),
    returnLabel: order.return_status && order.return_status !== "NO_RETURN" ? enumLabel(order.return_status) : null,
    tags: Array.isArray(order.tags) ? order.tags.map(String) : [],
    units: lineItems.reduce((sum, li) => sum + quantityOf(li), 0),
    lineItems: lineItems.map((li, i) => {
      const total = money(li.discounted_total, li.currency_code ?? currency);
      const original = money(li.original_total, li.currency_code ?? currency);
      return {
        id: String(li.id ?? i),
        title: String(li.title ?? li.name ?? "Untitled item"),
        variantTitle: (li.variant_title as string | null) ?? null,
        sku: (li.sku as string | null) ?? null,
        quantity: Number(li.quantity ?? 0),
        currentQuantity: quantityOf(li),
        totalLabel: total,
        originalTotalLabel: original && original !== total ? original : null,
      };
    }),
    fulfilments: list(order.fulfillments).map((f, i) => ({
      id: String(f.id ?? i),
      name: (f.name as string | null) ?? null,
      statusLabel: enumLabel(f.display_status ?? f.status) || "Fulfilled",
      createdLabel: dateTime(f.created_at, tz),
      deliveredLabel: dateTime(f.delivered_at, tz),
      tracking: list(f.tracking_info).map((t) => ({
        company: (t.company as string | null) ?? null,
        number: (t.number as string | null) ?? null,
        url: typeof t.url === "string" && /^https?:\/\//i.test(t.url) ? t.url : null,
      })),
    })),
    returns: list(order.returns).map((r, i) => ({
      id: String(r.id ?? i),
      name: (r.name as string | null) ?? null,
      statusLabel: enumLabel(r.status),
      createdLabel: dateTime(r.created_at, tz),
    })),
    refunds: list(order.refunds).map((r, i) => ({
      id: String(r.id ?? i),
      createdLabel: dateTime(r.processed_at ?? r.created_at, tz),
      amountLabel: money(r.total_refunded, r.currency_code ?? currency),
    })),
    promotions: promotionsOf(order, currency),
    money: moneyLines(order, currency),
    destination: destinationOf(order.shipping_destination),
    customer: customer
      ? {
          name: customer.name,
          // A marketplace buyer's record holds a placeholder address
          // (example.com, mail.codisto.com) that would read as real.
          email: isMarketplacePlatform(platform) ? null : customer.email,
          isVip: vips.has(customer.id),
          ordersCount: customer.ordersCount,
          spentLabel: money(customer.spent, customer.spentCurrency ?? currency),
        }
      : null,
    maskedEmail: (order.customer_email_masked as string | null) ?? null,
    tickets: linked
      .map((t) => ({
        id: t.id,
        subject: t.subject,
        statusLabel: enumLabel(t.status),
        open: !isClosed(t),
        band: t.priorityBand,
        score: t.priorityScore,
        level: t.level,
      }))
      .sort((a, b) => Number(b.open) - Number(a.open) || b.score - a.score),
  };
}

// --- mapping -----------------------------------------------------------------

function ticketFacts(ticket: TicketListItem) {
  return {
    orderNumber: ticket.orderNumber,
    open: !isClosed(ticket),
    band: ticket.priorityBand,
  };
}

function mapListRow(row: Row, tz: string, marks: Map<string, OrderTicketMark>): OrderListRow {
  const key = orderNumberKey(row.order_number) ?? orderNumberKey(row.order_name);
  const delay = delayDays(row.processed_at, row.awaiting_fulfilment === true) as number | null;
  return {
    orderId: String(row.order_id),
    name: String(row.order_name ?? "—"),
    placedLabel: dateTime(row.processed_at, tz) ?? "—",
    cancelled: Boolean(row.cancelled_at),
    customerName: (row.customer_name as string | null) ?? null,
    isVip: row.is_vip === true,
    totalLabel: money(row.total_price, row.currency_code) ?? "—",
    fulfillmentStatus: (row.fulfillment_status as string | null) ?? null,
    fulfillmentLabel: fulfillmentStatusLabel(row.fulfillment_status),
    delayDays: delay,
    late: delay !== null && delay >= LATE_AFTER_DAYS,
    units: Number(row.units ?? 0),
    carrier: (row.carrier as string | null) ?? null,
    countryCode: (row.country_code as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    ticket: key ? marks.get(key) ?? null : null,
  };
}

function mapFacets(rows: Row[]): OrderListPage["facets"] {
  const statuses: OrderFacet[] = [];
  const countries: OrderFacet[] = [];
  for (const row of rows) {
    const value = String(row.value);
    const orders = Number(row.orders ?? 0);
    if (row.facet === "fulfillment_status") {
      statuses.push({ value, label: fulfillmentStatusLabel(value), orders });
    } else if (row.facet === "country") {
      countries.push({ value, label: value === "??" ? "No destination" : String(row.label || value), orders });
    }
  }
  return { statuses, countries };
}

/**
 * What was applied to this order, for the Promotions card.
 *
 * SHARED WITH THE AGENT (`buildPromotions`), so the page and the case file
 * cannot disagree about whether a gift was given. This adds the money labels and
 * nothing else — a gift is a line whose price went to zero because of a named
 * promotion, a sample was never priced, and that judgement lives in one place.
 */
function promotionsOf(order: Row, currency: string | null): OrderDetail["promotions"] {
  const promotions = buildPromotions(order);
  return {
    applied: (promotions.applied ?? []).map((p: any) => ({
      name: p.name ?? null,
      kind: p.kind ?? null,
      valueLabel:
        p.percentage !== null && p.percentage !== undefined
          ? `−${p.percentage} %`
          : p.amount !== null && p.amount !== undefined
            ? `−${money(p.amount, currency) ?? p.amount}`
            : null,
    })),
    gifts: (promotions.gifts ?? []).map((g: any) => ({
      title: g.title,
      valueLabel: money(g.value, currency),
      promotion: g.promotions?.[0] ?? null,
    })),
    reductions: (promotions.reductions ?? []).map((r: any) => ({
      title: r.title,
      offLabel: money(r.off, currency),
      promotion: r.promotions?.[0] ?? null,
    })),
    samples: (promotions.samples ?? []).map((s: any) => s.title).filter(Boolean),
    codes: promotions.codes ?? [],
    totalLabel: promotions.total ? money(promotions.total, currency) : null,
  };
}

function moneyLines(order: Row, currency: string | null): OrderDetail["money"] {
  const lines: OrderDetail["money"] = [];
  const add = (label: string, value: unknown, options: { strong?: boolean; negative?: boolean; skipZero?: boolean } = {}) => {
    const n = numberOrNull(value);
    if (n === null || (options.skipZero && n === 0)) return;
    const text = money(n, currency);
    if (text) lines.push({ label, value: options.negative ? `−${text}` : text, strong: options.strong });
  };
  add("Subtotal", order.subtotal_price);
  add("Discounts", order.total_discounts, { negative: true, skipZero: true });
  add("Shipping", order.total_shipping_price);
  add("Tax", order.total_tax);
  add("Total", order.total_price, { strong: true });
  add("Refunded", order.total_refunded, { negative: true, skipZero: true });
  add("Outstanding", order.total_outstanding, { skipZero: true });
  return lines;
}

function destinationOf(value: unknown): OrderDetail["destination"] {
  const d = (value ?? {}) as Row;
  const destination = {
    city: (d.city as string | null) ?? null,
    province: (d.province as string | null) ?? null,
    country: (d.country as string | null) ?? null,
    countryCode: (d.country_code as string | null) ?? null,
  };
  return Object.values(destination).some(Boolean) ? destination : null;
}

async function loadCustomer(supabase: Supabase, shopId: string, shopifyCustomerId: unknown) {
  if (!shopifyCustomerId) return null;
  const rows = (await supabaseSelect(
    supabase,
    T.CUSTOMERS,
    { shop_id: shopId, shopify_customer_id: String(shopifyCustomerId), deleted_at: { operator: "is", value: "null" } },
    "id,display_name,first_name,last_name,email,number_of_orders,amount_spent,amount_spent_currency",
    { limit: 1 }
  )) as Row[];
  const c = rows?.[0];
  if (!c) return null;
  return {
    id: String(c.id),
    name: (c.display_name as string | null) || [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
    email: (c.email as string | null) ?? null,
    ordersCount: numberOrNull(c.number_of_orders),
    spent: numberOrNull(c.amount_spent),
    spentCurrency: (c.amount_spent_currency as string | null) ?? null,
  };
}

/** The shop's clock, or UTC while the shop has none — as the Insights panels do. */
async function shopTimeZone(supabase: Supabase, shopId: string): Promise<string> {
  // The remembered shop row (shop.ts) answers this for the shop every page
  // reads; any other id is read directly rather than assumed to share its clock.
  const shop = await getShop();
  if (shop?.id === shopId) return isValidTimeZone(shop.ianaTimezone) ? String(shop.ianaTimezone) : "UTC";
  const rows = (await supabaseSelect(supabase, T.SHOPS, { id: shopId }, "iana_timezone", { limit: 1 })) as Row[];
  const tz = rows?.[0]?.iana_timezone;
  return isValidTimeZone(tz) ? String(tz) : "UTC";
}

function adminLink(legacyId: unknown): string | null {
  const base = adminOrdersUrl();
  return base && legacyId ? `${base}/${legacyId}` : null;
}

// --- formatting ----------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** `14 Sep 2026, 10:22` on the shop's clock. Formatted here so server and browser print the same characters. */
function dateTime(iso: unknown, tz: string): string | null {
  if (!iso || !Number.isFinite(Date.parse(String(iso)))) return null;
  const d = wallClock(String(iso), tz) as Date;
  return `${formatDay(d)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function money(value: unknown, currency: string | null): string | null {
  const n = numberOrNull(value);
  if (n === null) return null;
  if (!currency || currency === "EUR") return euros(n, { cents: true });
  return `${n.toFixed(2)} ${currency}`;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quantityOf(lineItem: Row): number {
  return Number(lineItem.current_quantity ?? lineItem.quantity ?? 0);
}

function list(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}
