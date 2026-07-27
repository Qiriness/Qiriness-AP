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

test('no subject derives level 4 — severity does, not topic', () => {
  // Level 4 means "something really bad happened" (legal threat, hospitalisation,
  // grave injury), which only the email text can show. If any (subject, kind)
  // pair derived it, level 4 would come to mean "this topic" and the manager
  // queue would fill with routine mail.
  for (const subject of SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      assert.notEqual(defaultLevel(subject, kind), 4, `${subject}/${kind}`);
    }
  }
});

test('a reported reaction is a level 2 problem: the products are natural formulations', () => {
  assert.equal(defaultLevel('cosmetovigilance', 'question'), 1);
  assert.equal(defaultLevel('cosmetovigilance', 'problem'), 2);
  // Dissatisfaction still follows the generic complaint rule.
  assert.equal(defaultLevel('cosmetovigilance', 'complaint'), 3);
});

test('a privacy action needs a human but not a manager', () => {
  // An RGPD erasure/access request is routine work; only a threat of legal
  // action reaches 4, and that comes from the model reading the email.
  assert.equal(defaultLevel('legal_privacy', 'question'), 1);
  assert.equal(defaultLevel('legal_privacy', 'problem'), 3);
  assert.equal(defaultLevel('legal_privacy', 'complaint'), 3);
});

test('anything needing the customer\'s own record is level 2, general answers level 1', () => {
  // Measured against human labelling on real mail: most "problems" on these
  // subjects are answered by looking something up and replying, so flooring them
  // at 3 made a third of the review set unmatchable (clampLevel cannot go below
  // the floor). The model escalates to 3 itself when something must change.
  for (const subject of ['order', 'delivery', 'payment', 'account', 'product_stock', 'promotions']) {
    assert.equal(defaultLevel(subject, 'question'), 2, `${subject}/question`);
    assert.equal(defaultLevel(subject, 'problem'), 2, `${subject}/problem`);
  }
  for (const subject of ['product', 'b2b', 'careers', 'return_exchange']) {
    assert.equal(defaultLevel(subject, 'question'), 1, subject);
  }
});

test('problems on non-lookup subjects still floor at 3', () => {
  // Nothing to look up, so the only way to satisfy them is to change something.
  assert.equal(defaultLevel('return_exchange', 'problem'), 3);
  assert.equal(defaultLevel('product', 'problem'), 3);
});

test('complaints are always 3, contact is a forward', () => {
  // A complaint is dissatisfaction with no actionable request, so it is never
  // auto-handled regardless of subject.
  assert.equal(defaultLevel('delivery', 'complaint'), 3);
  assert.equal(defaultLevel('order', 'complaint'), 3);
  assert.equal(defaultLevel('b2b', 'contact'), 2);
});

test('the categoriser can escalate but never de-escalate', () => {
  // Model says 1 for a reported reaction (floor 2): floor wins.
  assert.equal(clampLevel('cosmetovigilance', 'problem', 1), 2);
  // Model says 4 for a simple product question: escalation is allowed — that is
  // the only route to 4, e.g. a customer threatening to sue over a product.
  assert.equal(clampLevel('product', 'question', 4), 4);
  // Model says 1 for an order problem (floor 2, a lookup subject): floor wins.
  assert.equal(clampLevel('order', 'problem', 1), 2);
  // ... and it may raise that same pair to 3 when something must change.
  assert.equal(clampLevel('order', 'problem', 3), 3);
  // A problem with nothing to look up still floors at 3.
  assert.equal(clampLevel('return_exchange', 'problem', 1), 3);
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
