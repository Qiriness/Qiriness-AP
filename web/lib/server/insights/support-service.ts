/**
 * The Support panel's reads, over the range in the URL: how much mail arrives,
 * what it is about, how it feels, how fast it is answered — and the topic map.
 *
 * MAIL IS ONLY AS CURRENT AS THE LAST TIME THE WORKER RAN. The worker is run by
 * hand for now, so a range can reach past the newest synced message. Buckets
 * after that are drawn as missing, and while the mailbox is behind, the panel
 * does not compare against the previous period or divide by orders: tickets
 * from half a range over orders from all of it is a rate that only looks low.
 *
 * Tickets belong to no sales channel, so the platform filter does not apply.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows.
 */

import { RPC, T } from "../../../../scripts/lib/tables.mjs";
import { supabaseHeaders } from "../../../../scripts/lib/supabase-rest-client.mjs";
import type {
  KnowledgeCategory,
  SupportCategoryRow,
  SupportPanel,
  SupportSummary,
  TopicCluster,
  TopicMap,
} from "../../types";
import { corpusBaseline, hasCorpusDrifted } from "../../insights-support";
import { orderArgs, rangeArgs, type InsightsContext } from "./context";
import { previousCovered, toSeries, type Coverage } from "./series";
import { callRpc, callRpcOne, count, getSupabaseClient, num, readView } from "./shared";

/** Every ticket ever, for the topic map's colours — the map is not a ranged thing. */
const ALL_TIME = { from: "2000-01-01T00:00:00", to: "2100-01-01T00:00:00" };

export async function getSupportPanel(ctx: InsightsContext): Promise<SupportPanel> {
  const coverage: Coverage = { from: ctx.freshness.mailFrom, through: ctx.freshness.mailThrough };
  const mailCurrent = ctx.freshness.items.find((item) => item.id === "mail")?.tone === "ok";
  const comparable = mailCurrent && previousCovered(ctx.range, coverage);

  const [current, previous, seriesRows, categoryRows, ordersNow, ordersBefore, runRows, allCategories, allTime] =
    await Promise.all([
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_SUMMARY, rangeArgs(ctx)),
      comparable
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_SUMMARY, rangeArgs(ctx, ctx.range.previous))
        : Promise.resolve(null),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_SERIES, { ...rangeArgs(ctx), p_grain: ctx.range.grain }),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_CATEGORIES, rangeArgs(ctx)),
      // The contact-rate denominator: every platform, since a ticket has none.
      mailCurrent
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, ctx.range, "all"))
        : Promise.resolve(null),
      comparable
        ? callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_ORDERS_SUMMARY, orderArgs(ctx, ctx.range.previous, "all"))
        : Promise.resolve(null),
      readView<Record<string, unknown>>(T.CLUSTER_RUNS, ctx.shopId, { order: "built_at.desc", limit: 1 }),
      callRpc<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_CATEGORIES, rangeArgs(ctx, ALL_TIME)),
      callRpcOne<Record<string, unknown>>(RPC.INSIGHTS_SUPPORT_SUMMARY, rangeArgs(ctx, ALL_TIME)),
    ]);

  return {
    summary: { current: mapSummary(current ?? {}), previous: previous ? mapSummary(previous) : null },
    orders: {
      current: ordersNow ? count(ordersNow.orders) : null,
      previous: ordersBefore ? count(ordersBefore.orders) : null,
    },
    tickets: toSeries(
      ctx.range,
      seriesRows.map((row) => ({ ...row, bucket: String(row.bucket) }) as Record<string, unknown> & { bucket: string }),
      (row) => (row ? count(row.tickets) : 0),
      coverage
    ),
    medianReply: toSeries(
      ctx.range,
      seriesRows.map((row) => ({ ...row, bucket: String(row.bucket) }) as Record<string, unknown> & { bucket: string }),
      (row) => (row ? num(row.p50_reply_hours) : null),
      coverage
    ),
    categories: categoryRows.map(mapCategory),
    topicMap: await loadTopicMap(ctx.shopId, runRows[0] ?? null),
    topicCategories: allCategories.map(mapCategory),
    mailThrough: ctx.freshness.mailThrough,
    mailBehind: !mailCurrent,
    allTimeMarketable: allTime ? count(allTime.no_order_marketable) : 0,
  };
}

