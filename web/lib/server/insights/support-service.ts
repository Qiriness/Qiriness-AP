/**
 * The Support panel's reads: how much mail arrives, what it is about, how it
 * feels, how fast it is answered — and the topic map behind all of it.
 *
 * THE DENOMINATOR IS THE PRODUCT HERE. Support has three different populations
 * hiding behind the word "tickets", and this service resolves all three rather
 * than letting a component pick one by accident:
 *   214  live tickets                                     (support_by_category)
 *   203  of those have a synced inbound message           (ticket_reply_times)
 *   101  of those got an outbound reply after it          (reply_hours not null)
 * A mean reply time is therefore computed over 101 threads, not 214, and the
 * panel says so on the tile. An unstated denominator is the specific failure
 * this panel exists to avoid — "we answer in 67 hours" reads as a fact about
 * the desk when it is a fact about the half of the desk we can see.
 *
 * Server-only; see ./shared.ts for why nothing here pages rows and reduces.
 */

import { T, V } from "../../../../scripts/lib/tables.mjs";
import type {
  KnowledgeCategory,
  SupportCategoryRow,
  SupportMonth,
  SupportPanel,
  SupportReplyStats,
  TopicCluster,
  TopicMap,
} from "../../types";
import {
  corpusBaseline,
  foldByCategory,
  hasCorpusDrifted,
  percentileCont,
  type SupportCategoryPair,
} from "../../insights-support";
import { count, getSupabaseClient, num, readView } from "./shared";

export async function getSupportPanel(shopId: string): Promise<SupportPanel> {
  const [monthRows, categoryRows, replyRows, runRows] = await Promise.all([
    readView<Record<string, unknown>>(V.SUPPORT_BY_MONTH, shopId, { order: "month.asc" }),
    readView<Record<string, unknown>>(V.SUPPORT_BY_CATEGORY, shopId, { order: "tickets.desc" }),
    // The one read in the Insights section that returns per-entity rows rather
    // than an aggregate, and it is safe for a reason worth stating: this view
    // is one row per live ticket, so it is bounded by the ticket table — 203
    // rows today against readView's 500 cap, and support volume is tens of
    // tickets a month. p50 and p90 over a bounded set are cheaper to compute in
    // TypeScript than as two more percentile views, and the reply section needs
    // the raw values anyway to state its own denominator. If ticket volume ever
    // approaches the cap this must move back into SQL as an aggregate; nothing
    // else on any panel is allowed to read rows like this.
    readView<Record<string, unknown>>(V.TICKET_REPLY_TIMES, shopId, { order: "ticket_id.asc" }),
    readView<Record<string, unknown>>(T.CLUSTER_RUNS, shopId, { order: "built_at.desc", limit: 1 }),
  ]);

  const byCategory = foldByCategory(categoryRows.map(mapCategoryPair));
  const byMonth = monthRows.map(mapMonth);
  const totals = summariseTotals(byCategory, byMonth);

  return {
    byMonth,
    byCategory,
    replies: replyStats(replyRows, totals?.tickets ?? 0),
    topicMap: await loadTopicMap(shopId, runRows[0] ?? null),
    totals,
  };
}

// --- months -----------------------------------------------------------------

function mapMonth(row: Record<string, unknown>): SupportMonth {
  return {
    month: String(row.month),
    tickets: count(row.tickets),
    unhappy: count(row.unhappy),
    veryUnhappy: count(row.very_unhappy),
    levelThree: count(row.level_three),
    stillOpen: count(row.still_open),
    meanHappiness: num(row.mean_happiness),
    p50ReplyHours: num(row.p50_reply_hours),
    repliedWithin24h: count(row.replied_within_24h),
    repliesMeasured: count(row.replies_measured),
  };
}

// --- categories -------------------------------------------------------------

function mapCategoryPair(row: Record<string, unknown>): SupportCategoryPair {
  return {
    category: (row.category as KnowledgeCategory | null) ?? null,
    requestKind: (row.request_kind as string | null) ?? null,
    tickets: count(row.tickets),
    stillOpen: count(row.still_open),
    unhappy: count(row.unhappy),
    levelThree: count(row.level_three),
    meanHappiness: num(row.mean_happiness),
  };
}

