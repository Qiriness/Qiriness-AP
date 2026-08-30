import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// --- the last-order candidate ------------------------------------------------

const CANDIDATE_BUNDLE = {
  order: {
    name: '#6576',
    status: { fulfillment: 'FULFILLED', payment: 'PAID' },
    items: [{ title: 'Masque LED' }],
    delivery: { tracking: [{ number: '6C21143473070', carrier: 'COLISSIMO' }] }
  }
};

const CANDIDATE_ANSWER = {
  verdict: 'needs_customer_input',
  established: [],
  unverified: [],
  missing: [{ field: 'shopify_order_number' }]
};

test('the candidate is supplied by the runner, not derived from the ledger', () => {
  // It must not depend on whether the model happened to call an order tool: a
  // `product` ticket has no order tool at all, and that is precisely the subject
  // where a reviewer most wants to see recent orders.
  const caseFile = buildCaseFile({ answer: CANDIDATE_ANSWER, candidateOrder: CANDIDATE_BUNDLE });
  assert.equal(caseFile.candidateOrder.order.name, '#6576');
});

test('no candidate supplied reads as empty, never undefined', () => {
  assert.deepEqual(buildCaseFile({ answer: CANDIDATE_ANSWER }).candidateOrder, {});
});

test('the candidate never reaches the drafting prompt', () => {
  // THE PROPERTY THIS WHOLE FIELD DEPENDS ON. The customer named no order, so
  // the number may be the wrong one -- and a number a model can see is a number
  // it can quote.
  const caseFile = buildCaseFile({ answer: CANDIDATE_ANSWER, candidateOrder: CANDIDATE_BUNDLE });
  const prompt = toDraftingPrompt(caseFile);
  assert.ok(!prompt.includes('#6576'));
  assert.ok(!prompt.includes('6C21143473070'));
});

test('the candidate reaches the human brief, with status, items and tracking', () => {
  const brief = toHumanBrief(
    buildCaseFile({ answer: CANDIDATE_ANSWER, candidateOrder: CANDIDATE_BUNDLE })
  );
  assert.ok(brief.includes('#6576'));
  assert.ok(brief.includes('FULFILLED'));
  assert.ok(brief.includes('Masque LED'));
  assert.ok(brief.includes('6C21143473070'));
});

test('the candidate changes no verdict and asks for nothing extra', () => {
  // Surfacing recent orders on a product or return_exchange ticket must not turn
  // into "please give us your order number".
  const without = buildCaseFile({ answer: CANDIDATE_ANSWER });
  const with_ = buildCaseFile({ answer: CANDIDATE_ANSWER, candidateOrder: CANDIDATE_BUNDLE });
  assert.equal(with_.verdict, without.verdict);
  assert.deepEqual(with_.missing, without.missing);

  const answerable = { verdict: 'answerable', established: [{ claim: 'x', evidence_ids: ['c1'] }], unverified: [], missing: [] };
  const ledger = [{ id: 'c1', tool: 'lookupProduct', outcome: 'found' }];
  const enriched = buildCaseFile({ answer: answerable, ledger, candidateOrder: CANDIDATE_BUNDLE });
  assert.equal(enriched.verdict, 'answerable');
  assert.deepEqual(enriched.missing, []);
});

test('every askable fact is declared exactly once, and asks for the packaging', () => {
  // A DUPLICATE KEY IS SILENT. `photo` was declared twice in MISSING_FIELDS and
  // the second won, so the live request asked only for « une photo du produit
  // concerné » while the one asking for the product AND ITS PACKAGING sat above
  // it, unreachable. Nothing could catch that by reading the object at runtime —
  // by then there is one key — so the check is against the source text.
  //
  // The packaging is the evidence on « il manque un article dans le colis »:
  // there is no product to photograph, and whether there was room for the
  // missing item is visible in the box.
  const source = readFileSync(new URL('./case-file.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export const MISSING_FIELDS'), source.indexOf('export const CAVEATS'));
  for (const key of Object.keys(MISSING_FIELDS)) {
    const declarations = block.split(new RegExp(`^  ${key}: \{`, 'm')).length - 1;
    assert.equal(declarations, 1, `${key} is declared ${declarations} times`);
  }
  assert.match(MISSING_FIELDS.photo.ask, /emballage/);
});

// --- the policy rule, applied ------------------------------------------------

test('a rule tightens the verdict, and records what it moved from', () => {
  // Live now, not shadow: the route is applied. `verdict_before_policy` is what
  // makes the layer auditable afterwards — without it there is no way to tell a
  // rule that moved a ticket from one that agreed with where it already was.
  const caseFile = buildCaseFile({
    answer: {
      verdict: 'answerable',
      established: [{ claim: 'La commande est livrée.', evidence_ids: ['t1'] }],
      unverified: [],
      missing: [],
      handoff: null
    },
    ledger: [{ id: 't1', tool: 'getOrderContext', outcome: 'found' }],
    policy: { answer_key: 'livraison_contestee', route: 'needs_human', ask: null, verdict: 'selected' }
  });

  assert.equal(caseFile.verdict, 'needs_human');
  assert.equal(caseFile.policy.verdict_before_policy, 'answerable');
  assert.equal(caseFile.policy.applied, true);
});

