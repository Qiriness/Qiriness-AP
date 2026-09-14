/**
 * The Sales panel's reads, over the range and platform in the URL: revenue,
 * orders, who bought, on which platform, and what sold best.
 *
 * REVENUE is net of refunds with cancelled orders excluded (see
 * insights_orders_summary). NEW VS RETURNING is never computed over a
 * marketplace: Amazon and Yves Rocher mint one customer record per order, so
 * every one of their buyers would read as new. There is no "by gender": the
 * store records no customer gender, and product tags are not a substitute.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import {
  ALL_MARKETPLACE_HANDLES,
  PLATFORMS,
  isMarketplacePlatform,
  platformOfChannel,
} from "../../../../scripts/lib/insights-range.mjs";
import type {
  CountrySale,
  CustomerMix,
  PairGroup,
  PlatformId,
  PlatformSplit,
  ProductCustomerMix,
  ProductGroup,
  ProductSale,
  SalesPanel,
} from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getOrderSeries, getOrdersSummary, ordersCoverage } from "./orders";
import { toSeries } from "./series";
import { loadVipRule } from "../../../../scripts/lib/vip-rule.mjs";
import { callRpc, callRpcOne, count, getSupabaseClient } from "./shared";

/** What the "Who buys this product" card was asked for, from the URL. */
export interface ProductMixRequest {
  /** `?product=` — absent or unknown falls back to the range's best seller. */
  productId: string | null;
  /** `?mixCountry=` — a country code the range's orders went to, or null for all. */
  country: string | null;
  /** `?mixVip=1` */
  vipOnly: boolean;
}

const NO_PRODUCT_MIX_FILTERS: ProductMixRequest = { productId: null, country: null, vipOnly: false };

/** How many products each country list carries, and how many countries are offered. */
const PER_COUNTRY = 5;
const COUNTRIES = 12;
/** How many pairs each list carries — global and per country, per metric. */
const PAIRS = 10;

/** `productMix` is what the URL asks the "Who buys this product" card for. */
export async function getSalesPanel(
  ctx: InsightsContext,
  productMix: ProductMixRequest = NO_PRODUCT_MIX_FILTERS
): Promise<SalesPanel> {
  const coverage = ordersCoverage(ctx);
  const marketplace = isMarketplacePlatform(ctx.platform);

  const [
    summary,
    seriesRows,
    mixRow,
    channelRows,
    productRows,
    countryByRevenue,
    countryByOrders,
    countryRows,
    pairRows,
  ] =
    await Promise.all([
    getOrdersSummary(ctx),
    getOrderSeries(ctx),
    marketplace ? Promise.resolve(null) : callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_CUSTOMER_MIX, mixArgs(ctx)),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_BY_CHANNEL, {
      p_shop: ctx.shopId,
      p_from: ctx.range.from,
      p_to: ctx.range.to,
      p_tz: ctx.tz,
    }),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_SALES, orderArgs(ctx)),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_COUNTRY_PRODUCT_SALES, {
      ...orderArgs(ctx),
      p_metric: "revenue",
      p_limit: PER_COUNTRY,
    }),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_COUNTRY_PRODUCT_SALES, {
      ...orderArgs(ctx),
      p_metric: "orders",
      p_limit: PER_COUNTRY,
    }),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_BY_COUNTRY, orderArgs(ctx)),
    callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_PAIRS, { ...orderArgs(ctx), p_limit: PAIRS }),
  ]);

  const products = productRows.map(mapProduct);
  const countries = countryRows.map(mapCountry);
  // After the batch, not in it: the default product is the range's best seller,
  // and the country filter only accepts countries the range shipped to — both
  // named by reads above.
  const productCustomerMix = await getProductCustomerMix(ctx, products, countries, productMix, marketplace);

  return {
    summary,
    days: elapsedDays(ctx),
    revenue: toSeries(ctx.range, seriesRows, (row) => row?.revenue ?? 0, coverage),
    orders: toSeries(ctx.range, seriesRows, (row) => row?.orders ?? 0, coverage),
    customerMix: mixRow ? mapMix(mixRow) : null,
    platforms: foldPlatforms(channelRows),
    products: {
      global: group("all", "All products", products),
      byCountry: {
        revenue: countryGroups(countryByRevenue),
        orders: countryGroups(countryByOrders),
      },
    },
    countries,
    pairs: pairGroups(pairRows),
    productCustomerMix,
  };
}

