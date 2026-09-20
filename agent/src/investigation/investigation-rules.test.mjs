import assert from 'node:assert/strict';
import test from 'node:test';

import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';
import {
  ENABLED_SUBJECTS,
  STALE_TRANSIT_DAYS,
  answerSetFor,
  TOOL_NAMES,
  allowedTools,
  escalationTriggers,
  isInvestigable,
  isTradeSender,
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

test('legal_privacy is deliberately toolless', () => {
  // An RGPD or legal request is answered by a person, and an agent reading
  // customer records to prepare one is exactly the access this codebase
  // minimises. `cosmetovigilance` was here too until 2026-08-30 — it now holds
  // one lookup, and the test below says what it may and may not reach.
  for (const kind of REQUEST_KINDS) {
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
    TOOL_NAMES.LOOKUP_STOCK,
    TOOL_NAMES.VERIFY_PURCHASE,
    TOOL_NAMES.CHECK_PHOTO_EVIDENCE,
    // Added 2026-08-31 for the advice half of this subject: `lookupProduct`
    // answers « parle-moi de ce produit », this answers « lequel me
    // conseillez-vous », which has no product to look up until it recommends one.
    TOOL_NAMES.RECOMMEND_PRODUCTS,
    // Added 2026-09-04: « avez-vous une offre sur ce produit » is a product
    // question whose answer lives in the promotions table.
    TOOL_NAMES.LOOKUP_PRODUCT_OFFER
  ]);
  assert.deepEqual(allowedTools('product_stock', 'question', 2), [
    TOOL_NAMES.LOOKUP_STOCK,
    TOOL_NAMES.LOOKUP_PRODUCT,
    TOOL_NAMES.LOOKUP_PRODUCT_OFFER
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

test('every subject where an item can arrive broken can look at a photo', () => {
  // `order` was the hole, and it was invisible because the need is raised at
  // runtime rather than declared in `requiredEvidence` — so no static check
  // could catch it and `photo_evidence` simply resolved `unavailable`. Ticket
  // d48f1c08 (« en el interior venia otra crema ») sat behind it while its photo
  // was on the record.
  for (const subject of ['order', 'delivery', 'return_exchange', 'product']) {
    assert.ok(
      allowedTools(subject, 'problem', 3).includes(TOOL_NAMES.CHECK_PHOTO_EVIDENCE),
      `${subject}/problem must be able to check a photo`
    );
  }
});

test('the photo tool stays out of subjects where nothing can be photographed', () => {
  // The other half of least privilege: a tool the model can spend a call on is a
  // tool it can then reason from.
  for (const subject of ['payment', 'account', 'promotions', 'other']) {
    assert.ok(
      !allowedTools(subject, 'problem', 3).includes(TOOL_NAMES.CHECK_PHOTO_EVIDENCE),
      `${subject}/problem has no photo case`
    );
  }
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

test('the enabled set and the tool table now say exactly the same thing', () => {
  // UNTIL 2026-08-13 THEY DID NOT, and the gap was the point: `delivery` carried
  // a full tool policy while being held out of ENABLED_SUBJECTS, because the
  // order data behind it was not there yet. That gap is closed, so the invariant
  // to protect is the agreement itself — a subject given tools but never enabled
  // is dormant code nobody notices, and one enabled with no tools is a ticket
  // routed nowhere.
  for (const subject of TICKET_SUBJECTS) {
    const hasTools = allowedTools(subject, 'problem', 2).length > 0;
    assert.equal(
      ENABLED_SUBJECTS.includes(subject),
      hasTools,
      `${subject}: enabled=${ENABLED_SUBJECTS.includes(subject)} but hasTools=${hasTools}`
    );
  }
});

test('isInvestigable refuses an empty tool set and level 4, whatever the subject', () => {
  assert.equal(isInvestigable({ category: 'promotions', request_kind: 'problem', level: 2 }), true);
  assert.equal(isInvestigable({ category: 'delivery', request_kind: 'problem', level: 2 }), true);
  // Level 4 strips every tool: a threat or an injury is not investigated.
  assert.equal(isInvestigable({ category: 'promotions', request_kind: 'problem', level: 4 }), false);
  // Deliberately empty tool sets, whatever the level.
  assert.equal(isInvestigable({ category: 'careers', request_kind: 'contact', level: 2 }), false);
  assert.equal(isInvestigable({ category: 'legal_privacy', request_kind: 'problem', level: 2 }), false);
  // `cosmetovigilance` WAS in that list until 2026-08-30. It is investigable now
  // because it has one lookup — and level 4 still strips it, which is the line
  // that matters: a hospitalisation reaches a person untouched.
  assert.equal(isInvestigable({ category: 'cosmetovigilance', request_kind: 'problem', level: 2 }), true);
  assert.equal(isInvestigable({ category: 'cosmetovigilance', request_kind: 'problem', level: 4 }), false);
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


test('a ticket linked as a duplicate is not investigated', () => {
  // Same rule as draftDecision: the linked ticket is the same conversation, and
  // gathering evidence for a reply nobody will send is a model call spent twice.
  const ticket = { category: 'delivery', request_kind: 'question', level: 1 };
  assert.equal(isInvestigable(ticket), true);
  assert.equal(isInvestigable({ ...ticket, duplicate_of_ticket_id: 'ticket-1' }), false);
});

// --- answer sets, and the one subject that gathers without answering ---------

test('a subject with no tools has no policy family', () => {
  // The direction that must always hold: a family for a subject the agent never
  // investigates could never be populated by anything.
  for (const subject of TICKET_SUBJECTS) {
    if (allowedTools(subject, 'problem', 2).length === 0) {
      assert.equal(answerSetFor(subject), null, subject);
    }
  }
});

test('the subjects that have tools and no rules are exactly the known gap', () => {
  // THE OTHER DIRECTION IS NOT AN INVARIANT, and pinning it here is how the gap
  // stays visible. `other` is investigable — it may search the knowledge base —
  // and has no policy family, so no rule can ever reach one of its tickets. That
  // is a dead end rather than an empty one, and it is deliberate only in the
  // sense that nobody has decided what `other` should do yet. This test fails
  // the day a family is added, which is the reminder to delete it.
  const gap = TICKET_SUBJECTS.filter(
    (subject) => allowedTools(subject, 'problem', 2).length > 0 && !answerSetFor(subject)
  );
  assert.deepEqual(gap, ['other']);
});

test('a family groups the subjects that share answers', () => {
  // The whole reason a set is not a category: « pas encore expédiée » answers a
  // delivery question and an order question, and keying rules to categories
  // would mean writing it twice.
  assert.equal(answerSetFor('order'), answerSetFor('delivery'));
  assert.equal(answerSetFor('product'), answerSetFor('product_stock'));
  assert.notEqual(answerSetFor('order'), answerSetFor('returns'));
});

test('every family name is English, like every other identifier here', () => {
  // They were French — commande, retour, promo, produit — which put two
  // languages in one namespace. French is what a customer reads; a key a
  // developer types is code.
  for (const subject of TICKET_SUBJECTS) {
    const set = answerSetFor(subject);
    if (!set) continue;
    assert.ok(/^[a-z_]+$/.test(set), set);
    assert.ok(!['commande', 'retour', 'promo', 'produit'].includes(set), `${set} is still French`);
  }
});

test('cosmetovigilance gathers, and cannot reach an order tool', () => {
  // Added 2026-08-30 so a person opens the ticket with the customer and the
  // approved guidance already on screen. What stays out is the ORDER FAMILY and
  // `verifyPurchase`: « nous ne trouvons aucune commande à votre nom » is a
  // particularly bad sentence to put in front of somebody reporting a reaction,
  // and those are the tools that produce it. That exclusion is the part of the
  // original decision that did not change.
  const tools = allowedTools('cosmetovigilance', 'problem', 2);
  assert.deepEqual(tools, [
    TOOL_NAMES.LOOKUP_CUSTOMER,
    TOOL_NAMES.SEARCH_KNOWLEDGE,
    // Added 2026-08-30. The one product tool this subject gets, and it is not
    // `lookupProduct` — see below, which now asserts the difference rather than
    // merely excluding the order family.
    TOOL_NAMES.IDENTIFY_REACTION_PRODUCT
  ]);
  for (const forbidden of [
    TOOL_NAMES.GET_ORDER_CONTEXT,
    TOOL_NAMES.VERIFY_PURCHASE,
    TOOL_NAMES.CHECK_PHOTO_EVIDENCE,
    // STILL OUT, NOW THAT A PRODUCT TOOL IS IN — which is the assertion worth
    // having. `lookupProduct` answers « quel produit ce message évoque-t-il »
    // and returns the ingredient list with it; a reaction email evokes several
    // products and the ingredient list is the raw material for a sentence about
    // cause. `identifyReactionProduct` asks which product the customer BLAMES
    // and returns an identity only.
    TOOL_NAMES.LOOKUP_PRODUCT
  ]) {
    assert.ok(!tools.includes(forbidden), `${forbidden} must stay out`);
  }
});

test('a level 4 reaction still gets nothing at all', () => {
  // The severity override sits above the table and is not weakened by giving the
  // subject a tool: hospitalisation reaches a person untouched.
  assert.deepEqual(allowedTools('cosmetovigilance', 'problem', 4), []);
});

test('cosmetovigilance is investigable, which is why it needs a rule', () => {
  // Tools make a subject investigable, and an investigable ticket is a draftable
  // one. The `cosmetovigilance` answer set carries a rule routing every ticket
  // to a person; this asserts the half that lives in code.
  assert.ok(isInvestigable({ category: 'cosmetovigilance', request_kind: 'problem', level: 2 }));
  assert.ok(ENABLED_SUBJECTS.includes('cosmetovigilance'));
  assert.equal(answerSetFor('cosmetovigilance'), 'cosmetovigilance');
});

test('a secondary b2b category takes the ticket out of scope, like a primary one', () => {
  // Ticket 7b95c755: a pharmacy's trade order, filed `order` + `b2b`, was
  // investigated as a Shopify order and drafted a request for a #XXXX number.
  assert.equal(isInvestigable({ category: 'b2b', request_kind: 'problem', level: 3 }), false);
  assert.equal(
    isInvestigable({ category: 'order', secondary_category: 'b2b', request_kind: 'problem', level: 3 }),
    false
  );
  assert.equal(
    isInvestigable({ category: 'order', secondary_category: 'product_stock', request_kind: 'problem', level: 3 }),
    true,
    'any other secondary category leaves scope exactly as it was'
  );
  assert.equal(isInvestigable({ category: 'order', secondary_category: null, request_kind: 'problem', level: 3 }), true);
});

test('only a retailer entry makes a sender trade mail', () => {
  assert.equal(isTradeSender({ label: 'retailer' }), true);
  for (const label of ['internal', 'contractor', 'logistics', 'courier']) {
    assert.equal(isTradeSender({ label }), false, label);
  }
  assert.equal(isTradeSender(null), false, 'an unlisted sender is a consumer');
  assert.equal(isTradeSender(undefined), false);
});
