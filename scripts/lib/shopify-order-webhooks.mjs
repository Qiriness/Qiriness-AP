/**
 * Order webhooks: Shopify tells us an order changed, and we re-read it.
 *
 * WHY THIS EXISTS. The nightly sync is the only thing that has ever written an
 * order, so between runs the desk reads a table that is up to a day behind — and
 * on 2026-09-12 it was two days behind without anyone noticing. A webhook closes
 * that to seconds for the changes Shopify chooses to tell us about.
 *
 * IT DOES NOT REPLACE THE NIGHTLY. Deliveries are dropped, retried and reordered,
 * and a webhook that arrives while this server is redeploying is simply gone
 * after 48 hours of retries. The nightly stays as the reconciliation pass that
 * catches whatever the stream missed; this is the fast path, not the record.
 *
 * WHAT IT REFUSES TO DO IS GUESS. Every failure this can have — a bad signature,
 * an unknown shop, an order it cannot read — resolves to a recorded
 * `integration_events` row and an HTTP status Shopify knows how to act on. There
 * is no path where a webhook quietly writes a partial row.
 */

import {
  hashIdentifier,
  finishIntegrationEvent,
  recordDataAccessEvent,
  sanitizeError,
  startIntegrationEvent
} from './compliance-audit.mjs';
import { fetchOrderByLegacyId } from './shopify-admin-client.mjs';
import { readRetentionPolicy } from './order-retention.mjs';
import { mapOrder } from './shopify-sync-mappers.mjs';
import { supabaseSelect, supabaseUpsert } from './supabase-rest-client.mjs';

/**
 * The topics this handles. `orders/paid` is included because payment is what
 * moves an order out of the state the desk asks about most; `refunds/create`
 * because a refund changes the order without changing the order's own topic.
 */
export const ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/paid',
  'refunds/create'
]);

/**
 * The order this webhook is about, as Shopify's numeric id.
 *
 * A REFUND PAYLOAD IS NOT AN ORDER PAYLOAD: its `id` is the refund's, and the
 * order is `order_id`. Reading `id` for every topic would have this fetching a
 * refund id as though it were an order, finding nothing, and reporting a clean
 * skip — the worst kind of wrong, because it looks like it worked.
 */
export function orderIdFromPayload(topic, payload) {
  const raw = topic === 'refunds/create' ? payload?.order_id : payload?.id;
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  return String(raw);
}

/**
 * Whether an order we have just read is worth writing over what is stored.
 *
 * Re-reading the order already removes most of the ordering problem — we always
 * fetch current state, so a webhook delivered late cannot carry stale data. What
 * is left is CONCURRENCY: two deliveries for one order, handled at once, can
 * read in one order and write in the other. Comparing what we read against what
 * is stored closes that, and costs one column.
 */
export function isStale(fetchedUpdatedAt, storedUpdatedAt) {
  if (!storedUpdatedAt || !fetchedUpdatedAt) {
    return false;
  }
  const fetched = Date.parse(fetchedUpdatedAt);
  const stored = Date.parse(storedUpdatedAt);
  if (Number.isNaN(fetched) || Number.isNaN(stored)) {
    return false;
  }
  return fetched < stored;
}