/**
 * The customer-mix arguments: the platform's own filter, with every
 * marketplace removed from "all" — those buyers are one synthetic customer per
 * order and would all read as new.
 */
function mixArgs(ctx: InsightsContext) {
  const base = orderArgs(ctx);
  if (ctx.platform === "all") {
    return { ...base, p_channels: null, p_not_channels: [...ALL_MARKETPLACE_HANDLES] };
  }
  return base;
}

/** Days of the range elapsed so far, whole days rounded up — today counts as one. */
function elapsedDays(ctx: InsightsContext): number {
  const from = Date.parse(`${ctx.range.from}Z`);
  const end = Math.min(Date.parse(`${ctx.range.to}Z`), Date.parse(`${ctx.range.now}Z`));
  return Math.max(1, Math.ceil((end - from) / 86_400_000));
}

function mapMix(row: Record<string, unknown>): CustomerMix {
  return {
    newCustomers: count(row.new_customers),
    returningCustomers: count(row.returning_customers),
    newCustomerOrders: count(row.new_customer_orders),
    returningCustomerOrders: count(row.returning_customer_orders),
  };
}

/** Channel handles -> the three platforms, in a fixed order so a colour always means one platform. */
function foldPlatforms(rows: Record<string, unknown>[]): PlatformSplit[] {
  const totals = new Map<PlatformId, { orders: number; revenue: number }>();
  for (const row of rows) {
    const platform = platformOfChannel(String(row.channel ?? "")) as PlatformId;
    const entry = totals.get(platform) ?? { orders: 0, revenue: 0 };
    entry.orders += count(row.orders);
    entry.revenue += count(row.revenue);
    totals.set(platform, entry);
  }
  return PLATFORMS.filter((p) => p.id !== "all").map((p) => ({
    platform: p.id as PlatformId,
    label: p.label,
    orders: totals.get(p.id as PlatformId)?.orders ?? 0,
    revenue: totals.get(p.id as PlatformId)?.revenue ?? 0,
  }));
}

function mapProduct(row: Record<string, unknown>): ProductSale {
  return {
    productId: String(row.product_id),
    title: String(row.title ?? "Unknown product"),
    orders: count(row.orders),
    units: count(row.units),
    revenue: count(row.revenue),
  };
}

/**
 * The product card: one product's customer split (`insights_product_customer_mix`).
 *
 * The selector offers what had a paid line in the range — a product that did not
 * sell has nothing to split. PEOPLE, SO NEVER OVER A MARKETPLACE: `mixArgs`
 * removes Amazon and Yves Rocher from "all", and a marketplace platform blocks
 * the card, for the reason the customer mix gives — one synthetic customer per
 * order would make every buyer look like a single-product customer.
 */
