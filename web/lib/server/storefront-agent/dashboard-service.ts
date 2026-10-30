/**
 * The Storefront Agent dashboard: one window and the one before, read from
 * `storefront_agent_dashboard` (migration 07) and turned into the page's
 * contract (storefront-agent-types.ts). Server-only.
 *
 * WHICH SHOP. The advisor's own: STOREFRONT_CHAT_ALLOWED_SHOPS, the shops its
 * app proxy may answer (the dev store today). Not the Insights shop switcher:
 * the support desk's shop has no advisor. Days are cut in that shop's timezone
 * when it is synced as a shop, else the desk shop's, else UTC.
 *
 * WHAT IS NOT TRACKED SAYS SO. Storefront visits have no source for the
 * advisor's store; chat opens start with the widget build that sends them;
 * purchases need the advisor's shop to have its orders synced; recommendation
 * accuracy has no ground truth. Each is null with a reason, never 0.
 *
 * Server-side cache: the Insights TTL and tag, so « Live · HH:MM » means the
 * same thing here and a dashboard refresh costs nothing until it expires.
 */

import { unstable_cache } from "next/cache";
import { parseAllowedShops } from "../../../../scripts/lib/storefront-chat/app-proxy-signature.mjs";
import { num, priceTokens, rate } from "../../../../scripts/lib/storefront-chat/agent-dashboard.mjs";
import { isValidTimeZone, resolveRange } from "../../../../scripts/lib/insights-range.mjs";
import { STOREFRONT_AGENT_RPC } from "../../../../scripts/lib/tables.mjs";
import { supabaseRpc } from "../../../../scripts/lib/supabase-rest-client.mjs";
import type { InsightsRange } from "../../types";
import type {
  AgentIntent,
  AgentIntentRow,
  AgentRoute,
  AgentRouteRow,
  FunnelStage,
  PeriodFigure,
  StorefrontAgentDashboard,
} from "../../storefront-agent-types";
import { CACHE_TAGS } from "../cache-tags";
import { getShop, getShopByDomain } from "../shop";
import { getSupabaseClient, INSIGHTS_TTL_SECONDS } from "../insights/shared";
import { previousCovered, toSeries } from "../insights/series";
import type { SearchParams } from "../insights/context";

/** The periods the page offers; anything else in `?range=` is the default. */
export const AGENT_PRESETS = ["7d", "30d", "90d"] as const;
const DEFAULT_RANGE = "30d";

interface RawCounts {
  total: number;
  resolved: number;
  escalated: number;
  shown: number;
  clicked: number;
  carted: number;
  purchased: number;
}

