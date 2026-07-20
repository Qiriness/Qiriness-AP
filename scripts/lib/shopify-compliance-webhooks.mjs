import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  hashIdentifier,
  finishIntegrationEvent,
  sanitizeError,
  startIntegrationEvent
} from './compliance-audit.mjs';
import {
  supabaseDelete,
  supabaseDeleteWhereIn,
  supabaseSelect,
  supabaseUpdate,
  supabaseUpsert
} from './supabase-rest-client.mjs';

const COMPLIANCE_TOPICS = new Set([
  'customers/data_request',
  'customers/redact',
  'shop/redact'
]);

export function verifyShopifyWebhookHmac(rawBody, headers, secret) {
  const provided = headerValue(headers, 'x-shopify-hmac-sha256');
  if (!provided || !secret) {
    return false;
  }

  const computed = createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
    .digest('base64');
  const providedBuffer = Buffer.from(provided, 'utf8');
  const computedBuffer = Buffer.from(computed, 'utf8');

  if (providedBuffer.length !== computedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, computedBuffer);
}

export async function processComplianceWebhook({ rawBody, headers, config, supabase }) {
  if (!verifyShopifyWebhookHmac(rawBody, headers, config.shopifyWebhookSecret)) {
    return { statusCode: 401, body: { error: 'Invalid Shopify webhook HMAC.' } };
  }

  const payload = parsePayload(rawBody);
  const topic = headerValue(headers, 'x-shopify-topic') || payload.topic;
  if (!COMPLIANCE_TOPICS.has(topic)) {
    return { statusCode: 400, body: { error: `Unsupported compliance topic: ${topic || 'missing'}` } };
  }

  const shopDomain = headerValue(headers, 'x-shopify-shop-domain') || payload.shop_domain || null;
  const webhookId = headerValue(headers, 'x-shopify-webhook-id') || hashIdentifier(rawBody);
  const eventKey = `shopify-webhook:${webhookId}`;
  const shopRow = await findShop(supabase, shopDomain, payload.shop_id);
  const event = await startIntegrationEvent(supabase, {
    shop_id: shopRow?.id || null,
    event_key: eventKey,
    source: 'shopify',
    event_type: 'compliance_webhook',
    topic,
    status: 'processing',
    idempotency_key: webhookId,
    metadata: {
      shop_domain: shopDomain,
      shopify_shop_id: payload.shop_id ? String(payload.shop_id) : null,
      api_version: headerValue(headers, 'x-shopify-api-version'),
      triggered_at: headerValue(headers, 'x-shopify-triggered-at'),
      event_id: headerValue(headers, 'x-shopify-event-id')
    }
  });

  if (event.duplicate && ['completed', 'skipped'].includes(event.row.status)) {
    return { statusCode: 200, body: { status: 'duplicate', event_key: eventKey } };
  }

  try {
    const requestRow = await upsertPrivacyRequest({
      supabase,
      topic,
      payload,
      shopRow,
      eventRow: event.row,
      status: 'processing'
    });
    const result = await processTopic({ supabase, topic, payload, shopRow });
    const requestStatus = topic === 'customers/data_request'
      ? 'pending_merchant_response'
      : 'completed';

    await supabaseUpdate(
      supabase,
      'privacy_requests',
      { id: requestRow.id },
      {
        status: requestStatus,
        processed_at: new Date().toISOString(),
        deleted_customer_count: result.deletedCustomerCount || 0,
        metadata: result.metadata || {}
      }
    );
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'completed',
      counts: result.counts || {}
    });

    return {
      statusCode: 200,
      body: {
        status: requestStatus,
        event_key: eventKey,
        deleted_customer_count: result.deletedCustomerCount || 0
      }
    };
  } catch (error) {
    const errorSummary = sanitizeError(error);
    await upsertPrivacyRequest({
      supabase,
      topic,
      payload,
      shopRow,
      eventRow: event.row,
      status: 'failed',
      errorSummary
    });
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'failed',
      error_summary: errorSummary
    });
    throw error;
  }
}

async function processTopic({ supabase, topic, payload, shopRow }) {
  if (topic === 'customers/data_request') {
    return processCustomerDataRequest({ payload, shopRow });
  }
  if (topic === 'customers/redact') {
    return processCustomerRedact({ supabase, payload, shopRow });
  }
  return processShopRedact({ supabase, shopRow });
}

