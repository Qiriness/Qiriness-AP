/**
 * Funnel & Website Performance: where sessions enter, how far they get, and
 * which pages deserve work.
 *
 * Every figure is ShopifyQL `sessions` (humans only), live for the range:
 *  - the traffic cut (device x landing type x channel), folded in the browser
 *    so the funnel's device / channel / landing-type filters cost no query;
 *  - landing pages with their funnel counts, now and one period earlier;
 *  - landing page x channel and x device, for the expanded rows, the matrix
 *    and the opportunity flags.
 *
 * WHAT IS NOT HERE, AND WHY. Revenue and orders per landing page: `sales` has
 * no landing page dimension, so the tables count sessions that completed a
 * checkout. Product and collection VIEWS, checkout sub-steps and journeys: no
 * dataset holds them; they need the web pixel (docs/marketing-funnel-redesign.md).
 *
 * Server-only.
 */

import { SALES_COLLECTION_HANDLES } from "../../../../scripts/lib/sales-collections.mjs";
import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../../scripts/lib/tables.mjs";
import {
  collectionCategory,
  countriesQuery,
  handleOf,
  landingByDevice,
  landingByGroup,
  landingChannelQuery,
  landingDeviceQuery,
  landingPagesQuery,
  readLandingPages,
  readTraffic,
  safeCountry,
  trafficQuery,
} from "../../../../scripts/lib/storefront-marketing.mjs";
import { priceBand, scoreOpportunities } from "../../../../scripts/lib/website-opportunities.mjs";
import type { ChannelGroup, FunnelCounts, LandingPage, Opportunity, TrafficRow, WebsitePerformanceData } from "../../marketing-types";
import type { LivePart } from "../../types";
import { BLOCKED_MARKETPLACE, liveSales } from "./analytics";
import type { InsightsContext } from "./context";
import { getSupabaseClient } from "./shared";
import { PRIORITY, shopifyql } from "./shopifyql";

/** Landing pages the table carries. The tail beyond is single sessions. */
const PAGE_LIMIT = 400;

interface Catalogue {
  products: Map<string, { title: string; price: number | null }>;
  collections: Map<string, { title: string; axis: string | null }>;
  storefrontUrl: string | null;
}

/** Handles -> titles and prices, collection axes, and the storefront: three small reads, never order-sized. */
async function readCatalogue(shopId: string): Promise<Catalogue> {
  const db = getSupabaseClient();
  const [products, collections, shops] = await Promise.all([
    supabaseSelect(db, T.PRODUCTS, { shop_id: shopId }, "handle,title,variants", { limit: 1000 }).catch(() => []) as Promise<
      { handle: string | null; title: string; variants: { price?: string | number | null }[] | null }[]
    >,
    supabaseSelect(db, T.ADVICE_COLLECTIONS, { shop_id: shopId }, "handle,title,axis,deleted_at", { limit: 1000 }).catch(
      () => []
    ) as Promise<{ handle: string; title: string; axis: string | null; deleted_at: string | null }[]>,
    supabaseSelect(db, T.SHOPS, { id: shopId }, "storefront_url", { limit: 1 }).catch(() => []) as Promise<{ storefront_url: string | null }[]>,
  ]);
  const productMap = new Map<string, { title: string; price: number | null }>();
  for (const p of products ?? []) {
    if (!p.handle) continue;
    const prices = (Array.isArray(p.variants) ? p.variants : []).map((v) => Number(v?.price)).filter((n) => Number.isFinite(n) && n > 0);
    productMap.set(p.handle.toLowerCase(), { title: p.title, price: prices.length ? Math.min(...prices) : null });
  }
  const collectionMap = new Map<string, { title: string; axis: string | null }>();
  for (const c of collections ?? []) if (!c.deleted_at) collectionMap.set(c.handle.toLowerCase(), { title: c.title, axis: c.axis });
  return { products: productMap, collections: collectionMap, storefrontUrl: shops?.[0]?.storefront_url ?? null };
}

function knownCollections(catalogue: Catalogue) {
  const by = (axis: string) => new Set([...catalogue.collections].filter(([, c]) => c.axis === axis).map(([h]) => h));
  return {
    concerns: by("concern"),
    ranges: new Set([...by("range"), ...SALES_COLLECTION_HANDLES.map((h: string) => h.toLowerCase())]),
    categories: by("category"),
  };
}

const counts = (c: FunnelCounts | undefined | null): FunnelCounts | null =>
  c ? { sessions: c.sessions, cartSessions: c.cartSessions, checkoutSessions: c.checkoutSessions, convertedSessions: c.convertedSessions } : null;

