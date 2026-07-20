import { createHash } from 'node:crypto';

import { supabaseInsert, supabaseSelect, supabaseUpdate, supabaseUpsert } from './supabase-rest-client.mjs';

export function hashIdentifier(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

export function sanitizeError(error) {
  const message = error?.message || String(error);
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
    .replace(/shpat_[A-Za-z0-9_]+/g, '[redacted-token]')
    .slice(0, 500);
}

export async function startIntegrationEvent(supabase, row) {
  const existing = await supabaseSelect(
    supabase,
    'integration_events',
    { event_key: row.event_key },
    '*'
  );

  if (existing.length > 0) {
    return { row: existing[0], duplicate: true };
  }

  const rows = await supabaseUpsert(
    supabase,
    'integration_events',
    [{
      ...row,
      status: row.status || 'processing',
      started_at: row.started_at || new Date().toISOString(),
      counts: row.counts || {},
      metadata: row.metadata || {}
    }],
    'event_key'
  );
  return { row: rows[0], duplicate: false };
}

export async function finishIntegrationEvent(supabase, eventId, row) {
  if (!eventId) {
    return null;
  }

  const rows = await supabaseUpdate(
    supabase,
    'integration_events',
    { id: eventId },
    {
      ...row,
      finished_at: row.finished_at || new Date().toISOString()
    }
  );
  return rows[0] || null;
}

export async function recordDataAccessEvent(supabase, row) {
  const rows = await supabaseInsert(
    supabase,
    'data_access_events',
    [{
      actor_type: row.actor_type || 'service',
      actor_id: row.actor_id || 'shopify-sync',
      action: row.action,
      resource_type: row.resource_type,
      resource_id_hash: row.resource_id_hash || null,
      purpose: row.purpose,
      shop_id: row.shop_id || null,
      integration_event_id: row.integration_event_id || null,
      occurred_at: row.occurred_at || new Date().toISOString(),
      metadata: row.metadata || {}
    }]
  );
  return rows[0] || null;
}
