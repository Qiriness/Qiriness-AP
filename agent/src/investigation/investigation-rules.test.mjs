import assert from 'node:assert/strict';
import test from 'node:test';

import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';
import {
  ENABLED_SUBJECTS,
  STALE_TRANSIT_DAYS,
  TOOL_NAMES,
  allowedTools,
  escalationTriggers,
  isInvestigable,
  openingMoves,
  requiredEvidence,
  subjectsWithoutPolicy
} from './investigation-rules.mjs';

test('every subject in the taxonomy has an explicit tool policy', () => {
  // A subject falling through to a default is how a new category silently gets
  // either nothing or everything.
  assert.deepEqual(subjectsWithoutPolicy(), []);
});

test('level 4 is given no tools, whatever the subject', () => {
  for (const subject of TICKET_SUBJECTS) {
    assert.deepEqual(allowedTools(subject, 'problem', 4), [], subject);
  }
});

test('the contact kind is given no tools — that mail is forwarded, not answered', () => {
  for (const subject of TICKET_SUBJECTS) {
    assert.deepEqual(allowedTools(subject, 'contact', 2), [], subject);
  }
});

test('cosmetovigilance and legal_privacy are deliberately toolless', () => {
  for (const kind of REQUEST_KINDS) {
    assert.deepEqual(allowedTools('cosmetovigilance', kind, 2), []);
    assert.deepEqual(allowedTools('legal_privacy', kind, 2), []);
  }
});

test('the forwarded subjects are toolless', () => {
  for (const subject of ['b2b', 'partner_collaboration', 'careers']) {
    assert.deepEqual(allowedTools(subject, 'problem', 2), [], subject);
  }
});

test('the exact tool set for each enabled subject', () => {
  assert.deepEqual(allowedTools('product', 'question', 1), [
    TOOL_NAMES.SEARCH_KNOWLEDGE,
    TOOL_NAMES.LOOKUP_PRODUCT,
    TOOL_NAMES.LOOKUP_STOCK
  ]);
  assert.deepEqual(allowedTools('product_stock', 'question', 2), [
    TOOL_NAMES.LOOKUP_STOCK,
    TOOL_NAMES.LOOKUP_PRODUCT
  ]);
  assert.deepEqual(allowedTools('account', 'problem', 2), [
    TOOL_NAMES.LOOKUP_CUSTOMER,
    TOOL_NAMES.SEARCH_KNOWLEDGE
  ]);
  assert.deepEqual(allowedTools('other', 'question', 1), [TOOL_NAMES.SEARCH_KNOWLEDGE]);
});

test('a promotions ticket never gets the product tools, and vice versa', () => {
  // Least privilege is the point: an unrelated tool is one the model can spend a
  // call on and then reason from.
  const promotions = allowedTools('promotions', 'problem', 2);
  assert.ok(!promotions.includes(TOOL_NAMES.LOOKUP_PRODUCT));

  const product = allowedTools('product', 'question', 1);
  assert.ok(!product.includes(TOOL_NAMES.LOOKUP_PROMOTION));
  assert.ok(!product.includes(TOOL_NAMES.LOOKUP_CUSTOMER), 'a product question needs no customer record');
});

test('the whole 14 x 4 matrix is decidable and never throws', () => {
  for (const subject of TICKET_SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      for (const level of [1, 2, 3, 4]) {
        assert.ok(Array.isArray(allowedTools(subject, kind, level)), `${subject}/${kind}/${level}`);
      }
    }
  }
});

test('isInvestigable follows ENABLED_SUBJECTS, not just the tool table', () => {
  // delivery has a full tool policy and is still out of scope today.
  assert.equal(isInvestigable({ category: 'delivery', request_kind: 'problem', level: 2 }), false);
  assert.ok(!ENABLED_SUBJECTS.includes('delivery'));

  assert.equal(isInvestigable({ category: 'promotions', request_kind: 'problem', level: 2 }), true);
  assert.equal(isInvestigable({ category: 'promotions', request_kind: 'problem', level: 4 }), false);
  assert.equal(isInvestigable({ category: 'careers', request_kind: 'contact', level: 2 }), false);
});

test('opening moves gather the deterministic evidence before any model turn', () => {
  const promotions = openingMoves({
    category: 'promotions',
    request_kind: 'problem',
    level: 2,
    text: 'le code BIENVENUE10 ne marche pas'
  });

  assert.deepEqual(promotions.map((m) => m.tool), [
    TOOL_NAMES.EXTRACT_PROMOTION_CODES,
    TOOL_NAMES.LOOKUP_CUSTOMER
  ]);
  assert.equal(promotions[0].args.text, 'le code BIENVENUE10 ne marche pas');
});

test('a product question opens by matching the product against the question text', () => {
  const moves = openingMoves({
    category: 'product',
    request_kind: 'question',
    level: 1,
    text: 'le masque LED convient-il aux peaux sensibles ?'
  });

  assert.deepEqual(moves.map((m) => m.tool), [TOOL_NAMES.LOOKUP_PRODUCT, TOOL_NAMES.SEARCH_KNOWLEDGE]);
});

test('opening moves can never widen the tool guardrail', () => {
  // Level 4 has no tools, so it can have no opening moves either.
  for (const subject of TICKET_SUBJECTS) {
    assert.deepEqual(openingMoves({ category: subject, request_kind: 'problem', level: 4, text: 'x' }), []);
    assert.deepEqual(openingMoves({ category: subject, request_kind: 'contact', level: 2, text: 'x' }), []);
  }
});

test('every enabled subject has both an evidence checklist and opening moves', () => {
  for (const subject of ENABLED_SUBJECTS) {
    assert.ok(requiredEvidence(subject).length > 0, `${subject} checklist`);
    assert.ok(
      openingMoves({ category: subject, request_kind: 'question', level: 2, text: 'x' }).length > 0,
      `${subject} opening moves`
    );
  }
});

test('a parcel with no movement for ten days escalates to level 3', () => {
  const now = new Date('2026-08-04T00:00:00Z');
  const { level, reasons } = escalationTriggers({
    ticket: { category: 'delivery', request_kind: 'problem', level: 2 },
    orderContext: {
      order: { delivery: { state: 'in_transit', lastScanAt: '2026-07-20T00:00:00Z' } }
    },
    now
  });

  assert.equal(level, 3);
  assert.match(reasons[0], new RegExp(String(STALE_TRANSIT_DAYS)));
});

test('a parcel moving normally does not escalate', () => {
  const now = new Date('2026-08-04T00:00:00Z');
  const { level, reasons } = escalationTriggers({
    ticket: { category: 'delivery', request_kind: 'problem', level: 2 },
    orderContext: { order: { delivery: { state: 'in_transit', lastScanAt: '2026-08-02T00:00:00Z' } } },
    now
  });

  assert.equal(level, 2);
  assert.deepEqual(reasons, []);
});

test('carrier says delivered while the customer reports a problem escalates', () => {
  const { level } = escalationTriggers({
    ticket: { category: 'delivery', request_kind: 'problem', level: 2 },
    orderContext: { order: { delivery: { state: 'delivered' } } }
  });
  assert.equal(level, 3);
});

test('escalation never lowers a level', () => {
  const { level } = escalationTriggers({
    ticket: { category: 'delivery', request_kind: 'question', level: 3 },
    orderContext: { order: { delivery: { state: 'delivered' } } }
  });
  assert.equal(level, 3);
});
