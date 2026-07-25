import { supabaseUpsert } from '../../../scripts/lib/supabase-rest-client.mjs';

// Audit trail for the spam gate (Phase 2). Both passes drop mail before anything
// is written to tickets/ticket_messages, so without this a blocked email leaves no
// trace and a wrong drop is invisible.
//
// Split the usual way: pure record building + buffering here, database access in
// the store at the bottom. Decisions buffer through a poll and flush once at the
// end, mirroring how blocklist hit counts are recorded.

const MAX_REASON_CHARS = 200;
const MAX_SUBJECT_CHARS = 200;

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

// entry: { graphMessageId, conversationId, fromEmail, subject, outcome, decidedBy,
//          reason, label, model, ruleId, failedOpen, decidedAt }
export function buildAuditRow(shopId, entry) {
  return {
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
    decided_at: entry.decidedAt || new Date().toISOString()
  };
}

// Deduped by Graph message id, keeping the last decision: the id is the row's
// idempotency key, so two rows for one message would break the upsert.
export function buildAuditRows(shopId, entries = []) {
  const byMessageId = new Map();
  for (const entry of entries) {
    // No idempotency key means nothing to dedupe on, and graph_message_id is
    // NOT NULL — skip rather than fail the whole batch over one odd message.
    if (!entry?.graphMessageId) {
      continue;
    }
    byMessageId.set(entry.graphMessageId, buildAuditRow(shopId, entry));
  }
  return [...byMessageId.values()];
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

export function createSupabaseSpamAuditStore(supabase) {
  return {
    async flush(shopId, entries) {
      const rows = buildAuditRows(shopId, entries);
      if (rows.length === 0) {
        return 0;
      }
      await supabaseUpsert(supabase, 'spam_audit', rows, 'shop_id,graph_message_id');
      return rows.length;
    }
  };
}
