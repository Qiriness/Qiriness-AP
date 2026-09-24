/**
 * One ShopifyQL query per request, and what Shopify said about it.
 *
 * WHY NOT `shopifyGraphql`. That helper retries a throttled document WHOLE on
 * an exponential backoff sized for the GraphQL point bucket. ShopifyQL is
 * throttled on a DIFFERENT bucket — 1,000 points a minute that reset on the
 * minute (`extensions.cost.windowResetAt`) — so the backoff guessed wrong, and
 * retrying a many-query document re-spent every query that had already been
 * answered. Measured 2026-09-24: a 6-month panel's nine-query document drained
 * the bucket, and the 7-day and 24-hour panels asked right after it came back
 * throttled on 7 and 9 of their 9 queries.
 *
 * Here one query is one request, a throttled answer says WHEN to come back,
 * and nothing that succeeded is ever asked twice.
 */

/** Longest a single HTTP request may take before it counts as a failure. */
export const REQUEST_TIMEOUT_MS = 20_000;

const DOCUMENT = `query StorefrontAnalytics($q: String!) { a: shopifyqlQuery(query: $q) { parseErrors tableData { rows } } }`;

/**
 * An HTTP status and body -> one of:
 *   { kind: 'answer', rows, parseErrors, cost }
 *   { kind: 'throttled', resetAt, requested, maximum }   resetAt: ms epoch or null
 *   { kind: 'error', message }
 * Pure, so the shapes measured on 2026-07 are pinned by tests.
 */
export function classifyShopifyqlResponse(status, payload) {
  if (status === 429 || status >= 500) return { kind: 'throttled', resetAt: null, requested: null, maximum: null };
  if (status < 200 || status >= 300) return { kind: 'error', message: `HTTP ${status}` };

  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const throttle = errors.find((e) => e?.extensions?.code === 'THROTTLED' || /throttled|rate limited/i.test(e?.message ?? ''));
  if (throttle) {
    const cost = throttle.extensions?.cost ?? {};
    const reset = Date.parse(cost.windowResetAt ?? '');
    return {
      kind: 'throttled',
      resetAt: Number.isFinite(reset) ? reset : null,
      requested: typeof cost.requestedQueryCost === 'number' ? cost.requestedQueryCost : null,
      maximum: typeof cost.maximumAvailable === 'number' ? cost.maximumAvailable : null
    };
  }
  if (errors.length > 0) {
    return { kind: 'error', message: `Shopify GraphQL error: ${errors.map((e) => e?.message ?? String(e)).join('; ')}` };
  }

  const answer = payload?.data?.a;
  if (!answer) return { kind: 'error', message: 'Shopify returned no answer for the query.' };
  return {
    kind: 'answer',
    rows: Array.isArray(answer.tableData?.rows) ? answer.tableData.rows : [],
    parseErrors: Array.isArray(answer.parseErrors) ? answer.parseErrors.map(String) : [],
    cost: payload?.extensions?.shopifyqlCost ?? null
  };
}

/**
 * When to try a throttled query again: Shopify's own reset plus a margin, and
 * never sooner than a second from now, so a local clock running ahead of
 * Shopify's cannot spin.
 */
export function retryAt(throttled, now = Date.now()) {
  const floor = now + 1000;
  if (throttled.resetAt === null) return now + 2000;
  return Math.max(throttled.resetAt + 500, floor);
}

/** One attempt. Never throws: a dropped connection is an `error`. */
export async function postShopifyql(client, query, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(client.endpoint, {
      method: 'POST',
      // Next's Data Cache would otherwise replay the first answer for ever.
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': client.token },
      body: JSON.stringify({ query: DOCUMENT, variables: { q: query } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => null);
    return classifyShopifyqlResponse(response.status, payload);
  } catch (error) {
    return { kind: 'error', message: `Shopify request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Ask until answered, waiting out the analytics bucket between attempts. For
 * the nightly sync and the verification script, which can afford to wait; the
 * dashboard uses its own queue (web/lib/server/insights/shopifyql.ts) so that
 * cards wait in priority order. Throws on a refusal, an error, or `deadlineMs`.
 */
export async function askShopifyql(client, query, { deadlineMs = 5 * 60_000, log = () => {} } = {}) {
  const deadline = Date.now() + deadlineMs;
  let failures = 0;
  for (;;) {
    const result = await postShopifyql(client, query);
    if (result.kind === 'answer') {
      if (result.parseErrors.length > 0) throw new Error(`ShopifyQL refused the query: ${result.parseErrors.join('; ')}`);
      return result.rows;
    }
    let wait;
    if (result.kind === 'throttled') {
      wait = retryAt(result) - Date.now();
      log(`ShopifyQL throttled; retrying in ${Math.round(wait / 1000)}s`);
    } else {
      failures += 1;
      if (failures >= 3) throw new Error(result.message);
      wait = 2000 * failures;
    }
    if (Date.now() + wait > deadline) throw new Error(`ShopifyQL did not answer within ${Math.round(deadlineMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