interface RawDashboard {
  coverage: { turns_from: string | null; live_turns_from: string | null; opens_from: string | null; orders_synced: boolean };
  conversations: RawCounts;
  opens: number;
  orders: { count: number; revenue: string | number };
  turns: {
    total: number;
    answered: number;
    failed: number;
    conversations: number;
    p50: number | null;
    p95: number | null;
    model_p50: number | null;
    model_p95: number | null;
    tool_calls: number;
    tool_failures: number;
    with_fallback: number;
    unanswered: number;
    escalated: number;
    input_tokens: number;
    output_tokens: number;
  };
  errors: { code: string | null; turns: number }[];
  fallbacks: { kind: string; turns: number }[];
  tokens: { route: AgentRoute; intent: AgentIntent; model: string; input: number; output: number }[];
  routes: { route: AgentRoute; turns: number; failed: number; resolved: number; p50: number | null; p95: number | null; shown: number; clicked: number; carted: number }[];
  intents: { intent: AgentIntent; conversations: number; resolved: number; carted: number; purchased: number; revenue: string | number; p50: number | null; p95: number | null }[];
  series: { bucket: string; conversations: number; orders: number; revenue: string | number }[];
  products: { product_id: string; title: string | null; handle: string | null; shown: number; clicked: number; carted: number; units: string | number; sales: string | number }[];
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const readDashboard = unstable_cache(
  async (shops: string[], from: string, to: string, tz: string, grain: string) =>
    (await supabaseRpc(getSupabaseClient(), STOREFRONT_AGENT_RPC.DASHBOARD, {
      p_shops: shops,
      p_from: from,
      p_to: to,
      p_tz: tz,
      p_grain: grain,
    })) as RawDashboard,
  ["storefront-agent-dashboard"],
  { revalidate: INSIGHTS_TTL_SECONDS, tags: [CACHE_TAGS.insights] }
);

/** The advisor's shops, from the same allow-list its routes check. */
export function advisorShops(): string[] {
  return [...parseAllowedShops(process.env.STOREFRONT_CHAT_ALLOWED_SHOPS)] as string[];
}

async function timezoneFor(shops: string[]): Promise<string> {
  for (const domain of shops) {
    const shop = await getShopByDomain(domain).catch(() => null);
    if (shop && isValidTimeZone(shop.ianaTimezone)) return shop.ianaTimezone as string;
  }
  const desk = await getShop().catch(() => null);
  return desk && isValidTimeZone(desk.ianaTimezone) ? (desk.ianaTimezone as string) : "UTC";
}

/** The range the URL asks for: one of the three presets, or a custom from/to. */
export async function resolveAgentRange(searchParams: SearchParams, shops: string[]): Promise<InsightsRange> {
  const tz = await timezoneFor(shops);
  const preset = first(searchParams.range);
  return resolveRange(
    {
      range: (AGENT_PRESETS as readonly string[]).includes(preset ?? "") ? preset : DEFAULT_RANGE,
      from: first(searchParams.from),
      to: first(searchParams.to),
    },
    { tz }
  ) as unknown as InsightsRange;
}

const figure = (current: number | null, previous: number | null, compare: boolean): PeriodFigure => ({
  current,
  previous: compare ? previous : null,
});

export async function getStorefrontAgentDashboard(range: InsightsRange, shops: string[]): Promise<StorefrontAgentDashboard> {
  const [d, p] = await Promise.all([
    readDashboard(shops, range.from, range.to, range.tz, range.grain),
    readDashboard(shops, range.previous.from, range.previous.to, range.tz, range.grain),
  ]);

  const turnsFrom = d.coverage.turns_from;
  const compare = Boolean(turnsFrom) && previousCovered(range, { from: turnsFrom, through: null });
  const purchasesTracked = Boolean(d.coverage.orders_synced);
  const opensTracked = Boolean(d.coverage.opens_from);
  const c = d.conversations;
  const pc = p.conversations;

  const revenue = (raw: RawDashboard) => (purchasesTracked ? num(raw.orders.revenue) ?? 0 : null);
  const orders = (raw: RawDashboard) => (purchasesTracked ? raw.orders.count : null);
  const conversion = (counts: RawCounts) => (purchasesTracked ? rate(counts.purchased, counts.total) : null);
  const errorRate = (raw: RawDashboard) => rate(raw.turns.failed, raw.turns.total);
  const priced = priceTokens(d.tokens);
  const pricedBefore = priceTokens(p.tokens);
  const costPerConversation = (cost: number | null, raw: RawDashboard) => (cost === null ? null : rate(cost, raw.turns.conversations));

  const funnel: FunnelStage[] = [
    { key: "visits", value: null, reason: "storefrontAgent.notTracked.visits" },
    opensTracked ? { key: "opens", value: d.opens } : { key: "opens", value: null, reason: "storefrontAgent.notTracked.opens" },
    { key: "conversations", value: c.total },
    { key: "shown", value: c.shown },
    { key: "clicked", value: c.clicked },
    { key: "carted", value: c.carted },
    purchasesTracked ? { key: "purchased", value: c.purchased } : { key: "purchased", value: null, reason: "storefrontAgent.notTracked.purchases" },
  ];

  const routes: AgentRouteRow[] = d.routes.map((r) => ({
    route: r.route,
    turns: r.turns,
    p50: num(r.p50),
    p95: num(r.p95),
    resolution: rate(r.resolved, r.turns),
    clickRate: rate(r.clicked, r.shown),
    cartRate: rate(r.carted, r.shown),
    errorRate: rate(r.failed, r.turns),
    // A route with no model call costs nothing by construction; one with calls but no rate is unknown.
    costUsd: r.route === "llm" ? priced.byRoute.llm ?? null : priced.byRoute[r.route] ?? 0,
  }));

  const intents: AgentIntentRow[] = d.intents.map((i) => ({
    intent: i.intent,
    conversations: i.conversations,
    resolution: rate(i.resolved, i.conversations),
    cartRate: rate(i.carted, i.conversations),
    conversion: purchasesTracked ? rate(i.purchased, i.conversations) : null,
    revenue: purchasesTracked ? num(i.revenue) ?? 0 : null,
    p50: num(i.p50),
    p95: num(i.p95),
  }));

  const coverage = { from: turnsFrom, through: null };
  const seriesRows = d.series.map((s) => ({ ...s, bucket: s.bucket }));

  return {
    shops,
    range,
    coverage: {
      turnsFrom,
      liveTurnsFrom: d.coverage.live_turns_from,
      opensFrom: d.coverage.opens_from,
      purchasesTracked,
      previousCovered: compare,
    },
    kpis: {
      conversations: figure(c.total, pc.total, compare),
      revenue: figure(revenue(d), revenue(p), compare),
      orders: figure(orders(d), orders(p), compare),
      conversion: figure(conversion(c), conversion(pc), compare),
      resolution: figure(rate(c.resolved, c.total), rate(pc.resolved, pc.total), compare),
      p95: figure(num(d.turns.p95), num(p.turns.p95), compare),
    },
    funnel,
    sales: {
      revenue: toSeries(range, seriesRows, (row) => (purchasesTracked ? num(row?.revenue) ?? 0 : null), purchasesTracked ? coverage : { from: null, through: null }),
      conversations: toSeries(range, seriesRows, (row) => row?.conversations ?? 0, coverage),
      aov: figure(
        purchasesTracked ? rate(num(d.orders.revenue) ?? 0, d.orders.count) : null,
        purchasesTracked ? rate(num(p.orders.revenue) ?? 0, p.orders.count) : null,
        compare
      ),
      products: d.products.map((row) => ({
        productId: row.product_id,
        title: row.title,
        handle: row.handle,
        shown: row.shown,
        clicked: row.clicked,
        carted: row.carted,
        units: purchasesTracked ? num(row.units) ?? 0 : null,
        sales: purchasesTracked ? num(row.sales) ?? 0 : null,
      })),
      byIntent: intents.map((i) => ({ intent: i.intent, revenue: i.revenue, conversations: i.conversations })),
    },
    quality: {
      resolution: figure(rate(c.resolved, c.total), rate(pc.resolved, pc.total), compare),
      escalation: figure(rate(c.escalated, c.total), rate(pc.escalated, pc.total), compare),
      unanswered: {
        turns: d.turns.unanswered,
        rate: rate(d.turns.unanswered, d.turns.answered),
        previousRate: compare ? rate(p.turns.unanswered, p.turns.answered) : null,
      },
      errorRate: figure(errorRate(d), errorRate(p), compare),
    },
    technical: {
      p50: figure(num(d.turns.p50), num(p.turns.p50), compare),
      p95: figure(num(d.turns.p95), num(p.turns.p95), compare),
      modelP50: num(d.turns.model_p50),
      modelP95: num(d.turns.model_p95),
      turns: d.turns.total,
      failedTurns: d.turns.failed,
      errors: d.errors.map((e) => ({ code: e.code ?? "unknown", turns: e.turns })),
      toolCalls: d.turns.tool_calls,
      toolFailures: d.turns.tool_failures,
      fallbackRate: figure(rate(d.turns.with_fallback, d.turns.total), rate(p.turns.with_fallback, p.turns.total), compare),
      fallbacks: d.fallbacks,
      inputTokens: d.turns.input_tokens,
      outputTokens: d.turns.output_tokens,
      costUsd: figure(priced.total, pricedBefore.total, compare),
      costPerConversation: figure(costPerConversation(priced.total, d), costPerConversation(pricedBefore.total, p), compare),
      unpriced: priced.unpriced,
    },
    routes,
    intents,
  };
}