async function getProductCustomerMix(
  ctx: InsightsContext,
  products: ProductSale[],
  countries: CountrySale[],
  request: ProductMixRequest,
  marketplace: boolean
): Promise<ProductCustomerMix> {
  // Only a country the range actually shipped to; anything else is no filter,
  // rather than a filter that silently matches nobody.
  const country = countries.some((c) => c.code === request.country) ? request.country : null;
  const rule = marketplace ? null : await loadVipRule(getSupabaseClient(), ctx.shopId);

  const empty: ProductCustomerMix = {
    options: [...products]
      .sort((a, b) => a.title.localeCompare(b.title, "fr"))
      .map((p) => ({ productId: p.productId, title: p.title })),
    selected: null,
    customers: 0,
    onlyCustomers: 0,
    withOtherCustomers: 0,
    withoutCustomers: 0,
    alsoBought: [],
    blockedReason: null,
    countries: countries.map((c) => ({ code: c.code, label: c.label })),
    country,
    vipOnly: request.vipOnly,
    vipRuleSet: Boolean(rule),
    notice: null,
  };

  if (marketplace) {
    return {
      ...empty,
      blockedReason:
        "Not measured on a marketplace: Amazon and Yves Rocher create a new customer for every order, so no buyer can be seen buying anything else.",
    };
  }

  const selected =
    products.find((p) => p.productId === request.productId) ??
    [...products].sort((a, b) => b.revenue - a.revenue)[0] ??
    null;
  if (!selected) return empty;
  const selectedRef = { productId: selected.productId, title: selected.title };

  // "VIP only" with no rule would read as zero VIP buyers — a claim about
  // customers, when the truth is that nobody has decided who a VIP is yet.
  if (request.vipOnly && !rule) {
    return {
      ...empty,
      selected: selectedRef,
      notice: "No VIP rule is set, so nobody is a VIP yet. Set one on Insights → Customers, or show all customers.",
    };
  }

  const rows = await callRpc<Record<string, unknown>>(RPC.INSIGHTS_PRODUCT_CUSTOMER_MIX, {
    ...mixArgs(ctx),
    p_product_id: selected.productId,
    p_country: country,
    p_vip_only: request.vipOnly,
    p_min_spend: rule?.minSpend ?? null,
    p_min_orders: rule?.minOrders ?? null,
    p_window_months: rule?.windowMonths ?? null,
    p_vip_not_channels: [...ALL_MARKETPLACE_HANDLES],
  });
  const head = rows[0] ?? {};

  return {
    ...empty,
    selected: selectedRef,
    customers: count(head.customers),
    onlyCustomers: count(head.only_customers),
    withOtherCustomers: count(head.with_other_customers),
    withoutCustomers: count(head.without_customers),
    alsoBought: rows
      .filter((row) => row.other_product_id !== null && row.other_product_id !== undefined)
      .map((row) => ({
        productId: String(row.other_product_id),
        title: String(row.other_title ?? "Unknown product"),
        customers: count(row.other_customers),
      })),
  };
}

function group(key: string, label: string, sales: ProductSale[]): ProductGroup {
  return {
    key,
    label,
    orders: sales.reduce((sum, s) => sum + s.orders, 0),
    revenue: sales.reduce((sum, s) => sum + s.revenue, 0),
    products: sales,
  };
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "Unknown country";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** One group per country, already ranked in SQL, largest country first. */
function countryGroups(rows: Record<string, unknown>[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const row of rows) {
    const code = String(row.country_code ?? "??");
    const existing =
      groups.get(code) ??
      ({
        key: code,
        label: countryName(code),
        orders: count(row.country_orders),
        revenue: count(row.country_revenue),
        products: [],
      } satisfies ProductGroup);
    existing.products.push(mapProduct(row));
    groups.set(code, existing);
  }
  return [...groups.values()].sort((a, b) => b.revenue - a.revenue).slice(0, COUNTRIES);
}

function mapCountry(row: Record<string, unknown>): CountrySale {
  const code = String(row.country_code ?? "??");
  return { code, label: countryName(code), orders: count(row.orders), revenue: count(row.revenue) };
}

/**
 * Pairs arrive global (null country) and per country, each ranked both ways.
 * Countries are ordered by how many paired orders they hold, and the lists stay
 * whole so the view can re-rank by either metric without a round trip.
 */
function pairGroups(rows: Record<string, unknown>[]): PairGroup[] {
  const groups = new Map<string, PairGroup & { weight: number }>();
  for (const row of rows) {
    const code = row.country_code === null || row.country_code === undefined ? "all" : String(row.country_code);
    const existing =
      groups.get(code) ?? { key: code, label: code === "all" ? "All countries" : countryName(code), pairs: [], weight: 0 };
    const orders = count(row.orders);
    existing.pairs.push({
      a: { id: String(row.product_a), title: String(row.title_a ?? "Unknown product") },
      b: { id: String(row.product_b), title: String(row.title_b ?? "Unknown product") },
      orders,
      revenue: count(row.revenue),
      rankByOrders: count(row.rank_by_orders),
      rankByRevenue: count(row.rank_by_revenue),
    });
    existing.weight += orders;
    groups.set(code, existing);
  }
  const all = groups.get("all");
  const countries = [...groups.values()].filter((g) => g.key !== "all").sort((a, b) => b.weight - a.weight);
  return [...(all ? [all] : []), ...countries].map(({ weight: _weight, ...group }) => group);
}
