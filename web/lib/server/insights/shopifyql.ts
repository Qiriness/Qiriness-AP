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
 * Nothing here throws synchronously; each promise rejects with a reason the
 * cards print. Server-only.
 */

import { createShopifyClient } from "../../../../scripts/lib/shopify-admin-client.mjs";
import { postShopifyql, retryAt } from "../../../../scripts/lib/shopifyql-client.mjs";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";

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

const cache = new Map<string, { at: number; value: Promise<Row[]> }>();
const queue: Job[] = [];
let inFlight = 0;
let seq = 0;
/** Nothing is sent before this instant: the bucket said it was empty until then. */
let gateUntil = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

let shopifyClient: Promise<{ endpoint: string; token: string }> | null = null;

/**
 * One Shopify client for the process: without an admin token, creating one is
 * an OAuth exchange, and that should not sit in front of every card.
 */
function client() {
  if (!shopifyClient) {
    shopifyClient = createShopifyClient(loadConfig(process.env as Record<string, string | undefined>)).catch(
      (error: unknown) => {
        shopifyClient = null;
        throw error;
      }
    );
  }
  return shopifyClient;
}

/**
 * The rows for one ShopifyQL query. Rejects on a refusal (Shopify saying the
 * query is wrong, never "the store was quiet"), an error, or the deadline.
 */
export function shopifyql(query: string, priority: number, deadlineMs = DEADLINE_MS): Promise<Row[]> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = new Promise<Row[]>((resolve, reject) => {
    queue.push({ query, priority, seq: seq++, deadline: Date.now() + deadlineMs, resolve, reject });
    pump();
  });
  const entry = { at: Date.now(), value };
  cache.set(query, entry);
  value.then(
    // Fresh from the moment it was ANSWERED, not asked: a query that waited a
    // minute for the bucket should not be stale a minute early.
    () => {
      entry.at = Date.now();
    },
    // A failure is not kept: the next render asks again.
    () => {
      if (cache.get(query) === entry) cache.delete(query);
    }
  );
  return value;
}

function pump() {
  const now = Date.now();
  // A job whose deadline falls before the bucket reopens cannot be answered in
  // time; saying so now beats making the card wait to be told.
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job.deadline <= Math.max(now, gateUntil)) {
      queue.splice(i, 1);
      job.reject(
        new Error(
          "Shopify Analytics' rate limit had no room for this within the time allowed. It frees up every minute — reload to try again."
        )
      );
    }
  }
  if (gateUntil > now) {
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, gateUntil - now);
    }
    return;
  }
  queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  while (inFlight < CONCURRENCY && queue.length > 0 && gateUntil <= Date.now()) {
    const job = queue.shift()!;
    inFlight += 1;
    send(job).finally(() => {
      inFlight -= 1;
      pump();
    });
  }
}

async function send(job: Job) {
  let answer;
  try {
    answer = await postShopifyql(await client(), job.query);
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
    // Back in the queue in its original place; everything waits for the reset.
    gateUntil = Math.max(gateUntil, retryAt(answer));
    queue.push(job);
    return;
  }
  job.reject(new Error(`Shopify Analytics could not be read: ${String(answer.message ?? "unknown error").slice(0, 200)}`));
}
