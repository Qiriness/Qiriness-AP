import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBJECTS,
  KNOWLEDGE_ONLY_SUBJECTS,
  KNOWLEDGE_CATEGORIES,
  TICKET_SUBJECTS,
  REQUEST_KINDS,
  defaultLevel,
  clampLevel,
  defaultTeam,
  isSubject,
  isKnowledgeCategory,
  isRequestKind,
  describeTicketCategory
} from './support-taxonomy.mjs';

test('subjects and kinds are the agreed vocabulary', () => {
  assert.equal(SUBJECTS.length, 14);
  assert.deepEqual(REQUEST_KINDS, ['question', 'problem', 'complaint', 'contact']);
  assert.deepEqual(KNOWLEDGE_ONLY_SUBJECTS, ['faq', 'brand_story']);
});

test('knowledge categories are the subjects plus the knowledge-only shapes', () => {
  assert.equal(KNOWLEDGE_CATEGORIES.length, 16);
  for (const subject of SUBJECTS) {
    assert.ok(KNOWLEDGE_CATEGORIES.includes(subject), `${subject} should be a knowledge category`);
  }
  // The shared-vocabulary guarantee: every ticket subject is a valid knowledge
  // category, so a ticket's subject is always a usable retrieval filter.
  for (const subject of TICKET_SUBJECTS) {
    assert.ok(isKnowledgeCategory(subject));
  }
});

test('faq and brand_story are knowledge-only, never ticket subjects', () => {
  for (const knowledgeOnly of KNOWLEDGE_ONLY_SUBJECTS) {
    assert.ok(isKnowledgeCategory(knowledgeOnly));
    assert.equal(isSubject(knowledgeOnly), false);
    assert.equal(TICKET_SUBJECTS.includes(knowledgeOnly), false);
  }
});

test('cosmetovigilance is always level 4, whatever the kind', () => {
  for (const kind of REQUEST_KINDS) {
    assert.equal(defaultLevel('cosmetovigilance', kind), 4, `kind=${kind}`);
  }
});

test('a privacy action is sensitive but a privacy question is not', () => {
  assert.equal(defaultLevel('legal_privacy', 'question'), 1);
  assert.equal(defaultLevel('legal_privacy', 'problem'), 4);
  assert.equal(defaultLevel('legal_privacy', 'complaint'), 4);
});

test('questions needing a data lookup are level 2, answerable ones level 1', () => {
  for (const subject of ['order', 'delivery', 'payment', 'account', 'product_stock']) {
    assert.equal(defaultLevel(subject, 'question'), 2, subject);
  }
  for (const subject of ['product', 'promotions', 'b2b', 'careers']) {
    assert.equal(defaultLevel(subject, 'question'), 1, subject);
  }
});

test('problems and complaints default to state-changing, contact to a forward', () => {
  assert.equal(defaultLevel('order', 'problem'), 3);
  assert.equal(defaultLevel('delivery', 'complaint'), 3);
  assert.equal(defaultLevel('b2b', 'contact'), 2);
});

test('the categoriser can escalate but never de-escalate', () => {
  // Model says 1 for an adverse reaction: floor wins.
  assert.equal(clampLevel('cosmetovigilance', 'question', 1), 4);
  // Model says 4 for a simple product question: escalation is allowed.
  assert.equal(clampLevel('product', 'question', 4), 4);
  // Model says 1 for an order problem (floor 3): floor wins.
  assert.equal(clampLevel('order', 'problem', 1), 3);
  // Nothing exceeds 4, and a missing proposal falls back to the floor.
  assert.equal(clampLevel('product', 'question', 9), 4);
  assert.equal(clampLevel('order', 'question', undefined), 2);
});

test('every subject routes to a known team', () => {
  const teams = new Set(['finance', 'marketing', 'sales', 'logistics', 'contact']);
  for (const subject of SUBJECTS) {
    assert.ok(teams.has(defaultTeam(subject)), `${subject} -> ${defaultTeam(subject)}`);
  }
  assert.equal(defaultTeam('payment'), 'finance');
  assert.equal(defaultTeam('delivery'), 'logistics');
  assert.equal(defaultTeam('partner_collaboration'), 'marketing');
  // Unknown input degrades to the catch-all team rather than throwing.
  assert.equal(defaultTeam('nonsense'), 'contact');
});

test('validators reject unknown values', () => {
  assert.equal(isSubject('order'), true);
  assert.equal(isSubject('order_problem'), false); // composed values are not stored
  assert.equal(isRequestKind('problem'), true);
  assert.equal(isRequestKind('problems'), false);
  assert.equal(isKnowledgeCategory('general'), false); // renamed to "other" in 011
  assert.equal(isKnowledgeCategory('shipping_delivery'), false); // renamed to "delivery"
});

test('composes a readable queue label', () => {
  assert.equal(describeTicketCategory('delivery', 'problem'), 'Delivery — problem');
  assert.equal(describeTicketCategory('return_exchange', 'question'), 'Return exchange — question');
  assert.equal(describeTicketCategory('order', null), 'Order');
});
