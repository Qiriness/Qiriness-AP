import assert from 'node:assert/strict';
import test from 'node:test';

import { argsFor, collectedFindings, proposeCollection } from './collection-planner.mjs';
import { normaliseConditions } from './answer-selection.mjs';
import { NEED_KEYS, resolveNeeds } from './evidence-rules.mjs';
import { TOOL_NAMES } from './investigation-rules.mjs';

const PROMO_TOOLS = [
  TOOL_NAMES.EXTRACT_PROMOTION_CODES,
  TOOL_NAMES.LOOKUP_PROMOTION,
  TOOL_NAMES.LIST_ACTIVE_PROMOTIONS,
  TOOL_NAMES.LOOKUP_CUSTOMER,
  TOOL_NAMES.SEARCH_KNOWLEDGE
];

/** P-18: four rules, four distinct signatures on one need. */
const P18 = ['unknown', 'expired|not_yet_started|inactive', 'active', 'not_found'].map((values, i) => ({
  answerKey: `r${i}`,
  situationKey: 'P-18',
  isFallback: false,
  priority: 0,
  conditions: normaliseConditions({ promotion_validity: values.split('|') })
}));

const TICKET = { text: 'mon code BIENVENUE10 ne marche pas' };

// --- the distinction the whole module exists for ------------------------------

test('a need nothing attempted is undetermined; the same need attempted is not', () => {
  // BOTH READ `unknown`. The findings map cannot tell them apart, which is why
  // `nextNeed` fed that map proposes nothing on a real run — and why the planner
  // reads `state` instead.
  const attempted = resolveNeeds(
    NEED_KEYS,
    [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'none', data: { codes: [] } }],
    PROMO_TOOLS
  );

  const identity = attempted.find((item) => item.need === 'promotion_identity');
  const validity = attempted.find((item) => item.need === 'promotion_validity');
  assert.equal(identity.state, 'attempted');
  assert.equal(identity.finding, 'none');
  assert.equal(validity.state, 'not_attempted');
  assert.equal(validity.finding, 'unknown', 'the finding says unknown either way');

  const collected = collectedFindings(attempted);
  assert.equal(collected.promotion_identity, 'none', 'a tool spoke, so the finding counts');
  assert.ok(!('promotion_validity' in collected), 'nothing looked, so it is still open');
});

test('a need whose registry has no tool is settled, not open', () => {
  // `unavailable` means nothing here could ever establish it. Proposing it would
  // burn a call on a question this ticket cannot ask.
  const resolved = resolveNeeds(NEED_KEYS, [], [TOOL_NAMES.SEARCH_KNOWLEDGE]);
  const collected = collectedFindings(resolved);

  assert.equal(resolved.find((item) => item.need === 'order_state').state, 'unavailable');
  assert.ok('order_state' in collected, 'excluded from the candidates');
});

// --- turning a need into a call ----------------------------------------------

test('every code-callable tool gets the arguments its schema requires', () => {
  const ctx = { ticket: TICKET, ledger: [] };
  for (const tool of [
    TOOL_NAMES.SEARCH_KNOWLEDGE,
    TOOL_NAMES.LOOKUP_CUSTOMER,
    TOOL_NAMES.LIST_ACTIVE_PROMOTIONS,
    TOOL_NAMES.GET_ORDER_CONTEXT,
    TOOL_NAMES.VERIFY_PURCHASE,
    TOOL_NAMES.CHECK_PHOTO_EVIDENCE
  ]) {
    assert.deepEqual(argsFor(tool, ctx), {}, tool);
  }
  assert.deepEqual(argsFor(TOOL_NAMES.LOOKUP_PRODUCT, ctx), { question: TICKET.text });
  assert.deepEqual(argsFor(TOOL_NAMES.LOOKUP_STOCK, ctx), { question: TICKET.text });
  assert.deepEqual(argsFor(TOOL_NAMES.EXTRACT_PROMOTION_CODES, ctx), { text: TICKET.text });
  // `null` is the meaningful value, not a missing one: the tool reads the
  // concerns out of the message itself.
  assert.deepEqual(argsFor(TOOL_NAMES.RECOMMEND_PRODUCTS, ctx), { product: null });
});

test('the reaction tool can never be proposed, which is what excludes cosmetovigilance', () => {
  // Its arguments ARE the model's reading of the email. Nothing for code to
  // assemble, the same reason it is not an opening move.
  assert.equal(argsFor(TOOL_NAMES.IDENTIFY_REACTION_PRODUCT, { ticket: TICKET, ledger: [] }), null);
});

