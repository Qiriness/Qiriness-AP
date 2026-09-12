import { NextResponse } from "next/server";
import { loadConfig } from "../../../../../scripts/lib/sync-config.mjs";
import { createShopifyClient } from "../../../../../scripts/lib/shopify-admin-client.mjs";
import { createSupabaseClient } from "../../../../../scripts/lib/supabase-rest-client.mjs";
import {
  processComplianceWebhook,
  verifyShopifyWebhookHmac,
} from "../../../../../scripts/lib/shopify-compliance-webhooks.mjs";
import {
  ORDER_TOPICS,
  processOrderWebhook,
} from "../../../../../scripts/lib/shopify-order-webhooks.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE DOOR SHOPIFY KNOCKS ON. One URL for every topic, dispatched by
 * `x-shopify-topic`: order changes go to the order handler, the three mandatory
 * privacy topics to the compliance handler that has existed since March with no
 * way to be reached.
 *
 * THE RAW BODY, NOT `request.json()`. The HMAC is computed over the exact bytes
 * Shopify sent. Parsing to JSON and re-serialising changes them — key order,
 * whitespace, number formatting — and every signature check then fails for
 * reasons that look like a wrong secret. `request.text()` is load-bearing.
 *
 * IT IS PUBLIC, AND THAT IS DELIBERATE. `middleware.ts` lets this path through
 * without a session, because a session cookie is not how Shopify proves who it
 * is. The signature is, and it is a stronger proof: it covers the body as well
 * as the sender.
 *
 * ALWAYS ANSWER, AND ANSWER FAST. Shopify gives a webhook five seconds and reads
 * any non-2xx as "try again for 48 hours". The handlers below therefore return
 * 200 for everything a retry cannot fix (an unknown shop, a deleted order, a
 * replay) and 500 only for what it can.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const topic = request.headers.get("x-shopify-topic");

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // A misconfigured server is our fault, not Shopify's, and a retry may well
    // succeed once the variable is set — so this is a 500, not a 400.
    console.error("shopify webhook: configuration error", (error as Error).message);
    return NextResponse.json({ error: "Webhook endpoint is not configured." }, { status: 500 });
  }

  const supabase = createSupabaseClient(config);

  if (topic && ORDER_TOPICS.has(topic)) {
    const shopify = await createShopifyClient(config);
    const result = await processOrderWebhook({
      rawBody: Buffer.from(raw, "utf8"),
      headers: request.headers,
      config,
      supabase,
      shopify,
      verifyHmac: verifyShopifyWebhookHmac,
    });
    return NextResponse.json(result.body, { status: result.statusCode });
  }

  const result = await processComplianceWebhook({
    rawBody: Buffer.from(raw, "utf8"),
    headers: request.headers,
    config,
    supabase,
  });
  return NextResponse.json(result.body, { status: result.statusCode });
}

/**
 * A GET here is a person checking the URL is alive, never Shopify. Answering
 * something honest beats a 405 that reads like a broken deployment.
 */
export function GET() {
  return NextResponse.json({ status: "ready", accepts: "POST from Shopify" });
}
