import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditCollector,
  buildAuditRow,
  buildAuditRows,
  normalizeReason,
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