test('a rule may never loosen a verdict, only tighten it', () => {
  // THE HALF THE SCHEMA CANNOT ENFORCE. The check constraint stops a rule
  // routing to `answerable`; nothing in the database stops one routing to
  // `needs_customer_input` on a ticket the investigation had already handed to a
  // person. A written policy is a floor under the verdict, never a ceiling — the
  // investigation saw this ticket, the rule saw a category.
  const caseFile = buildCaseFile({
    answer: { verdict: 'needs_human', established: [], unverified: [], missing: [], handoff: null },
    policy: { answer_key: 'x', route: 'needs_customer_input', ask: 'photo', verdict: 'selected' }
  });

  assert.equal(caseFile.verdict, 'needs_human');
  assert.equal(caseFile.policy.applied, false);
  assert.deepEqual(caseFile.missing, [], 'and it must not smuggle the question in either');
});

test('a rule that asks brings its question with it', () => {
  // Without this the verdict says "ask the customer" and nothing is named to
  // ask, which the rule below turns straight back into needs_human — silently
  // undoing the rule that had just fired.
  const caseFile = buildCaseFile({
    answer: {
      verdict: 'answerable',
      established: [{ claim: 'Le colis est livré.', evidence_ids: ['t1'] }],
      unverified: [],
      missing: [],
      handoff: null
    },
    ledger: [{ id: 't1', tool: 'getOrderContext', outcome: 'found' }],
    policy: { answer_key: 'photo_demandee', route: 'needs_customer_input', ask: 'photo', verdict: 'selected' }
  });

  assert.equal(caseFile.verdict, 'needs_customer_input');
  assert.deepEqual(caseFile.missing, [{ field: 'photo' }]);
});

test('an ask already named is not added twice', () => {
  const caseFile = buildCaseFile({
    answer: {
      verdict: 'answerable',
      established: [{ claim: 'x', evidence_ids: ['t1'] }],
      unverified: [],
      missing: [{ field: 'photo' }],
      handoff: null
    },
    ledger: [{ id: 't1', tool: 'getOrderContext', outcome: 'found' }],
    policy: { answer_key: 'y', route: 'needs_customer_input', ask: 'photo', verdict: 'selected' }
  });
  assert.deepEqual(caseFile.missing, [{ field: 'photo' }]);
});

test('a rule agreeing with the verdict changes nothing and says so', () => {
  const caseFile = buildCaseFile({
    answer: { verdict: 'needs_human', established: [], unverified: [], missing: [], handoff: null },
    policy: { answer_key: 'article_manquant', route: 'needs_human', verdict: 'selected' }
  });
  assert.equal(caseFile.policy.applied, false);
  assert.equal(caseFile.policy.verdict_before_policy, 'needs_human');
});

test('a rule that only supplies wording leaves the verdict alone', () => {
  const caseFile = buildCaseFile({
    answer: { verdict: 'answerable', established: [{ claim: 'x', evidence_ids: ['t1'] }], unverified: [], missing: [], handoff: null },
    ledger: [{ id: 't1', tool: 'getOrderContext', outcome: 'found' }],
    policy: { answer_key: 'non_expediee', route: null, verdict: 'selected' }
  });
  assert.equal(caseFile.verdict, 'answerable');
  assert.equal(caseFile.policy.applied, false);
});

test('no rules, no policy field — not an empty shell', () => {
  const caseFile = buildCaseFile({
    answer: { verdict: 'needs_human', established: [], unverified: [], missing: [], handoff: null }
  });
  assert.equal(caseFile.policy, null);
});