test('a promotion lookup chains from the extracted code, and is refused without one', () => {
  const found = [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'found', data: { codes: ['BIENVENUE10'] } }];
  assert.deepEqual(argsFor(TOOL_NAMES.LOOKUP_PROMOTION, { ticket: TICKET, ledger: found }), {
    code: 'BIENVENUE10'
  });

  const none = [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'none', data: { codes: [] } }];
  assert.equal(
    argsFor(TOOL_NAMES.LOOKUP_PROMOTION, { ticket: TICKET, ledger: none }),
    null,
    'a code is evidence; inventing one would be fabricating it'
  );
});

// --- the proposal ------------------------------------------------------------

test('P-18 with a code proposes the lookup that separates its four rules', () => {
  const ledger = [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'found', data: { codes: ['BIENVENUE10'] } }];
  const resolved = resolveNeeds(NEED_KEYS, ledger, PROMO_TOOLS);

  const proposal = proposeCollection(P18, resolved, {
    situationKey: 'P-18',
    ticket: TICKET,
    ledger,
    allowedTools: PROMO_TOOLS
  });

  assert.equal(proposal.need, 'promotion_validity');
  assert.equal(proposal.tool, TOOL_NAMES.LOOKUP_PROMOTION);
  assert.deepEqual(proposal.args, { code: 'BIENVENUE10' });
});

test('an unassemblable first choice falls through to the next tool for the same need', () => {
  // No code, so `lookupPromotion` cannot run — but `listActivePromotions` also
  // declares itself able to settle validity, and the vocabulary lists it second.
  const ledger = [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'none', data: { codes: [] } }];
  const resolved = resolveNeeds(NEED_KEYS, ledger, PROMO_TOOLS);

  const proposal = proposeCollection(P18, resolved, {
    situationKey: 'P-18',
    ticket: TICKET,
    ledger,
    allowedTools: PROMO_TOOLS
  });

  assert.equal(proposal.tool, TOOL_NAMES.LIST_ACTIVE_PROMOTIONS);
});

test('a tool the ticket is not allowed is never proposed', () => {
  const ledger = [{ id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'found', data: { codes: ['X'] } }];
  const resolved = resolveNeeds(NEED_KEYS, ledger, PROMO_TOOLS);

  const proposal = proposeCollection(P18, resolved, {
    situationKey: 'P-18',
    ticket: TICKET,
    ledger,
    // The registry this ticket actually got: no promotion tools at all.
    allowedTools: [TOOL_NAMES.SEARCH_KNOWLEDGE]
  });

  assert.equal(proposal, null);
});

test('nothing is proposed once one answer is left', () => {
  // The stopping condition that already exists: a need every live answer agrees
  // on cannot change the outcome, so collecting it learns nothing.
  const ledger = [
    { id: 't1', tool: TOOL_NAMES.EXTRACT_PROMOTION_CODES, outcome: 'found', data: { codes: ['X'] } },
    { id: 't2', tool: TOOL_NAMES.LOOKUP_PROMOTION, outcome: 'found', data: { found: true, checks: [] } }
  ];
  const resolved = resolveNeeds(NEED_KEYS, ledger, PROMO_TOOLS);

  assert.equal(
    proposeCollection(P18, resolved, { situationKey: 'P-18', ticket: TICKET, ledger, allowedTools: PROMO_TOOLS }),
    null
  );
});

test('rules with no conditions propose nothing rather than everything', () => {
  const conditionless = [{ answerKey: 'x', situationKey: 'D-02', isFallback: false, priority: 0, conditions: {} }];
  const resolved = resolveNeeds(NEED_KEYS, [], PROMO_TOOLS);

  assert.equal(
    proposeCollection(conditionless, resolved, {
      situationKey: 'D-02',
      ticket: TICKET,
      ledger: [],
      allowedTools: PROMO_TOOLS
    }),
    null
  );
});

test('the prerequisite walk reaches identity from validity', () => {
  // `DEPENDENCIES` puts `promotion_identity` ahead of `promotion_validity`, and
  // no rule branches on identity — this is the case that proves the walk runs,
  // because nothing else would ever collect it.
  const resolved = resolveNeeds(NEED_KEYS, [], PROMO_TOOLS);

  const proposal = proposeCollection(P18, resolved, {
    situationKey: 'P-18',
    ticket: TICKET,
    ledger: [],
    allowedTools: PROMO_TOOLS
  });

  assert.equal(proposal.need, 'promotion_identity');
  assert.equal(proposal.tool, TOOL_NAMES.EXTRACT_PROMOTION_CODES);
});
