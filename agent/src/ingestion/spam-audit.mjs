import { supabaseUpdate, supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';

// Audit trail for the spam gate (Phase 2). Both passes drop mail before anything
// is written to tickets/ticket_messages, so without this a blocked email leaves no
// trace and a wrong drop is invisible.
//
// Split the usual way: pure record building + buffering here, database access in
// the store at the bottom. Decisions buffer through a poll and flush once at the
// end, mirroring how blocklist hit counts are recorded.
//
// THE BODY IS PART OF THE RECORD (08_spam_audit_body.sql). It was not, and the
// trail was reviewable in principle and not in practice: the one question a
// reviewer has is "should this have become a ticket?", and a subject line does
// not answer it. It is stored under its own clock — `bodyExpiresAt` is set here,
// and `purgeExpiredBodies` nulls the text past it while the decision row stands
// for ever. Bounded review window, unbounded audit trail.

const MAX_REASON_CHARS = 200;
const MAX_SUBJECT_CHARS = 200;
// Enough to judge any real support email, and a ceiling on what a pathological
// one can put in the table. The cap is here rather than in the database so the
// truncation marker is applied once, in the same place as the subject's.
const MAX_BODY_CHARS = 8000;

// How long a captured body stays readable. 90 days is the review horizon: past
// that, nobody is re-litigating a spam decision, and what is left is the
// decision itself, which costs nothing to keep.
export const DEFAULT_BODY_RETENTION_DAYS = 90;

// A keep the classifier had no confident reason for is recorded as "unsure"
// rather than as a positive judgement — the "when in doubt, keep" fail-safe path
// should be visible as exactly that when reviewing decisions.
export const UNSURE_REASON = 'unsure';

// Buffers decisions for one poll. Passed down into the ticket writer so the LLM
// pass (which runs there) and the blocklist pass (which runs in the poller) land
// in the same batch.
export function createAuditCollector() {
  const entries = [];
  return {
    record(entry) {
      if (entry) {
        entries.push(entry);
      }
    },
    entries() {
      return entries;
    },
    get size() {
      return entries.length;
    }
  };
}

// Default when auditing is not wired (unit tests, or a run without the table).
export const noopAuditCollector = {
  record() {},
  entries() {
    return [];
  },
  size: 0
};

// entry: { graphMessageId, conversationId, fromEmail, subject, bodyText, outcome,
//          decidedBy, reason, label, model, ruleId, failedOpen, decidedAt }
export function buildAuditRow(shopId, entry, { retentionDays = DEFAULT_BODY_RETENTION_DAYS } = {}) {
  const decidedAt = entry.decidedAt || new Date().toISOString();
  const row = {
    shop_id: shopId,
    graph_message_id: entry.graphMessageId,
    graph_conversation_id: entry.conversationId ?? null,
    outcome: entry.outcome,
    decided_by: entry.decidedBy,
    reason: normalizeReason(entry.reason),
    label: entry.label ?? null,
    from_email: entry.fromEmail ?? null,
    subject: truncate(entry.subject, MAX_SUBJECT_CHARS),
    model: entry.model ?? null,
    blocklist_rule_id: entry.ruleId ?? null,
    failed_open: Boolean(entry.failedOpen),
    decided_at: decidedAt
  };

  // THE BODY IS ONLY WORTH KEEPING ON A DROP. A kept email is already stored in
  // full on ticket_messages, so writing it here too would duplicate personal
  // data into a second table with a second retention clock — the exact thing
  // `context_ref` avoids on the investigation side.
  if (entry.outcome === 'blocked') {
    Object.assign(row, buildBodyPatch(entry.bodyText, { capturedAt: decidedAt, retentionDays }));
  }

  return row;
}

/**
 * The three body columns, or nothing.
 *
 * ONE PLACE OWNS THE CAP AND THE CLOCK, because there are two writers: live
 * ingestion at the moment of the decision, and the Graph backfill for rows that
 * predate 08. A backfilled body that expired on a different rule from an
 * ingested one would make the retention window a function of when somebody
 * happened to run a script.
 *
 * Returns `{}` for an empty body, so a genuinely blank email is left with
 * `body_captured_at` null — never captured and captured-but-empty are the same
 * thing to a reviewer, and neither is worth a row-level distinction.
 */
export function buildBodyPatch(
  bodyText,
  { capturedAt = new Date().toISOString(), retentionDays = DEFAULT_BODY_RETENTION_DAYS } = {}
) {
  const body = truncate(bodyText, MAX_BODY_CHARS);
  if (!body) {
    return {};
  }
  return {
    body_text: body,
    body_captured_at: capturedAt,
    body_expires_at: addDays(capturedAt, retentionDays)
  };
}

// Deduped by Graph message id, keeping the last decision: the id is the row's
// idempotency key, so two rows for one message would break the upsert.
export function buildAuditRows(shopId, entries = [], options = {}) {
  const byMessageId = new Map();
  for (const entry of entries) {
    // No idempotency key means nothing to dedupe on, and graph_message_id is
    // NOT NULL — skip rather than fail the whole batch over one odd message.
    if (!entry?.graphMessageId) {
      continue;
    }
    byMessageId.set(entry.graphMessageId, buildAuditRow(shopId, entry, options));
  }
  return [...byMessageId.values()];
}

/** ISO timestamp `days` after `from`. */
export function addDays(from, days) {
  const start = new Date(from).getTime();
  if (!Number.isFinite(start)) {
    return null;
  }
  return new Date(start + days * 86400000).toISOString();
}

// Collapses a model-written reason to one short line. An empty or unusable reason
// becomes "unsure" so every row states something.
export function normalizeReason(reason) {
  if (typeof reason !== 'string') {
    return UNSURE_REASON;
  }
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return UNSURE_REASON;
  }
  return truncate(oneLine, MAX_REASON_CHARS);
}

function truncate(value, max) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function createSupabaseSpamAuditStore(supabase, { retentionDays = DEFAULT_BODY_RETENTION_DAYS } = {}) {
  return {
    async flush(shopId, entries) {
      const rows = buildAuditRows(shopId, entries, { retentionDays });
      if (rows.length === 0) {
        return 0;
      }
      await supabaseUpsert(supabase, 'spam_audit', rows, 'shop_id,graph_message_id');
      return rows.length;
    },

    /**
     * Nulls every body past its expiry, keeping the decision row.
     *
     * A PATCH rather than a DELETE, and that is the whole design: the text is
     * personal data with a bounded life, the decision is audit metadata with
     * none. Deleting the row would destroy the trace that a drop happened at
     * all, which is the reason this table exists.
     *
     * Runs once per poll and is a no-op the vast majority of the time — the
     * partial index means the query only ever looks at rows that still hold a
     * body. Returns how many were cleared.
     */
    async purgeExpiredBodies(shopId, { now = new Date() } = {}) {
      const cleared = await supabaseUpdate(
        supabase,
        'spam_audit',
        {
          shop_id: shopId,
          body_expires_at: { operator: 'lt', value: new Date(now).toISOString() },
          // Without this the PATCH would keep rewriting rows already cleared,
          // and `updated_at` would move on every poll for ever.
          body_text: { operator: 'not.is', value: null }
        },
        { body_text: null }
      );
      return Array.isArray(cleared) ? cleared.length : 0;
    }
  };
}
