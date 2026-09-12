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

/**
 * An address reduced to what a human needs to RECOGNISE it, and no more.
 *
 *   `jocelyne.wastiel@bluewin.ch` -> `j***l@bluewin.ch`
 *
 * WHY THIS EXISTS BESIDE THE HASH. `orders` deliberately stores only
 * `customer_email_hash` — the row must not duplicate a raw address. But a hash
 * answers exactly one question, "is it the same address?", and the question the
 * desk actually has is the one `orders:resolve` keeps failing: 15 tickets quote
 * a real order number from an address that does not own it, and a person must
 * decide whether that is a gift, a partner, or a second mailbox. A hash cannot
 * be looked at; `j***l@orange.fr` beside the requester's address settles it in a
 * second.
 *
 * THE DOMAIN IS KEPT WHOLE, deliberately: it is the discriminating half ("same
 * person, second address at the same provider") and a provider domain is not
 * personal data. This codebase already draws that line the same way — the sender
 * directory stores company domains as context precisely because they are not.
 *
 * SHORT LOCAL PARTS REVEAL THEMSELVES, so they are not half-masked: `bo@x.fr`
 * masked as `b***o@x.fr` would be longer than the original and hide nothing.
 * Two characters or fewer collapse to `**`.
 */
export function maskEmail(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const address = String(value).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    // Not an address shape. Returning null rather than a masked non-address
    // keeps "we have no readable identifier" distinguishable from "we have one".
    return null;
  }

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const masked = local.length <= 2 ? '**' : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
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

/**
 * The job timeout this sweep assumes, in minutes. A run still `processing` past
 * it cannot be alive: the GitHub job is capped at the same number, and the
 * workflow's concurrency group forbids two runs at once.
 *
 * Keep in step with `timeout-minutes` in .github/workflows/nightly-sync.yml.
 */
export const STALE_SYNC_MINUTES = 180;

/**
 * Close the rows a killed run left open.
 *
 * WHY THIS EXISTS. `finishIntegrationEvent` is only ever reached by code that is
 * still running — the `catch` in the nightly writes `failed`, so a sync that
 * throws is honest about it. A sync that is KILLED writes nothing at all: the
 * GitHub job hits `timeout-minutes`, the process dies where it stands, and the
 * row stays on `processing` for ever. Two of them were sitting in the table on
 * 2026-09-12, from 30 August and from that morning.
 *
 * That silence is the actual damage, not the lost run. `describeFreshness` reads
 * the same row and prints `processing` as "running since 3 h ago" in a quiet
 * `info` tone, so the dashboard spent the morning reporting a dead sync as one
 * in progress. A run that failed should look failed.
 *
 * ONE PATCH, NOT A READ THEN A WRITE: PostgREST filters the UPDATE server-side,
 * so there is no window between deciding a row is stale and closing it, and a
 * second caller racing this one simply updates nothing.
 */
export async function failStaleIntegrationEvents(
  supabase,
  { olderThanMinutes = STALE_SYNC_MINUTES, now = new Date() } = {}
) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000).toISOString();

  const rows = await supabaseUpdate(
    supabase,
    'integration_events',
    {
      status: 'processing',
      started_at: { operator: 'lt', value: cutoff }
    },
    {
      status: 'failed',
      finished_at: now.toISOString(),
      // Said plainly, because the alternative reading — the job ran and the data
      // was wrong — sends whoever finds this row looking in the wrong place.
      error_summary: `No completion recorded within ${olderThanMinutes} minutes; the run was killed before it could close its own row.`
    },
    { select: 'id,event_type,started_at' }
  );

  return rows || [];
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
