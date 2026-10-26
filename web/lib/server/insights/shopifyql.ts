/**
 * Every live ShopifyQL query the dashboard makes goes through here: one query
 * per request, a queue in priority order, and a five-minute cache per query.
 *
 * WHY A QUEUE. ShopifyQL is throttled on its own bucket — 1,000 points a
 * minute, resetting on the minute — shared by every panel, tab and report
 * download. Sent all at once, a long range took the whole minute and the next
 * range to render got nothing (measured 2026-09-24: 7 days failed 7 of 9
 * queries straight after a 6-month render). Here a throttled query waits for
 * the reset Shopify names and goes again on its own; an answered one is never
 * re-asked; and the money ladder goes first, because net sales and AOV are the
 * figures the owner reads first.
 *
 * WHY PER QUERY, NOT PER PANEL. Overview and Marketing share the sessions
 * totals, and flipping 30 days -> 6 months -> 30 days should not ask 30 days
 * twice. The cache key is the query text itself.
 *
 * ONE OF EVERYTHING PER SHOP. Two shops' "net sales, last 30 days" are the same
 * query text, so the answer is kept under the shop's domain and the query, never
 * the query alone, or one shop's figures would be served as the other's. Each
 * shop also has its own client, queue and throttle gate: Shopify's bucket is
 * per store, so one shop's busy minute must not hold the other's cards.
 *
 * Nothing here throws synchronously; each promise rejects with a reason the
 * cards print. Server-only.
 */

import { unstable_cache } from "next/cache";
import { createShopifyClient } from "../../../../scripts/lib/shopify-admin-client.mjs";
import { postShopifyql, retryAt } from "../../../../scripts/lib/shopifyql-client.mjs";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";
import { CACHE_TAGS } from "../cache-tags";
import { INSIGHTS_TTL_SECONDS } from "./shared";

export type Row = Record<string, unknown>;

/** Lower goes first. Money first — the owner's rule. */
export const PRIORITY = {
  money: 0,
  headline: 1,
  trend: 2,
  detail: 3,
} as const;

/**
 * How long a card waits for its turn before it gives up and says so. Long
 * enough for two resets of the bucket behind a busy minute: an all-time range
 * can need three windows.
 */
export const DEADLINE_MS = 150_000;

/** The page re-renders itself every five minutes; asking more often than that buys nothing. */
const TTL_MS = 5 * 60 * 1000;

/** Requests in flight at once. More only races the same bucket. */
const CONCURRENCY = 4;

interface Job {
  query: string;
  priority: number;
  seq: number;
  deadline: number;
  resolve: (rows: Row[]) => void;
  reject: (error: Error) => void;
}

/** One shop's queue: its answers, its waiting jobs, its gate and its Shopify client. */
interface ShopQueue {
  domain: string;
  cache: Map<string, { at: number; value: Promise<Row[]> }>;
  queue: Job[];
  inFlight: number;
  seq: number;
  /** Nothing is sent before this instant: the bucket said it was empty until then. */
  gateUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  client: Promise<{ endpoint: string; token: string }> | null;
}

const shops = new Map<string, ShopQueue>();

function shopQueue(domain: string): ShopQueue {
  let state = shops.get(domain);
  if (!state) {
    state = { domain, cache: new Map(), queue: [], inFlight: 0, seq: 0, gateUntil: 0, timer: null, client: null };
    shops.set(domain, state);
  }
  return state;
}

/**
 * One Shopify client per shop for the process: without an admin token, creating
 * one is an OAuth exchange, and that should not sit in front of every card. The
 * same app's credentials, minted for this shop's domain.
 */
function client(state: ShopQueue) {
  if (!state.client) {
    const config = { ...loadConfig(process.env as Record<string, string | undefined>), shopDomain: state.domain };
    state.client = createShopifyClient(config).catch((error: unknown) => {
      state.client = null;
      throw error;
    });
  }
  return state.client;
}

/**
 * The rows for one ShopifyQL query on one shop. Rejects on a refusal (Shopify
 * saying the query is wrong, never "the store was quiet"), an error, or the deadline.
 */
export function shopifyql(shopDomain: string, query: string, priority: number, deadlineMs = DEADLINE_MS): Promise<Row[]> {
  return sharedAnswer(shopDomain, query, priority, deadlineMs);
}

/**
 * IN FRONT OF THE QUEUE, THE SHARED CACHE: one answer per shop and query for
 * every Vercel instance, kept as long as the other Insights reads (15 minutes,
 * the ↻ button clears it). The per-instance cache below only spared a warm
 * instance. On serverless most renders land on a cold one, which asked Shopify
 * again. A refusal or a timeout rejects, and a rejection is never cached.
 */
const sharedAnswer = unstable_cache(
  (shopDomain: string, query: string, priority: number, deadlineMs: number) => answerLive(shopQueue(shopDomain), query, priority, deadlineMs),
  ["insights-shopifyql-by-shop"],
  { revalidate: INSIGHTS_TTL_SECONDS, tags: [CACHE_TAGS.insights] }
);

function answerLive(state: ShopQueue, query: string, priority: number, deadlineMs: number): Promise<Row[]> {
  const hit = state.cache.get(query);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = new Promise<Row[]>((resolve, reject) => {
    state.queue.push({ query, priority, seq: state.seq++, deadline: Date.now() + deadlineMs, resolve, reject });
    pump(state);
  });
  const entry = { at: Date.now(), value };
  state.cache.set(query, entry);
  value.then(
    // Fresh from the moment it was ANSWERED, not asked: a query that waited a
    // minute for the bucket should not be stale a minute early.
    () => {
      entry.at = Date.now();
    },
    // A failure is not kept: the next render asks again.
    () => {
      if (state.cache.get(query) === entry) state.cache.delete(query);
    }
  );
  return value;
}

function pump(state: ShopQueue) {
  const now = Date.now();
  // A job whose deadline falls before the bucket reopens cannot be answered in
  // time; saying so now beats making the card wait to be told.
  for (let i = state.queue.length - 1; i >= 0; i--) {
    const job = state.queue[i];
    if (job.deadline <= Math.max(now, state.gateUntil)) {
      state.queue.splice(i, 1);
      job.reject(new Error("insights.blocked.rateLimit"));
    }
  }
  if (state.gateUntil > now) {
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        pump(state);
      }, state.gateUntil - now);
    }
    return;
  }
  state.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  while (state.inFlight < CONCURRENCY && state.queue.length > 0 && state.gateUntil <= Date.now()) {
    const job = state.queue.shift()!;
    state.inFlight += 1;
    send(state, job).finally(() => {
      state.inFlight -= 1;
      pump(state);
    });
  }
}

async function send(state: ShopQueue, job: Job) {
  let answer;
  try {
    answer = await postShopifyql(await client(state), job.query);
  } catch (error) {
    job.reject(new Error(`Shopify Analytics could not be read: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (answer.kind === "answer") {
    if (answer.parseErrors.length > 0) {
      job.reject(new Error(`Shopify Analytics refused the query: ${answer.parseErrors.join("; ").slice(0, 200)}`));
    } else {
      job.resolve(answer.rows as Row[]);
    }
    return;
  }
  if (answer.kind === "throttled") {
    // Back in the queue in its original place; this shop's jobs wait for the reset.
    state.gateUntil = Math.max(state.gateUntil, retryAt(answer));
    state.queue.push(job);
    return;
  }
  job.reject(new Error(`Shopify Analytics could not be read: ${String(answer.message ?? "unknown error").slice(0, 200)}`));
}