export async function readWebsitePerformance(ctx: InsightsContext, countryParam: string | null): Promise<LivePart<WebsitePerformanceData | null>> {
  if (ctx.marketplaces.isMarketplace(ctx.platform)) return { blockedReason: BLOCKED_MARKETPLACE, value: null };
  try {
    const country = safeCountry(countryParam);
    const compare = ctx.range.preset !== "all";
    const previous = { ...ctx.range, ...ctx.range.previous };
    const ask = (query: string, priority: number) => shopifyql(ctx.shopDomain, query, priority);
    const [traffic, previousTraffic, countryRows, pageRows, previousPageRows, channelRows, deviceRows, catalogue, sales] = await Promise.all([
      ask(trafficQuery(ctx.range, { country }), PRIORITY.headline),
      compare ? ask(trafficQuery(previous, { country }), PRIORITY.detail) : Promise.resolve(null),
      ask(countriesQuery(ctx.range), PRIORITY.detail),
      ask(landingPagesQuery(ctx.range, PAGE_LIMIT), PRIORITY.headline),
      compare ? ask(landingPagesQuery(previous, PAGE_LIMIT * 2), PRIORITY.detail) : Promise.resolve(null),
      ask(landingChannelQuery(ctx.range), PRIORITY.detail),
      ask(landingDeviceQuery(ctx.range), PRIORITY.detail),
      readCatalogue(ctx.shopId),
      liveSales(ctx),
    ]);

    const known = knownCollections(catalogue);
    const byGroup = landingByGroup(channelRows) as Map<string, Map<ChannelGroup, FunnelCounts>>;
    const byDevice = landingByDevice(deviceRows) as Map<string, Map<string, FunnelCounts>>;
    const before = new Map((previousPageRows ? readLandingPages(previousPageRows) : []).map((p: { path: string }) => [p.path, p as unknown as FunnelCounts]));

    const pages: LandingPage[] = readLandingPages(pageRows).map((page: Record<string, unknown> & FunnelCounts & { path: string; type: string }) => {
      const productHandle = handleOf(page.path, "products");
      const collectionHandle = handleOf(page.path, "collections");
      const product = productHandle ? catalogue.products.get(productHandle) : undefined;
      const collection = collectionHandle ? catalogue.collections.get(collectionHandle) : undefined;
      return {
        path: page.path,
        type: page.type,
        title: product?.title ?? collection?.title ?? null,
        category: page.type === "Collection" && collectionHandle ? collectionCategory(collectionHandle, known) : null,
        priceBand: page.type === "Product" ? priceBand(product?.price ?? null) : null,
        sessions: page.sessions,
        cartSessions: page.cartSessions,
        checkoutSessions: page.checkoutSessions,
        convertedSessions: page.convertedSessions,
        visitors: page.visitors as number | null,
        bounceRate: page.bounceRate as number | null,
        cartRate: page.cartRate as number | null,
        checkoutRate: page.checkoutRate as number | null,
        conversionRate: page.conversionRate as number | null,
        checkoutCompletion: page.checkoutCompletion as number | null,
        previous: compare ? counts(before.get(page.path)) ?? { sessions: 0, cartSessions: 0, checkoutSessions: 0, convertedSessions: 0 } : null,
        byGroup: [...(byGroup.get(page.path) ?? new Map())].map(([key, c]) => ({ key, counts: c })).sort((a, b) => b.counts.sessions - a.counts.sessions),
        byDevice: [...(byDevice.get(page.path) ?? new Map())].map(([key, c]) => ({ key, counts: c })).sort((a, b) => b.counts.sessions - a.counts.sessions),
      };
    });

    const aov = sales.value.storefront.current?.averageOrderValue ?? null;
    const titles = new Map(pages.map((p) => [p.path, p.title]));
    const opportunities: Opportunity[] = (scoreOpportunities(pages, { aov, byGroup, byDevice }) as Omit<Opportunity, "title">[]).map((o) => ({
      ...o,
      title: titles.get(o.path) ?? null,
    }));

    return {
      blockedReason: null,
      value: {
        country,
        countries: countryRows.map((r) => String(r.session_country ?? "")).filter(Boolean),
        traffic: readTraffic(traffic) as TrafficRow[],
        previousTraffic: previousTraffic ? (readTraffic(previousTraffic) as TrafficRow[]) : null,
        pages,
        storefrontUrl: catalogue.storefrontUrl,
        aov,
        opportunities,
      },
    };
  } catch (error) {
    return { blockedReason: error instanceof Error ? error.message : String(error), value: null };
  }
}
