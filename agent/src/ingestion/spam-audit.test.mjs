import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditCollector,
  buildAuditRow,
  buildAuditRows,
  buildBodyPatch,
  normalizeReason,
  DEFAULT_BODY_RETENTION_DAYS,
  UNSURE_REASON
} from './spam-audit.mjs';

test('collector buffers decisions and ignores empty ones', () => {
  const audit = createAuditCollector();
  audit.record({ graphMessageId: 'm1' });
  audit.record(null);
  audit.record(undefined);
  assert.equal(audit.size, 1);
  assert.deepEqual(audit.entries(), [{ graphMessageId: 'm1' }]);
});

test('a missing, blank, or non-string reason becomes "unsure"', () => {
  assert.equal(normalizeReason(undefined), UNSURE_REASON);
  assert.equal(normalizeReason(null), UNSURE_REASON);
  assert.equal(normalizeReason(''), UNSURE_REASON);
  assert.equal(normalizeReason('   \n  '), UNSURE_REASON);
  assert.equal(normalizeReason(42), UNSURE_REASON);
});

test('a reason is collapsed to one line and capped', () => {
  assert.equal(normalizeReason('  démarchage   SEO\nnon sollicité  '), 'démarchage SEO non sollicité');

  const long = normalizeReason('x'.repeat(400));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('an explicit "unsure" keep survives normalization unchanged', () => {
  assert.equal(normalizeReason('unsure'), UNSURE_REASON);
});

test('maps a blocklist decision to the row shape', () => {
  const row = buildAuditRow('shop-1', {
    graphMessageId: 'm1',
    conversationId: 'c1',
    fromEmail: 'spammer@bad.com',
    subject: 'Offre SEO',
    outcome: 'blocked',
    decidedBy: 'blocklist',
    reason: 'blocklist domain rule: bad.com',
    ruleId: 'rule-9',
    decidedAt: '2026-07-25T10:00:00Z'
  });

  assert.deepEqual(row, {
    shop_id: 'shop-1',
    graph_message_id: 'm1',
    graph_conversation_id: 'c1',
    outcome: 'blocked',
    decided_by: 'blocklist',
    reason: 'blocklist domain rule: bad.com',
    label: null,
    from_email: 'spammer@bad.com',
    subject: 'Offre SEO',
    model: null,
    blocklist_rule_id: 'rule-9',
    failed_open: false,
    decided_at: '2026-07-25T10:00:00Z'
  });
});

test('maps a fail-open LLM keep, marking it as not a judged decision', () => {
  const row = buildAuditRow('shop-1', {
    graphMessageId: 'm2',
    outcome: 'kept',
    decidedBy: 'llm',
    label: 'keep',
    reason: 'classifier error, kept by fail-open: boom',
    model: 'gpt-4o-mini',
    failedOpen: true
  });

  assert.equal(row.outcome, 'kept');
  assert.equal(row.failed_open, true);
  assert.equal(row.label, 'keep');
  assert.equal(row.model, 'gpt-4o-mini');
  assert.match(row.reason, /fail-open/);
});

test('rows are deduped by message id, keeping the last decision', () => {
  const rows = buildAuditRows('shop-1', [
    { graphMessageId: 'm1', outcome: 'kept', decidedBy: 'llm', reason: 'first' },
    { graphMessageId: 'm1', outcome: 'blocked', decidedBy: 'llm', reason: 'second' },
    { graphMessageId: 'm2', outcome: 'kept', decidedBy: 'llm', reason: 'other' }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason, 'second');
  assert.equal(rows[0].outcome, 'blocked');
});

test('entries without a message id are skipped (no idempotency key)', () => {
  const rows = buildAuditRows('shop-1', [
    { graphMessageId: null, outcome: 'kept', decidedBy: 'llm', reason: 'r' },
    { outcome: 'kept', decidedBy: 'llm', reason: 'r' },
    { graphMessageId: 'm1', outcome: 'kept', decidedBy: 'llm', reason: 'r' }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].graph_message_id, 'm1');
});

test('a decided_at is always set even when the caller omits it', () => {
  const row = buildAuditRow('shop-1', { graphMessageId: 'm1', outcome: 'kept', decidedBy: 'llm' });
  assert.ok(!Number.isNaN(Date.parse(row.decided_at)));
  assert.equal(row.reason, UNSURE_REASON);
});

// --- the body (08_spam_audit_body.sql) --------------------------------------

test('a blocked decision stores the body with its own expiry', () => {
  const row = buildAuditRow(
    'shop-1',
    {
      graphMessageId: 'm1',
      outcome: 'blocked',
      decidedBy: 'llm',
      reason: 'newsletter',
      bodyText: 'Bonjour, découvrez nos offres.',
      decidedAt: '2026-01-01T00:00:00.000Z'
    },
    { retentionDays: 90 }
  );

  assert.equal(row.body_text, 'Bonjour, découvrez nos offres.');
  assert.equal(row.body_captured_at, '2026-01-01T00:00:00.000Z');
  assert.equal(row.body_expires_at, '2026-04-01T00:00:00.000Z');
});

test('a KEPT decision never stores the body', () => {
  // It is about to be written to ticket_messages in full; copying it here would
  // duplicate personal data into a second table with a second retention clock.
  const row = buildAuditRow('shop-1', {
    graphMessageId: 'm1',
    outcome: 'kept',
    decidedBy: 'llm',
    reason: 'genuine customer',
    bodyText: 'Bonjour, où est ma commande ?'
  });

  assert.equal(row.body_text, undefined);
  assert.equal(row.body_captured_at, undefined);
  assert.equal(row.body_expires_at, undefined);
});

test('a blocked decision with no body leaves the capture columns unset', () => {
  // Never captured and captured-but-empty are the same thing to a reviewer.
  for (const bodyText of [undefined, null, '', '   \n  ']) {
    const row = buildAuditRow('shop-1', {
      graphMessageId: 'm1',
      outcome: 'blocked',
      decidedBy: 'blocklist',
      reason: 'blocklisted',
      bodyText
    });
    assert.equal(row.body_text, undefined, String(bodyText));
    assert.equal(row.body_captured_at, undefined, String(bodyText));
  }
});

test('the body is capped, and the cap marks the truncation', () => {
  const row = buildAuditRow('shop-1', {
    graphMessageId: 'm1',
    outcome: 'blocked',
    decidedBy: 'llm',
    reason: 'spam',
    bodyText: 'x'.repeat(20000)
  });

  assert.equal(row.body_text.length, 8000);
  assert.ok(row.body_text.endsWith('…'));
});

test('buildBodyPatch is the single owner of the cap and the clock', () => {
  // Two writers use it — live ingestion and the Graph backfill — so a
  // backfilled body must expire on exactly the same rule as an ingested one.
  const ingested = buildAuditRow(
    'shop-1',
    {
      graphMessageId: 'm1',
      outcome: 'blocked',
      decidedBy: 'llm',
      reason: 'spam',
      bodyText: 'same text',
      decidedAt: '2026-01-01T00:00:00.000Z'
    },
    { retentionDays: 30 }
  );
  const backfilled = buildBodyPatch('same text', {
    capturedAt: '2026-01-01T00:00:00.000Z',
    retentionDays: 30
  });

  assert.equal(ingested.body_text, backfilled.body_text);
  assert.equal(ingested.body_captured_at, backfilled.body_captured_at);
  assert.equal(ingested.body_expires_at, backfilled.body_expires_at);
});

test('the retention window is configurable and defaults to 90 days', () => {
  const at = '2026-01-01T00:00:00.000Z';
  assert.equal(buildBodyPatch('t', { capturedAt: at }).body_expires_at, '2026-04-01T00:00:00.000Z');
  assert.equal(
    buildBodyPatch('t', { capturedAt: at, retentionDays: 7 }).body_expires_at,
    '2026-01-08T00:00:00.000Z'
  );
  assert.equal(DEFAULT_BODY_RETENTION_DAYS, 90);
});