// --- the dashboard's copy of this vocabulary ---------------------------------
//
// A TEXT ASSERTION OVER A TYPESCRIPT FILE, which is the same shape as the
// migration tests' assertions over `.sql`, and for the same reason: the file
// cannot be imported here, and the thing worth checking is a list of literals.
//
// WHY IT EXISTS. `MISSING_FIELD_LABELS` is the dashboard's English rendering of
// the keys this module owns the French sentence for, and `deriveAction` keeps
// only the fields present in it. So a key added here and not there does not
// break a build, does not throw, and does not warn — it renders « Ask the
// customer for . » with the list it was building come out empty. That is exactly
// what `purchase_channel` did, unnoticed, until 2026-08-30.
test('the dashboard labels every field this module can ask for', () => {
  const source = readFileSync(
    new URL('../../../web/lib/types.ts', import.meta.url),
    'utf8'
  );

  const labels = source.match(
    /export const MISSING_FIELD_LABELS: Record<MissingField, string> = \{([\s\S]*?)\n\};/
  );
  assert.ok(labels, 'MISSING_FIELD_LABELS not found in web/lib/types.ts');
  const labelled = [...labels[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);

  const union = source.match(/export type MissingField =\n([\s\S]*?);\n/);
  assert.ok(union, 'MissingField union not found in web/lib/types.ts');
  const declared = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  const owned = Object.keys(MISSING_FIELDS);
  assert.deepEqual([...labelled].sort(), [...owned].sort(), 'MISSING_FIELD_LABELS has drifted');
  assert.deepEqual([...declared].sort(), [...owned].sort(), 'the MissingField union has drifted');
});

// --- a rule that asks for two things ------------------------------------------

test('every field a rule asks for reaches `missing`, once each', () => {
  // THE CASE THIS EXISTS FOR: a reaction reported with no product named needs
  // the product AND the batch number. With one slot the rule had to drop one,
  // which turns a single reply into two round trips with somebody waiting on an
  // answer about their skin.
  const built = buildCaseFile({
    answer: { verdict: 'answerable', established: [{ claim: 'x', evidence_ids: ['t1'] }] },
    ledger: [{ id: 't1', tool: 'identifyReactionProduct', outcome: 'not_attributed' }],
    policy: {
      route: 'needs_customer_input',
      ask: ['reaction_product_name', 'lot_number']
    }
  });

  assert.equal(built.verdict, 'needs_customer_input');
  assert.deepEqual(
    built.missing.map((entry) => entry.field),
    ['reaction_product_name', 'lot_number']
  );
  // Both questions have to be findable by the drafting stage, or the second is
  // a field nothing can word.
  for (const entry of built.missing) {
    assert.ok(MISSING_FIELDS[entry.field]?.ask, `${entry.field} has no sentence`);
  }
});

test('a field the model already named is not asked for twice', () => {
  const built = buildCaseFile({
    answer: {
      verdict: 'answerable',
      established: [{ claim: 'x', evidence_ids: ['t1'] }],
      missing: [{ field: 'lot_number' }]
    },
    ledger: [{ id: 't1', tool: 'identifyReactionProduct', outcome: 'not_attributed' }],
    policy: { route: 'needs_customer_input', ask: ['reaction_product_name', 'lot_number'] }
  });
  assert.deepEqual(
    built.missing.map((entry) => entry.field),
    ['lot_number', 'reaction_product_name']
  );
});

test('a rule written before `ask` was a list still works', () => {
  // The column was singular until 2026-08-30 and the loader tolerates a bare
  // string. Asserted rather than assumed: the failure would be a rule that
  // silently asks for nothing, and a verdict of "ask the customer" with nothing
  // to ask for is turned straight back into needs_human.
  const built = buildCaseFile({
    answer: { verdict: 'answerable', established: [{ claim: 'x', evidence_ids: ['t1'] }] },
    ledger: [{ id: 't1', tool: 'lookupProduct', outcome: 'no_match' }],
    policy: { route: 'needs_customer_input', ask: 'product_name' }
  });
  assert.equal(built.verdict, 'needs_customer_input');
  assert.deepEqual(built.missing.map((entry) => entry.field), ['product_name']);
});

test('a rule that agrees with the verdict still contributes its questions', () => {
  // THE BUG THIS EXISTS FOR, found on a live reaction ticket. The asks used to
  // be pushed only when the ROUTE changed the verdict, so a rule that agreed
  // with the investigation contributed nothing — and the reply asked whatever
  // the model had thought of, which is the non-determinism the rules layer
  // exists to remove, arriving through the one branch where the two AGREED.
  const built = buildCaseFile({
    answer: {
      verdict: 'needs_customer_input',
      established: [{ claim: 'x', evidence_ids: ['t1'] }],
      missing: [{ field: 'photo' }]
    },
    ledger: [{ id: 't1', tool: 'identifyReactionProduct', outcome: 'not_attributed' }],
    policy: { route: 'needs_customer_input', ask: ['reaction_product_name', 'lot_number'] }
  });

  assert.equal(built.verdict, 'needs_customer_input');
  assert.deepEqual(
    built.missing.map((entry) => entry.field),
    ['photo', 'reaction_product_name', 'lot_number']
  );
});

test('a rule may not smuggle a question past a verdict that forbids asking', () => {
  // The mirror case, and the reason the branch is gated on the FINAL verdict.
  // The investigation concluded a person is needed; the rule cannot loosen that,
  // so its questions must not appear either — a `needs_human` draft is an
  // acknowledgement, and questions in one are a reply nobody decided to send.
  const built = buildCaseFile({
    answer: { verdict: 'needs_human', established: [{ claim: 'x', evidence_ids: ['t1'] }] },
    ledger: [{ id: 't1', tool: 'identifyReactionProduct', outcome: 'not_attributed' }],
    policy: { route: 'needs_customer_input', ask: ['reaction_product_name', 'lot_number'] }
  });
  assert.equal(built.verdict, 'needs_human');
  assert.deepEqual(built.missing, []);
});
