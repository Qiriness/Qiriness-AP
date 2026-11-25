/**
 * Marketing Performance: what each channel brought, by the provider's own
 * reporting and by Shopify's, and what the spend bought.
 *
 * SOURCES, and none is summed into another:
 *  - website net sales: Shopify's money ladder folded onto the own store (./analytics.ts)
 *  - attributed sales, new customers: ShopifyQL `sales` WITH <model>_ATTRIBUTION,
 *    own-store channels only, classified by scripts/lib/marketing-channels.mjs
 *  - sessions per channel: ShopifyQL `sessions`, humans only
 *  - ad spend and the providers' own conversions: the Meta / Google Ads sync
 *    (ad_days, ad_campaign_days) through social-service.ts
 *  - Klaviyo's own revenue: the Klaviyo sync (insights_klaviyo_messages)
 *
 * PROVIDER CLAIMS ARE NEVER ADDED TO SHOPIFY'S FIGURES, and never presented as
 * website revenue: Meta and Google can both claim one order.
 *
 * Website only: on a marketplace platform every card is blocked with the
 * reason, since a marketplace buyer had no session and saw no ad of ours.
 *
 * Server-only.
 */

import { CHANNEL_GROUPS, PROVIDERS, salesByCampaign, salesByGroup, salesByProvider, sessionsByCampaign, sessionsByGroup, sessionsByProvider } from "../../../../scripts/lib/marketing-channels.mjs";
import { channelRows, compareProvider, executiveFigures, trackingCoverage } from "../../../../scripts/lib/marketing-metrics.mjs";
import { attributedSalesQuery, newReturningQuery, trafficQuery } from "../../../../scripts/lib/storefront-marketing.mjs";
import { SHOPIFY_PLATFORM } from "../../../../scripts/lib/marketplaces.mjs";
import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../../scripts/lib/tables.mjs";
import type {
  AttributionModel,
  ChannelGroup,
  ExecutiveFigures,
  MarketingPerformanceData,
  ProviderCampaignRow,
  ProviderComparison,
  ProviderId,
  ShopifySide,
} from "../../marketing-types";
import type { PaidCampaign, PaidKind, PaidTotals } from "../../social-types";
import type { LivePart } from "../../types";
import { BLOCKED_MARKETPLACE, liveSales } from "./analytics";
import type { InsightsContext } from "./context";
import { getSupabaseClient } from "./shared";
import { PRIORITY, shopifyql, type Row } from "./shopifyql";
import { getMarketingPaid } from "./social-service";

type Window = { from: string; to: string };
type Counts = { netSales: number; totalSales: number; orders: number; newCustomers: number };
type SessionCounts = { sessions: number; cartSessions: number; checkoutSessions: number; convertedSessions: number };

const PROVIDER_OF_KIND: Record<string, string> = { google_ads: "google", meta_ads: "meta" };

/**
 * The shop's currency, from its latest order: ShopifyQL money is in it, and
 * ad spend in another currency cannot be divided into it.
 */
async function shopCurrency(shopId: string): Promise<string | null> {
  try {
    const rows = (await supabaseSelect(getSupabaseClient(), T.ORDERS, { shop_id: shopId }, "currency_code", {
      order: "shopify_created_at.desc",
      limit: 1,
    })) as { currency_code: string | null }[];
    return rows?.[0]?.currency_code ?? null;
  } catch {
    return null;
  }
}

const isOwnStore = (ctx: InsightsContext) => (row: Row) =>
  ctx.marketplaces.platformOfAnalyticsChannel(row.sales_channel as string) === SHOPIFY_PLATFORM;

