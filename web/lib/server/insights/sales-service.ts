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
  ProductGroup,
  ProductSale,
  SalesPanel,
} from "../../types";
import { orderArgs, type InsightsContext } from "./context";
import { getOrderSeries, getOrdersSummary, ordersCoverage } from "./orders";
import { toSeries } from "./series";
import { callRpc, callRpcOne, count } from "./shared";

/** How many products each country list carries, and how many countries are offered. */
const PER_COUNTRY = 5;
const COUNTRIES = 12;
/** How many pairs each list carries — global and per country, per metric. */
const PAIRS = 10;

export async function getSalesPanel(ctx: InsightsContext): Promise<SalesPanel> {
  const coverage = ordersCoverage(ctx);
  const marketplace = isMarketplacePlatform(ctx.platform);

  const [summary, seriesRows, mixRow, channelRows, productRows, countryByRevenue, countryByOrders, countryRows, pairRows] =
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


  return {
    summary,
    days: elapsedDays(ctx),
    revenue: toSeries(ctx.range, seriesRows, (row) => row?.revenue ?? 0, coverage),
    orders: toSeries(ctx.range, seriesRows, (row) => row?.orders ?? 0, coverage),
    customerMix: mixRow ? mapMix(mixRow) : null,
    platforms: foldPlatforms(channelRows),
    products: {
      global: group("all", "All products", productRows.map(mapProduct)),
      byCountry: {
        revenue: countryGroups(countryByRevenue),
        orders: countryGroups(countryByOrders),
      },
    },
    countries: countryRows.map(mapCountry),
    pairs: pairGroups(pairRows),
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