function processCustomerDataRequest({ payload, shopRow }) {
  return {
    counts: {
      orders_requested: Array.isArray(payload.orders_requested) ? payload.orders_requested.length : 0,
      customer_reference_present: payload.customer ? 1 : 0
    },
    metadata: {
      shop_found: Boolean(shopRow),
      merchant_response_required: true
    }
  };
}

async function processCustomerRedact({ supabase, payload, shopRow }) {
  if (!shopRow) {
    return {
      deletedCustomerCount: 0,
      counts: { deleted_customers: 0 },
      metadata: { shop_found: false }
    };
  }

  const matchingIds = await findMatchingCustomerRowIds(supabase, shopRow.id, payload.customer || {});
  if (matchingIds.length > 0) {
    await supabaseDeleteWhereIn(supabase, 'customers', 'id', matchingIds);
  }

  return {
    deletedCustomerCount: matchingIds.length,
    counts: { deleted_customers: matchingIds.length },
    metadata: {
      shop_found: true,
      orders_to_redact: Array.isArray(payload.orders_to_redact) ? payload.orders_to_redact.length : 0
    }
  };
}

async function processShopRedact({ supabase, shopRow }) {
  if (!shopRow) {
    return {
      deletedCustomerCount: 0,
      counts: { deleted_shops: 0, deleted_customers: 0 },
      metadata: { shop_found: false }
    };
  }

  const customers = await supabaseSelect(supabase, 'customers', { shop_id: shopRow.id }, 'id');
  await supabaseDelete(supabase, 'shops', { id: shopRow.id });

  return {
    deletedCustomerCount: customers.length,
    counts: {
      deleted_shops: 1,
      deleted_customers: customers.length
    },
    metadata: { shop_found: true }
  };
}

async function upsertPrivacyRequest({ supabase, topic, payload, shopRow, eventRow, status, errorSummary = null }) {
  const customer = payload.customer || {};
  const rows = await supabaseUpsert(
    supabase,
    'privacy_requests',
    [{
      shop_id: shopRow?.id || null,
      integration_event_id: eventRow.id,
      request_key: eventRow.event_key,
      topic,
      shopify_shop_id: payload.shop_id ? String(payload.shop_id) : null,
      shop_domain: payload.shop_domain || shopRow?.shop_domain || null,
      shopify_customer_id: customer.id ? String(customer.id) : null,
      customer_email_hash: hashIdentifier(customer.email),
      customer_phone_hash: hashIdentifier(customer.phone),
      status,
      metadata: privacyRequestMetadata(topic, payload),
      error_summary: errorSummary
    }],
    'request_key'
  );
  return rows[0];
}

function privacyRequestMetadata(topic, payload) {
  if (topic === 'customers/data_request') {
    return {
      orders_requested: Array.isArray(payload.orders_requested) ? payload.orders_requested.length : 0,
      data_request_id: payload.data_request?.id ? String(payload.data_request.id) : null
    };
  }
  if (topic === 'customers/redact') {
    return {
      orders_to_redact: Array.isArray(payload.orders_to_redact) ? payload.orders_to_redact.length : 0
    };
  }
  return {};
}

async function findShop(supabase, shopDomain, shopifyShopId) {
  if (shopDomain) {
    const rows = await supabaseSelect(supabase, 'shops', { shop_domain: shopDomain }, '*');
    if (rows.length > 0) {
      return rows[0];
    }
  }
  if (shopifyShopId) {
    const rows = await supabaseSelect(supabase, 'shops', { shopify_shop_id: String(shopifyShopId) }, '*');
    return rows[0] || null;
  }
  return null;
}

async function findMatchingCustomerRowIds(supabase, shopId, customer) {
  const rows = await supabaseSelect(
    supabase,
    'customers',
    { shop_id: shopId },
    'id,legacy_resource_id,email,phone'
  );
  const legacyId = customer.id ? String(customer.id) : null;
  const email = customer.email ? String(customer.email).trim().toLowerCase() : null;
  const phone = customer.phone ? String(customer.phone).trim() : null;

  return rows
    .filter((row) => (
      (legacyId && row.legacy_resource_id === legacyId) ||
      (email && row.email && String(row.email).trim().toLowerCase() === email) ||
      (phone && row.phone && String(row.phone).trim() === phone)
    ))
    .map((row) => row.id);
}

function parsePayload(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    throw new Error('Shopify compliance webhook body is not valid JSON.');
  }
}

function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}