/** Spend (and the provider's own conversions) per paid kind, in one currency; null when it is not one currency. */
function paidOf(totals: PaidTotals[] | undefined, currency: string | null) {
  if (!totals || totals.length === 0) return { spend: 0, conversions: 0, conversionValue: 0, impressions: 0, clicks: 0, currency };
  if (totals.length > 1) return null;
  const [t] = totals;
  if (currency && t.currency !== currency) return null;
  return { spend: t.spend, conversions: t.conversions, conversionValue: t.conversionValue, impressions: t.impressions, clicks: t.clicks, currency: t.currency };
}

interface WindowRead {
  attributed: Row[];
  newReturning: Row[];
  traffic: Row[];
  websiteNet: number | null;
}

async function readWindow(ctx: InsightsContext, window: Window, model: AttributionModel, priority: number): Promise<WindowRead> {
  const range = { ...ctx.range, ...window };
  const own = isOwnStore(ctx);
  const [attributed, newReturning, traffic] = await Promise.all([
    shopifyql(ctx.shopDomain, attributedSalesQuery(range, model), priority),
    shopifyql(ctx.shopDomain, newReturningQuery(range), priority),
    shopifyql(ctx.shopDomain, trafficQuery(range), priority),
  ]);
  return { attributed: attributed.filter(own), newReturning: newReturning.filter(own), traffic, websiteNet: null };
}

function figuresFor(
  read: WindowRead,
  paid: { spend: number | null; reason: string | null; providerRevenue: number | null; kinds: PaidKind[] }
): ExecutiveFigures {
  const byProvider = salesByProvider(read.attributed) as Map<string, Counts>;
  const paidProviders = PROVIDERS.filter((p) => p.paid && paid.kinds.includes(p.kind as PaidKind));
  const sum = (field: keyof Counts) => paidProviders.reduce((t, p) => t + (byProvider.get(p.id)?.[field] ?? 0), 0);
  const newCustomers = read.attributed.reduce((t, r) => t + metricOf(r, "new_customers"), 0);
  const nr = (label: string) =>
    read.newReturning.filter((r) => String(r.new_or_returning_customer ?? "").toLowerCase() === label).reduce((t, r) => t + metricOf(r, "net_sales"), 0);
  return executiveFigures({
    websiteNet: read.websiteNet,
    adSpend: paid.spend,
    adSpendReason: paid.reason,
    // No source of non-ad marketing costs is configured yet (see the profitability plan).
    otherMarketingCosts: null,
    providerRevenue: paid.providerRevenue,
    shopifyPaidNet: sum("netSales"),
    shopifyPaidOrders: sum("orders"),
    newCustomers,
    newCustomerNet: nr("new"),
    returningNet: nr("returning"),
  }) as ExecutiveFigures;
}

