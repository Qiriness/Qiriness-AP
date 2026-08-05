import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CASE_FILE_SCHEMA,
  CAVEAT_CODES,
  MISSING_FIELDS,
  buildCaseFile,
  deriveDoNotClaim,
  toDraftingPrompt,
  toHumanBrief,
  verifyFindings
} from './case-file.mjs';

const LEDGER = [
  { id: 't1', tool: 'lookupPromotion', argsHash: 'a1', outcome: 'found' },
  { id: 't2', tool: 'lookupCustomer', argsHash: 'a2', outcome: 'found' }
];

const ANSWER = {
  verdict: 'answerable',
  established: [
    { claim: 'Le code BIENVENUE10 existe et est actif.', evidence_ids: ['t1'] },
    { claim: 'Il exige un minimum d’achat de 50 €.', evidence_ids: ['t1'] }
  ],
  unverified: [{ claim: 'Le panier atteint 50 €.', why: 'Aucune visibilité sur le panier.' }],
  missing: [],
  handoff: null
};

test('a claim citing a call that never ran is dropped', () => {
  // The model can restate what the CUSTOMER asserted as though a tool said it.
  // Requiring a ledger id is what separates the two.
  const { established, dropped } = verifyFindings(
    [
      { claim: 'Le code est actif.', evidence_ids: ['t1'] },
      { claim: 'Le colis a été livré.', evidence_ids: ['t9'] },
      { claim: 'Le client a trois commandes.', evidence_ids: [] }
    ],
    LEDGER
  );

  assert.deepEqual(established.map((f) => f.claim), ['Le code est actif.']);
  assert.equal(dropped.length, 2);
});

test('an answerable verdict resting on nothing becomes needs_human', () => {
  const caseFile = buildCaseFile({
    answer: { ...ANSWER, established: [{ claim: 'Tout va bien.', evidence_ids: ['t9'] }] },
    ledger: LEDGER
  });

  assert.equal(caseFile.verdict, 'needs_human');
  assert.equal(caseFile.replyIntent, 'acknowledge');
});

test('needs_customer_input with nothing named to ask for becomes needs_human', () => {
  // Otherwise the drafting stage has to invent the question.
  const caseFile = buildCaseFile({
    answer: { ...ANSWER, verdict: 'needs_customer_input', missing: [] },
    ledger: LEDGER
  });

  assert.equal(caseFile.verdict, 'needs_human');
});

test('the reply intent is derived from the verdict, never stored twice', () => {
  const intents = ['answerable', 'needs_customer_input', 'needs_human'].map((verdict) => {
    const answer = {
      ...ANSWER,
      verdict,
      missing: verdict === 'needs_customer_input' ? [{ field: 'shopify_order_number' }] : []
    };
    return buildCaseFile({ answer, ledger: LEDGER }).replyIntent;
  });

  assert.deepEqual(intents, ['answer', 'ask', 'acknowledge']);
});

test('the question asked of a customer comes from the table, not the model', () => {
  const caseFile = buildCaseFile({
    answer: {
      ...ANSWER,
      verdict: 'needs_customer_input',
      // A model-supplied wording would be ignored — only the key is read.
      missing: [{ field: 'shopify_order_number', ask: 'donne moi ton numéro' }]
    },
    ledger: LEDGER
  });

  const prompt = toDraftingPrompt(caseFile);
  assert.ok(prompt.includes(MISSING_FIELDS.shopify_order_number.ask));
  assert.ok(!prompt.includes('donne moi ton numéro'));
});

test('an unknown missing field is dropped rather than defaulted', () => {
  const caseFile = buildCaseFile({
    answer: { ...ANSWER, verdict: 'needs_customer_input', missing: [{ field: 'inventé' }] },
    ledger: LEDGER
  });

  assert.deepEqual(caseFile.missing, []);
  assert.equal(caseFile.verdict, 'needs_human', 'an invented field leaves nothing to ask');
});

test('prohibitions are derived from caveats and missing fields', () => {
  const lines = deriveDoNotClaim({
    caveats: ['basket_unseeable', 'eligibility_undetermined', 'not_a_caveat'],
    missing: [{ field: 'shopify_order_number' }]
  });

  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes('panier actuel')));
  assert.ok(lines.some((l) => l.includes('numéro de commande')));
  assert.ok(!lines.some((l) => l.includes('not_a_caveat')));
});