function mapSummary(row: Record<string, unknown>): SupportSummary {
  return {
    tickets: count(row.tickets),
    categorised: count(row.categorised),
    stillOpen: count(row.still_open),
    unhappy: count(row.unhappy),
    veryUnhappy: count(row.very_unhappy),
    levelThree: count(row.level_three),
    repliesMeasured: count(row.replies_measured),
    p50ReplyHours: num(row.p50_reply_hours),
    p90ReplyHours: num(row.p90_reply_hours),
    repliedWithin24h: count(row.replied_within_24h),
    buyerTickets: count(row.buyer_tickets),
    noOrderTickets: count(row.no_order_tickets),
    unknownTickets: count(row.unknown_tickets),
    noOrderCustomers: count(row.no_order_customers),
    noOrderDeliverable: count(row.no_order_deliverable),
    noOrderMarketable: count(row.no_order_marketable),
  };
}

function mapCategory(row: Record<string, unknown>): SupportCategoryRow {
  return {
    category: (row.category as KnowledgeCategory | null) ?? null,
    tickets: count(row.tickets),
    stillOpen: count(row.still_open),
    unhappy: count(row.unhappy),
    levelThree: count(row.level_three),
    // Null, not 0: on a 1-4 scale a zero sorts as the happiest subject.
    meanHappiness: num(row.mean_happiness),
    buyerTickets: count(row.buyer_tickets),
    noOrderTickets: count(row.no_order_tickets),
    unknownTickets: count(row.unknown_tickets),
  };
}

// --- topic map --------------------------------------------------------------

async function loadTopicMap(shopId: string, runRow: Record<string, unknown> | null): Promise<TopicMap | null> {
  if (!runRow) return null;

  const runId = String(runRow.id);
  const messageCount = count(runRow.message_count);
  const internalExcluded = count(runRow.internal_excluded);

  const [clusterRows, liveMessageCount] = await Promise.all([
    // Filtered to one run, so bounded by that run's topics.
    readView<Record<string, unknown>>(T.TICKET_CLUSTERS, shopId, {
      order: "size.desc",
      filters: { run_id: runId },
    }),
    countCorpusMessages(shopId),
  ]);

  return {
    runId,
    builtAt: String(runRow.built_at),
    threshold: num(runRow.threshold) ?? 0,
    minSize: count(runRow.min_size),
    messageCount,
    internalExcluded,
    subjectCount: count(runRow.subject_count),
    topicCount: count(runRow.topic_count),
    clusters: clusterRows.map(mapCluster),
    liveMessageCount,
    stale: hasCorpusDrifted(liveMessageCount, corpusBaseline(messageCount, internalExcluded)),
  };
}

function mapCluster(row: Record<string, unknown>): TopicCluster {
  return {
    id: String(row.id),
    subject: String(row.subject),
    clusterIndex: count(row.cluster_index),
    size: count(row.size),
    cohesion: num(row.cohesion),
    excerpt: (row.representative_excerpt as string) ?? null,
  };
}

/**
 * How many messages the clustering job would load right now — a COUNT via
 * `Prefer: count=exact` on a HEAD, never a read of 1536-float vectors. The
 * filters mirror `loadEmbeddedMessages` in cluster-ticket-messages.mjs, or the
 * baseline drifts for reasons unrelated to new mail. Null on any failure: a
 * staleness check that could not run must not declare the map stale.
 */
async function countCorpusMessages(shopId: string): Promise<number | null> {
  try {
    const client = getSupabaseClient();
    const params = new URLSearchParams({
      select: "id,tickets!inner(id)",
      shop_id: `eq.${shopId}`,
      direction: "eq.inbound",
      embedding: "not.is.null",
      deleted_at: "is.null",
      "tickets.category": "not.is.null",
      "tickets.deleted_at": "is.null",
    });

    const response = await fetch(`${client.baseUrl}/${T.TICKET_MESSAGES}?${params.toString()}`, {
      method: "HEAD",
      // Load-bearing: Next caches Server Component fetches by URL otherwise.
      cache: "no-store",
      headers: supabaseHeaders(client, { Prefer: "count=exact" }),
    });

    if (!response.ok) return null;
    const total = response.headers.get("content-range")?.split("/")[1];
    if (!total || total === "*") return null;
    const parsed = Number(total);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