function metricOf(row: Row, name: string): number {
  for (const [key, value] of Object.entries(row)) {
    if (key === name || key.startsWith(`${name}__`)) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

const shopifySide = (c: Counts | undefined, spend: number | null): ShopifySide => {
  const s = c ?? { netSales: 0, totalSales: 0, orders: 0, newCustomers: 0 };
  const per = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    ...s,
    roas: spend === null ? null : per(s.netSales, spend),
    roasTotal: spend === null ? null : per(s.totalSales, spend),
    cpa: spend === null ? null : per(spend, s.orders),
    cac: spend === null ? null : per(spend, s.newCustomers),
    aov: per(s.netSales, s.orders),
    newCustomerShare: s.orders > 0 ? (s.newCustomers / s.orders) * 100 : null,
  };
};

const norm = (name: string | null | undefined) => String(name ?? "").trim().toLowerCase();

/** Each provider campaign beside the Shopify UTM campaign of the same name, and the UTM campaigns that match none. */
function campaignRows(campaigns: PaidCampaign[], kind: PaidKind, providerId: string, attributed: Row[], traffic: Row[]) {
  const sales = salesByCampaign(attributed, providerId) as Map<string, Counts>;
  const sessions = sessionsByCampaign(traffic, providerId) as Map<string, SessionCounts>;
  const byName = new Map<string, { counts: Counts | null; sessions: SessionCounts | null; name: string }>();
  for (const [name, counts] of sales) byName.set(norm(name), { counts, sessions: null, name });
  for (const [name, s] of sessions) {
    const hit = byName.get(norm(name));
    if (hit) hit.sessions = s;
    else byName.set(norm(name), { counts: null, sessions: s, name });
  }
  const matched = new Set<string>();
  const rows: ProviderCampaignRow[] = campaigns
    .filter((c) => c.kind === kind && (c.spend > 0 || c.impressions > 0))
    .map((c) => {
      const hit = byName.get(norm(c.name));
      if (hit) matched.add(norm(c.name));
      const s = hit?.sessions ?? null;
      const k = hit?.counts ?? null;
      return {
        key: c.key,
        name: c.name,
        objective: c.objective,
        status: c.status,
        url: c.url,
        spend: c.spend,
        impressions: c.impressions,
        clicks: c.clicks,
        ctr: c.ctr,
        cpc: c.cpc,
        cpm: c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null,
        conversions: c.conversions,
        conversionValue: c.conversionValue,
        roas: c.roas,
        shopify: hit
          ? {
              sessions: s?.sessions ?? 0,
              orders: k?.orders ?? 0,
              netSales: k?.netSales ?? 0,
              newCustomers: k?.newCustomers ?? 0,
              conversionRate: s && s.sessions > 0 ? (s.convertedSessions / s.sessions) * 100 : null,
            }
          : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);
  const unmatched = [...byName.entries()]
    .filter(([key]) => !matched.has(key))
    .map(([, v]) => ({ name: v.name, orders: v.counts?.orders ?? 0, netSales: v.counts?.netSales ?? 0, sessions: v.sessions?.sessions ?? 0 }))
    .filter((u) => u.orders > 0 || u.sessions > 0)
    .sort((a, b) => b.netSales - a.netSales || b.sessions - a.sessions);
  return { rows, unmatched };
}

export async function readMarketingPerformance(
  ctx: InsightsContext,
  model: AttributionModel,
  klaviyo: { revenue: number; conversions: number } | null,
  klaviyoLastSync: string | null,
  klaviyoReason: string | null
): Promise<LivePart<MarketingPerformanceData | null>> {
  if (ctx.marketplaces.isMarketplace(ctx.platform)) return { blockedReason: BLOCKED_MARKETPLACE, value: null };
  try {
    const compare = ctx.range.preset !== "all";
    const [sales, currency, paid, current, previous] = await Promise.all([
      liveSales(ctx),
      shopCurrency(ctx.shopId),
      getMarketingPaid(ctx),
      readWindow(ctx, ctx.range, model, PRIORITY.headline),
      compare ? readWindow(ctx, ctx.range.previous, model, PRIORITY.detail) : Promise.resolve(null),
    ]);
    current.websiteNet = sales.value.storefront.current?.netSales ?? null;
    if (previous) previous.websiteNet = sales.value.storefront.previous?.netSales ?? null;

    const kinds = paid?.panel.kinds ?? [];
    const spendFor = (which: "current" | "previous") => {
      const per = kinds.map((kind) => ({ kind, totals: paidOf(paid!.panel.byKind.find((b) => b.kind === kind)?.totals[which] ?? undefined, currency) }));
      if (!kinds.length) return { spend: null, reason: "insights.mkt.state.noAdsConnected", providerRevenue: null, per };
      if (per.some((p) => p.totals === null)) return { spend: null, reason: "insights.mkt.state.mixedCurrency", providerRevenue: null, per };
      return {
        spend: per.reduce((t, p) => t + p.totals!.spend, 0),
        reason: null,
        providerRevenue: per.reduce((t, p) => t + p.totals!.conversionValue, 0),
        per,
      };
    };
    const now = spendFor("current");
    // An earlier period the ad sync never reached has no spend to compare: its
    // website figures still are, and its spend-based ones say why they are not.
    const before = previous
      ? kinds.length && !paid!.panel.totals.previous
        ? { spend: null, reason: "insights.mkt.state.previousNotSynced", providerRevenue: null, per: [] }
        : spendFor("previous")
      : null;

    const kpis = {
      current: figuresFor(current, { ...now, kinds }),
      previous: previous && before ? figuresFor(previous, { ...before, kinds }) : null,
    };

    const groupSales = salesByGroup(current.attributed) as Map<ChannelGroup, Counts>;
    const groupSessions = sessionsByGroup(current.traffic) as Map<ChannelGroup, SessionCounts>;
    const spendByGroup = new Map<string, number>();
    for (const p of now.per) {
      const provider = PROVIDERS.find((x) => x.kind === p.kind);
      if (provider && p.totals) spendByGroup.set(provider.group, (spendByGroup.get(provider.group) ?? 0) + p.totals.spend);
    }

    const providerSales = salesByProvider(current.attributed) as Map<string, Counts>;
    const providerSessions = sessionsByProvider(current.traffic) as Map<string, SessionCounts>;
    const syncOf = (kind: string | null) => paid?.providers.find((p) => p.provider === PROVIDER_OF_KIND[kind ?? ""]) ?? null;

    const providers: ProviderComparison[] = PROVIDERS.map((def) => {
      const id = def.id as ProviderId;
      const shopify = providerSales.get(id);
      const sessions = providerSessions.get(id) ?? null;
      if (def.kind === null) {
        // An owned channel (Klaviyo): no spend; its own revenue from its own sync.
        const cmp = compareProvider({ provider: klaviyo, shopify, sessions, spend: null });
        return {
          id,
          kind: null,
          connected: klaviyo !== null,
          blockedReason: klaviyo ? null : klaviyoReason,
          lastSyncAt: klaviyoLastSync,
          currency,
          impressions: null,
          clicks: null,
          ...cmp,
          shopify: shopifySide(shopify, null),
          campaigns: [],
          unmatchedCampaigns: [],
        };
      }
      const kind = def.kind as PaidKind;
      const connected = kinds.includes(kind);
      const own = now.per.find((p) => p.kind === kind)?.totals ?? null;
      const spend = connected && own ? own.spend : null;
      const cmp = compareProvider({
        provider: connected && own ? { revenue: own.conversionValue, conversions: own.conversions } : null,
        shopify,
        sessions,
        spend,
      });
      const cut = connected ? campaignRows(paid!.panel.campaigns, kind, id, current.attributed, current.traffic) : { rows: [], unmatched: [] };
      return {
        id,
        kind,
        connected,
        blockedReason: !connected ? "insights.mkt.state.providerNotConnected" : own ? null : "insights.mkt.state.mixedCurrency",
        lastSyncAt: syncOf(kind)?.lastSyncAt ?? null,
        currency: own?.currency ?? null,
        impressions: own?.impressions ?? null,
        clicks: own?.clicks ?? null,
        ...cmp,
        shopify: shopifySide(shopify, spend),
        campaigns: cut.rows,
        unmatchedCampaigns: cut.unmatched,
      };
    });

    const emailSessions = groupSessions.get("email") ?? null;
    return {
      blockedReason: null,
      value: {
        model,
        currency,
        kpis,
        channels: channelRows({ groups: CHANNEL_GROUPS, salesByGroup: groupSales, sessionsByGroup: groupSessions, spendByGroup }),
        coverage: trackingCoverage(groupSales),
        providers,
        email: {
          shopify: shopifySide(groupSales.get("email"), null),
          sessions: emailSessions?.sessions ?? null,
          conversionRate: emailSessions && emailSessions.sessions > 0 ? (emailSessions.convertedSessions / emailSessions.sessions) * 100 : null,
        },
      },
    };
  } catch (error) {
    return { blockedReason: error instanceof Error ? error.message : String(error), value: null };
  }
}