export async function processOrderWebhook({
  rawBody,
  headers,
  config,
  supabase,
  shopify,
  verifyHmac,
  now = new Date()
}) {
  if (!verifyHmac(rawBody, headers, config.shopifyWebhookSecret)) {
    // 401 AND NOTHING WRITTEN. An unsigned request has not proved it is Shopify,
    // so it must not be able to create rows — including audit rows, which would
    // otherwise be a table anyone on the internet could fill.
    return { statusCode: 401, body: { error: 'Invalid Shopify webhook HMAC.' } };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return { statusCode: 400, body: { error: 'Webhook body is not JSON.' } };
  }

  const topic = headerValue(headers, 'x-shopify-topic');
  if (!ORDER_TOPICS.has(topic)) {
    return { statusCode: 400, body: { error: `Unsupported order topic: ${topic || 'missing'}` } };
  }

  const shopDomain = headerValue(headers, 'x-shopify-shop-domain');
  const webhookId = headerValue(headers, 'x-shopify-webhook-id') || hashIdentifier(rawBody);
  const eventKey = `shopify-webhook:${webhookId}`;
  const shopRow = await findShop(supabase, shopDomain);

  if (!shopRow) {
    // 200, NOT AN ERROR. Retrying cannot conjure a shop row, and a non-2xx would
    // buy 48 hours of retries for a delivery that can never succeed. The nightly
    // is what fills this gap once the shop exists.
    return { statusCode: 200, body: { status: 'unknown_shop', shop_domain: shopDomain } };
  }

  const event = await startIntegrationEvent(supabase, {
    shop_id: shopRow.id,
    event_key: eventKey,
    source: 'shopify',
    event_type: 'order_webhook',
    topic,
    status: 'processing',
    idempotency_key: webhookId,
    actor_type: 'system',
    metadata: {
      shop_domain: shopDomain,
      api_version: headerValue(headers, 'x-shopify-api-version'),
      triggered_at: headerValue(headers, 'x-shopify-triggered-at')
    }
  });

  // THE REPLAY GUARD. Shopify retries when it is unsure a delivery landed, so the
  // same webhook id arrives more than once as a matter of course. A finished row
  // for this id means the work is done; saying so is cheaper and safer than
  // doing it twice.
  if (event.duplicate && ['completed', 'skipped'].includes(event.row.status)) {
    return { statusCode: 200, body: { status: 'duplicate', event_key: eventKey } };
  }

  try {
    const legacyId = orderIdFromPayload(topic, payload);
    if (!legacyId) {
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'skipped',
        error_summary: `No order id on a ${topic} payload.`
      });
      return { statusCode: 400, body: { error: 'Webhook payload carries no order id.' } };
    }

    const order = await fetchOrderByLegacyId(shopify, legacyId);
    if (!order) {
      // Deleted between the webhook and this read, or not ours. Not an error, and
      // not something a retry improves.
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'skipped',
        counts: { orders: 0 },
        error_summary: `Order ${legacyId} could not be read back from Shopify.`
      });
      return { statusCode: 200, body: { status: 'not_found', order_id: legacyId } };
    }

    const stored = await supabaseSelect(
      supabase,
      'orders',
      { shop_id: shopRow.id, shopify_order_id: order.id },
      'shopify_updated_at'
    );

    if (isStale(order.updatedAt, stored[0]?.shopify_updated_at)) {
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'skipped',
        counts: { orders: 0 },
        error_summary: 'A newer version of this order is already stored.'
      });
      return { statusCode: 200, body: { status: 'stale', order_id: legacyId } };
    }

    const customerIdByShopifyId = await loadCustomerId(supabase, shopRow.id, order.customer?.id);
    const row = mapOrder(
      order,
      shopRow.id,
      now.toISOString(),
      customerIdByShopifyId,
      readRetentionPolicy(shopRow)
    );

    await supabaseUpsert(supabase, 'orders', [row], 'shop_id,shopify_order_id');

    // The same trail the paged sync writes: what was read and why, never who.
    await recordDataAccessEvent(supabase, {
      shop_id: shopRow.id,
      integration_event_id: event.row.id,
      action: 'shopify_order_webhook',
      resource_type: 'orders',
      resource_id_hash: hashIdentifier(`${shopRow.shop_domain}:${legacyId}`),
      purpose: 'Shopify order webhook',
      metadata: { topic, page_count: 1, dry_run: false }
    });

    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'completed',
      counts: { orders: 1 }
    });

    return { statusCode: 200, body: { status: 'ok', order: row.name, order_id: legacyId } };
  } catch (error) {
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'failed',
      error_summary: sanitizeError(error)
    });
    // 500 SO SHOPIFY RETRIES. This is the one failure that a later attempt can
    // genuinely fix — a throttle, a Supabase blip, a deploy mid-flight.
    return { statusCode: 500, body: { error: 'Webhook processing failed.' } };
  }
}

async function findShop(supabase, shopDomain) {
  if (!shopDomain) {
    return null;
  }
  const rows = await supabaseSelect(supabase, 'shops', { shop_domain: shopDomain }, '*');
  return rows[0] || null;
}

/**
 * One customer, not 58,000. The paged sync loads the whole map because it is
 * about to write every order; a webhook needs exactly the one link.
 */
async function loadCustomerId(supabase, shopId, shopifyCustomerId) {
  if (!shopifyCustomerId) {
    return new Map();
  }
  const rows = await supabaseSelect(
    supabase,
    'customers',
    { shop_id: shopId, shopify_customer_id: shopifyCustomerId },
    'id,shopify_customer_id'
  );
  return new Map(rows.map((row) => [row.shopify_customer_id, row.id]));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}