/**
 * Headline counts, summed from the folded subject rows rather than read from a
 * fifth view.
 *
 * This is not the row-paging mistake `shared.ts` warns about: the input is a
 * dozen already-aggregated rows, one per subject, and every ticket appears in
 * exactly one of them because the view groups on the subject axis. Summing
 * aggregates is arithmetic; paging a table to count it is the thing that goes
 * wrong. Deliberately taken from the category view and not the month view —
 * `support_by_month` drops tickets with no `first_message_at`, so it would
 * report a smaller total for no reason a reader could see. The one exception is
 * `veryUnhappy` — happiness = 4 is split out only by the month view, so it is
 * summed there, and it is a subset of `unhappy` rather than a rival total.
 */
function summariseTotals(byCategory: SupportCategoryRow[], byMonth: SupportMonth[]) {
  if (byCategory.length === 0) return null;
  const totals = byCategory.reduce(
    (acc, row) => ({
      tickets: acc.tickets + row.tickets,
      open: acc.open + row.stillOpen,
      unhappy: acc.unhappy + row.unhappy,
    }),
    { tickets: 0, open: 0, unhappy: 0 }
  );
  return { ...totals, veryUnhappy: byMonth.reduce((sum, m) => sum + m.veryUnhappy, 0) };
}

// --- reply times ------------------------------------------------------------

/**
 * First-response statistics with the population they were computed over.
 *
 * `total` is every live ticket, not the number of rows in the view: the view
 * itself already excludes the eleven tickets with no synced inbound message,
 * and quoting its row count as the denominator would quietly shrink the
 * population to make the coverage look better than it is.
 */
export function replyStats(
  rows: Record<string, unknown>[],
  totalTickets: number
): SupportReplyStats | null {
  if (rows.length === 0 && totalTickets === 0) return null;

  const measured = rows
    .map((row) => num(row.reply_hours))
    .filter((value): value is number => value !== null);

  return {
    measured: measured.length,
    total: Math.max(totalTickets, rows.length),
    p50Hours: percentileCont(measured, 0.5),
    p90Hours: percentileCont(measured, 0.9),
    within24h: measured.filter((value) => value <= 24).length,
  };
}

// --- topic map --------------------------------------------------------------

async function loadTopicMap(
  shopId: string,
  runRow: Record<string, unknown> | null
): Promise<TopicMap | null> {
  if (!runRow) return null;

  const runId = String(runRow.id);
  const messageCount = count(runRow.message_count);
  const internalExcluded = count(runRow.internal_excluded);

  const [clusterRows, liveMessageCount] = await Promise.all([
    // Filtered to one run, so this is 46 rows and cannot grow with history —
    // every rebuild writes a new run_id rather than appending to this one.
    readView<Record<string, unknown>>(T.TICKET_CLUSTERS, shopId, {
      order: "size.desc",
      filters: { run_id: runId },
    }),
    countCorpusMessages(shopId),
  ]);

  const baseline = corpusBaseline(messageCount, internalExcluded);

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
    stale: hasCorpusDrifted(liveMessageCount, baseline),
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
 * How many messages the clustering job would load if it ran right now.
 *
 * A COUNT, NOT A READ. The corpus is 296 embedded messages each carrying a
 * 1536-float vector; pulling them to length-check an array would be several
 * megabytes over the wire on every page view, to learn one integer. PostgREST
 * returns that integer in `Content-Range` when asked with `Prefer: count=exact`
 * and a HEAD, so no row body crosses the network at all.
 *
 * The filters mirror `loadEmbeddedMessages` in cluster-ticket-messages.mjs —
 * inbound, embedded, not deleted, and on a categorised ticket — because a
 * baseline computed from a different population would drift against the run for
 * reasons that have nothing to do with new mail. The `tickets!inner` embed is
 * how that last condition is expressed without a second round trip.
 *
 * Null on any failure. A staleness banner that cannot check must say it cannot
 * check; guessing zero would declare every map stale the first time the network
 * blinked.
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
      // Load-bearing, not defensive. Next patches global fetch inside Server
      // Components and caches the response for a year keyed on the URL, so
      // without this the drift check would answer with whatever it saw the
      // first time the page was ever rendered and never notice a rebuild.
      cache: "no-store",
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        Prefer: "count=exact",
      },
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
