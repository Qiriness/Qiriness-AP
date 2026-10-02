import assert from 'node:assert/strict';
import test from 'node:test';

import { ORDER_IDENTITY_SITUATIONS, orderIdentitySituation } from './order-identity.mjs';
import { askSentence, buildCaseFile, toDraftingPrompt } from '../investigation/case-file.mjs';
import {
  fieldsAlreadyAnswered,
  fieldsAskedInstead,
  findingValues
} from '../investigation/evidence-rules.mjs';

// --- which situation ----------------------------------------------------------

test('a confirmed order is resolved, whatever the metadata says', () => {
  assert.deepEqual(orderIdentitySituation({ shopifyOrderNumber: '#4854', resolution: { status: 'mismatch' } }), {
    situation: 'resolved',
    orderName: '#4854'
  });
});

test('no reference splits on whether the sender is a customer of ours', () => {
  const resolution = { status: 'no_candidate', unmatched_reference: false };
  assert.equal(orderIdentitySituation({ resolution, customerId: 'c1' }).situation, 'no_number_known_sender');
  assert.equal(orderIdentitySituation({ resolution, customerId: null }).situation, 'no_number_unknown_sender');
  // The pass has not reached the ticket yet: no reference is held either way.
  assert.equal(orderIdentitySituation({ customerId: null }).situation, 'no_number_unknown_sender');
});

test('a reference that leads to no order asks for it to be checked', () => {
  assert.equal(orderIdentitySituation({ resolution: { status: 'not_found' } }).situation, 'number_not_found');
  // A warehouse `Q00…` reference or an unknown parcel number.
  assert.equal(
    orderIdentitySituation({ resolution: { status: 'no_candidate', unmatched_reference: true } }).situation,
    'number_not_found'
  );
});

test('an order found under another address names that order', () => {
  assert.deepEqual(
    orderIdentitySituation({ resolution: { status: 'mismatch', found_order_name: '#6668' } }),
    { situation: 'other_email', orderName: '#6668' }
  );
  assert.deepEqual(
    orderIdentitySituation({ resolution: { status: 'name_match', found_order_name: '#6711' } }),
    { situation: 'other_email_same_name', orderName: '#6711' }
  );
  // The order exists but one side had no address to compare.
  assert.equal(
    orderIdentitySituation({ resolution: { status: 'not_found', found_order_name: '#6711' } }).situation,
    'other_email'
  );
});

test('every situation is a value a rule can branch on', () => {
  const values = findingValues('order_identity');
  for (const situation of ORDER_IDENTITY_SITUATIONS) {
    assert.ok(values.includes(situation), situation);
  }
  assert.ok(!values.includes('none'), '`none` was split, and a stale value would make a rule unconditional');
});

// --- which question -----------------------------------------------------------

const ASKS_BOTH = {
  situation_key: 'D-05',
  answer_key: 'd05',
  route: 'needs_customer_input',
  ask: ['shopify_order_number', 'purchase_email']
};

function caseFileFor(situation, { policy = ASKS_BOTH, modelMissing = [], order = null } = {}) {
  const findings = { order_identity: situation };
  return buildCaseFile({
    answer: { verdict: 'needs_customer_input', established: [], unverified: [], missing: modelMissing },
    policy,
    answeredFields: [...fieldsAlreadyAnswered(findings)],
    askedInstead: fieldsAskedInstead(findings),
    askDetails: order ? { purchase_email: { order } } : {},
    ledger: [],
    model: 'test'
  });
}

test('no number from an unknown sender asks for both', () => {
  assert.deepEqual(
    caseFileFor('no_number_unknown_sender').missing.map((m) => m.field),
    ['shopify_order_number', 'purchase_email']
  );
});

test('no number from a known customer asks for the number only', () => {
  assert.deepEqual(caseFileFor('no_number_known_sender').missing, [{ field: 'shopify_order_number' }]);
});

test('an order found under another address asks for the address, naming the order', () => {
  const built = caseFileFor('other_email', { order: '#6668' });
  assert.deepEqual(built.missing, [{ field: 'purchase_email', order: '#6668' }]);
  assert.match(askSentence(built.missing[0]), /#6668/);
  assert.match(toDraftingPrompt(built), /commande #6668/);
  assert.doesNotMatch(toDraftingPrompt(built), /numéro de commande \(au format/);
});

test('a rule asking only for the number gets the address question instead', () => {
  const numberOnly = { ...ASKS_BOTH, ask: ['shopify_order_number'] };
  const built = caseFileFor('other_email_same_name', { policy: numberOnly, order: '#6711' });
  assert.deepEqual(built.missing, [{ field: 'purchase_email', order: '#6711' }]);
});

test('the model cannot put back a question the dossier answers', () => {
  const built = caseFileFor('other_email', {
    policy: null,
    modelMissing: [{ field: 'shopify_order_number' }],
    order: '#6668'
  });
  assert.deepEqual(built.missing, [{ field: 'purchase_email', order: '#6668' }]);
});

test('a reference that led nowhere still asks for the number', () => {
  const fields = caseFileFor('number_not_found').missing.map((m) => m.field);
  assert.ok(fields.includes('shopify_order_number'));
});

test('without an order the address question keeps its plain wording', () => {
  assert.equal(
    askSentence({ field: 'purchase_email' }),
    'Avec quelle adresse e-mail la commande a-t-elle été passée ?'
  );
});
