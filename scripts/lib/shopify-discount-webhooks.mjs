/**
 * Discount webhooks: Shopify tells us a discount changed, and we re-read it.
 *
 * WHY THIS EXISTS. The nightly sync was the only writer of `promotions`, so a
 * discount created at 10:00 was invisible to the desk and the storefront advisor
 * until the next night — a customer quoting a brand-new code was told it did
 * not exist. Polling would close that gap by paying for it every few minutes
 * whether anything changed or not; a webhook costs nothing on a quiet day and
 * one discount read on a busy one.
 *
 * IT DOES NOT REPLACE THE NIGHTLY, for the same reason the order webhook does
 * not: deliveries get lost. It also leaves two things to the nightly on purpose:
 *   - usage counts (`discount_usage_count`, per-code `usage_count`) move on every
 *     redemption, and Shopify does not promise an update webhook for that;
 *   - `status` flipping SCHEDULED → ACTIVE → EXPIRED on its own clock. Readers
 *     already compare `starts_at` / `ends_at` with now, so only real edits matter.
 *
 * THE ROW IS REPLACED, NEVER PATCHED FROM THE PAYLOAD. The payload carries only
 * the title, status and timestamps; the rules, codes and scopes the agent answers
 * from come from re-reading the discount through the same query and mapper the
 * nightly uses. `offerable_in_replies` / `describable_in_replies` are local and
 * the mapper never writes them, so an upsert keeps the operator's choice.
 */

import {
  finishIntegrationEvent,
  hashIdentifier,
  recordDataAccessEvent,
  sanitizeError,
  startIntegrationEvent
} from './compliance-audit.mjs';
import { fetchDiscountItemsPage, fetchDiscountNode } from './shopify-admin-client.mjs';
import { findShop, headerValue, isStale } from './shopify-order-webhooks.mjs';
import { mapPromotionRows } from './shopify-sync-mappers.mjs';
import { supabaseDelete, supabaseSelect, supabaseUpsert } from './supabase-rest-client.mjs';
import { expandDiscountCodePages, expandDiscountItemPages } from '../sync-shopify-promotions.mjs';

/**
 * `discounts/redeemcode_added` / `_removed` are deliberately absent: generating a
 * batch of 600 unique codes would mean 600 deliveries, each re-reading the whole
 * 600-code discount. The nightly picks those codes up.
 */
export const DISCOUNT_TOPICS = new Set([
  'discounts/create',
  'discounts/update',
  'discounts/delete'
]);

/**
 * The discount node id (`gid://shopify/DiscountCodeNode/…` or
 * `…/DiscountAutomaticNode/…`), which is exactly `promotions.promotion_key`.
 * A bare numeric `id` is not used: it does not say whether the node is a code
 * or an automatic discount, so it cannot be turned back into a gid safely.
 */
export function discountNodeIdFromPayload(payload) {
  const raw = payload?.admin_graphql_api_id;
  return typeof raw === 'string' && raw.startsWith('gid://shopify/Discount') ? raw : null;
}

/**
 * Re-reads one discount completely — every code page and every product or
 * collection page — so the row is the same one the nightly would have written.
 */
export async function readCompleteDiscount(shopify, nodeId) {
  const node = await fetchDiscountNode(shopify, nodeId);
  if (!node) {
    return null;
  }
  const [withCodes] = await expandDiscountCodePages(shopify, [node]);
  const [complete] = await expandDiscountItemPages([withCodes], (id, leg, after) => (
    fetchDiscountItemsPage(shopify, id, leg, after)
  ));
  return complete;
}

export async function processDiscountWebhook({
  rawBody,
  headers,
  config,
  supabase,
  shopify,
  verifyHmac,
  now = new Date(),
  // Injected so the tests can run without Shopify.
  readDiscount = readCompleteDiscount
}) {
  if (!verifyHmac(rawBody, headers, config.shopifyWebhookSecret)) {
    // 401 and nothing written, audit rows included (see the order handler).
    return { statusCode: 401, body: { error: 'Invalid Shopify webhook HMAC.' } };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return { statusCode: 400, body: { error: 'Webhook body is not JSON.' } };
  }

  const topic = headerValue(headers, 'x-shopify-topic');
  if (!DISCOUNT_TOPICS.has(topic)) {
    return { statusCode: 400, body: { error: `Unsupported discount topic: ${topic || 'missing'}` } };
  }

  const shopDomain = headerValue(headers, 'x-shopify-shop-domain');
  const webhookId = headerValue(headers, 'x-shopify-webhook-id') || hashIdentifier(rawBody);
  const eventKey = `shopify-webhook:${webhookId}`;
  const shopRow = await findShop(supabase, shopDomain);
  if (!shopRow) {
    return { statusCode: 200, body: { status: 'unknown_shop', shop_domain: shopDomain } };
  }

  const event = await startIntegrationEvent(supabase, {
    shop_id: shopRow.id,
    event_key: eventKey,
    source: 'shopify',
    event_type: 'discount_webhook',
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

  if (event.duplicate && ['completed', 'skipped'].includes(event.row.status)) {
    return { statusCode: 200, body: { status: 'duplicate', event_key: eventKey } };
  }

  try {
    const nodeId = discountNodeIdFromPayload(payload);
    if (!nodeId) {
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'skipped',
        error_summary: `No discount id on a ${topic} payload.`
      });
      return { statusCode: 400, body: { error: 'Webhook payload carries no discount id.' } };
    }

    // A delete is believed without a read: there is nothing left to read. An
    // update whose discount Shopify no longer returns was deleted in between,
    // and is handled the same way rather than left to linger until the night.
    const discount = topic === 'discounts/delete' ? null : await readDiscount(shopify, nodeId);
    if (!discount) {
      await supabaseDelete(
        supabase,
        'promotions',
        { shop_id: shopRow.id, promotion_key: nodeId },
        { returning: 'minimal' }
      );
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'completed',
        counts: { promotions_deleted: 1 }
      });
      return { statusCode: 200, body: { status: 'deleted', promotion_key: nodeId } };
    }

    const stored = await supabaseSelect(
      supabase,
      'promotions',
      { shop_id: shopRow.id, promotion_key: nodeId },
      'shopify_updated_at'
    );
    if (isStale(discount.discount?.updatedAt, stored[0]?.shopify_updated_at)) {
      await finishIntegrationEvent(supabase, event.row.id, {
        status: 'skipped',
        counts: { promotions: 0 },
        error_summary: 'A newer version of this discount is already stored.'
      });
      return { statusCode: 200, body: { status: 'stale', promotion_key: nodeId } };
    }

    const rows = mapPromotionRows(discount, shopRow.id, now.toISOString());
    await supabaseUpsert(supabase, 'promotions', rows, 'shop_id,promotion_key', { returning: 'minimal' });

    await recordDataAccessEvent(supabase, {
      shop_id: shopRow.id,
      integration_event_id: event.row.id,
      action: 'shopify_discount_webhook',
      resource_type: 'promotions',
      resource_id_hash: hashIdentifier(`${shopRow.shop_domain}:${nodeId}`),
      purpose: 'Shopify discount webhook',
      metadata: { topic, page_count: 1, dry_run: false }
    });

    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'completed',
      counts: { promotions: rows.length }
    });
    return { statusCode: 200, body: { status: 'ok', promotion_key: nodeId } };
  } catch (error) {
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'failed',
      error_summary: sanitizeError(error)
    });
    // 500 so Shopify retries: a throttle or a database blip is worth another go.
    return { statusCode: 500, body: { error: 'Webhook processing failed.' } };
  }
}