test('every caveat code renders a prohibition', () => {
  // A code the registry can emit but that produces no line would be a silent gap.
  const lines = deriveDoNotClaim({ caveats: CAVEAT_CODES });
  assert.equal(lines.length, CAVEAT_CODES.length);
});

test('the worked example: answerable, and still carrying a prohibition', () => {
  // The newsletter code — the biggest single cluster in the inbox. A boolean
  // `eligible` here produces "réessayez" and confirms a falsehood in writing.
  const caseFile = buildCaseFile({
    answer: ANSWER,
    ledger: LEDGER,
    caveats: ['basket_unseeable', 'eligibility_undetermined']
  });

  assert.equal(caseFile.verdict, 'answerable');
  assert.equal(caseFile.established.length, 2);
  assert.equal(caseFile.unverified.length, 1);
  assert.equal(caseFile.doNotClaim.length, 2);
});

test('the drafting prompt keeps facts, doubts, asks and prohibitions in separate sections', () => {
  const caseFile = buildCaseFile({
    answer: { ...ANSWER, missing: [{ field: 'promotion_code' }] },
    ledger: LEDGER,
    caveats: ['basket_unseeable']
  });
  const prompt = toDraftingPrompt(caseFile);

  const order = ['## Établi', '## Non vérifié', '## À demander au client', '## Ne pas affirmer']
    .map((heading) => prompt.indexOf(heading));

  assert.ok(order.every((index) => index >= 0), 'all four sections present');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'and in that order');
});

test('the drafting prompt never carries the internal handoff or the tool ledger', () => {
  const caseFile = buildCaseFile({
    answer: {
      ...ANSWER,
      verdict: 'needs_human',
      handoff: { action: 'Rembourser 24,90 € et relancer le transporteur.', why: 'Colis perdu.' }
    },
    ledger: LEDGER
  });

  const drafting = toDraftingPrompt(caseFile);
  assert.ok(!drafting.includes('Rembourser'));
  assert.ok(!drafting.includes('lookupPromotion'));

  const brief = toHumanBrief(caseFile);
  assert.ok(brief.includes('Rembourser'));
  assert.ok(brief.includes('lookupPromotion'));
});

test('an empty established section says so rather than staying silent', () => {
  const caseFile = buildCaseFile({ answer: { ...ANSWER, established: [] }, ledger: LEDGER });
  assert.ok(toDraftingPrompt(caseFile).includes('Aucun fait n’a pu être établi.'));
});

test('dropped claims are surfaced to the human, never to the drafting prompt', () => {
  const caseFile = buildCaseFile({
    answer: { ...ANSWER, established: [{ claim: 'Le colis est livré.', evidence_ids: ['t9'] }] },
    ledger: LEDGER
  });

  assert.ok(!toDraftingPrompt(caseFile).includes('Le colis est livré.'));
  assert.ok(toHumanBrief(caseFile).includes('Le colis est livré.'));
});

test('the context bundle is referenced, not copied', () => {
  const caseFile = buildCaseFile({
    answer: ANSWER,
    ledger: LEDGER,
    contextRef: { hasOrderContext: true, orderName: '#1006' }
  });

  const serialised = JSON.stringify(caseFile);
  assert.equal(caseFile.contextRef.orderName, '#1006');
  assert.ok(!serialised.includes('shipping_destination'), 'no order bundle inlined');
});

test('the schema constrains the model to the enums it is allowed to use', () => {
  const properties = CASE_FILE_SCHEMA.properties;
  assert.deepEqual(properties.verdict.enum, ['answerable', 'needs_customer_input', 'needs_human']);
  assert.deepEqual(
    properties.missing.items.properties.field.enum,
    Object.keys(MISSING_FIELDS)
  );
  // The code-derived fields must not be askable of the model.
  for (const forbidden of ['do_not_claim', 'knowledge', 'tool_calls', 'proposed_level']) {
    assert.equal(properties[forbidden], undefined, `${forbidden} must not be in the model schema`);
  }
});
