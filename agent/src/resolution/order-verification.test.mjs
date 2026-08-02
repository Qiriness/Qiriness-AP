import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIRMED,
  MISMATCH,
  NAME_MATCH,
  NOT_FOUND,
  chooseResolution,
  isSafeToWrite,
  verifyOrder
} from './order-verification.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('a matching email hash is proof, and is the only safe path', () => {
  // Both sides are sha256 of the trimmed lowercased address (hashIdentifier),
  // so they are directly comparable without either holding the raw address.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A },
    ticket: { requester_email_hash: HASH_A }
  });
  assert.equal(r.status, CONFIRMED);
  assert.equal(r.verifiedBy, 'email');
  assert.equal(isSafeToWrite(r.status), true);
});

test('same person, second address: names agree so it is corroborated, not rejected', () => {
  // The ordinary real case — ordered from a personal address, wrote in from a
  // work one. An earlier version refused to look at the name once the emails
  // differed, collapsing this into a flat rejection.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Marie Martin' },
    customer: { display_name: 'Marie Martin' }
  });
  assert.equal(r.status, NAME_MATCH);
  assert.equal(r.emailStatus, 'differs');
  assert.equal(r.suggestedAction, 'ask_purchase_email');
  assert.equal(isSafeToWrite(r.status), false, 'corroboration is not proof');
});

test('different email AND different name is a mismatch', () => {
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Paul Durand' },
    customer: { display_name: 'Marie Martin' }
  });
  assert.equal(r.status, MISMATCH);
  assert.equal(isSafeToWrite(r.status), false);
});

test('every unresolved outcome suggests asking which email was used', () => {
  // The next step is data collection: the customer is the only one who can
  // settle which address the purchase was made with.
  const cases = [
    verifyOrder({ order: { customer_email_hash: HASH_A }, ticket: { requester_email_hash: HASH_B } }),
    verifyOrder({ order: { customer_email_hash: null }, ticket: { requester_email_hash: HASH_B } })
  ];
  for (const r of cases) {
    assert.equal(r.suggestedAction, 'ask_purchase_email', r.status);
  }
});

test('names are compared without accents or case', () => {
  const r = verifyOrder({
    order: { customer_email_hash: null, customer_id: 'c1' },
    ticket: { requester_email_hash: null, requester_name: 'Hélène Dupré' },
    customer: { first_name: 'HELENE', last_name: 'dupre' }
  });
  assert.equal(r.status, NAME_MATCH);
});

test('a single-token name is too weak to be evidence', () => {
  const r = verifyOrder({
    order: { customer_email_hash: null, customer_id: 'c1' },
    ticket: { requester_email_hash: null, requester_name: 'Marie' },
    customer: { display_name: 'Marie' }
  });
  assert.equal(r.status, NOT_FOUND);
});

test('a missing order is not found', () => {
  assert.equal(verifyOrder({ order: null, ticket: {} }).status, NOT_FOUND);
});

test('a confirmed match wins wherever it appeared', () => {
  const chosen = chooseResolution([
    { status: NOT_FOUND },
    { status: CONFIRMED, orderNumber: 4854 },
    { status: NAME_MATCH }
  ]);
  assert.equal(chosen.status, CONFIRMED);
});

test('a mismatch surfaces rather than being buried behind a not-found', () => {
  // Someone asking about an order that is not theirs is something a human
  // should see.
  assert.equal(chooseResolution([{ status: NOT_FOUND }, { status: MISMATCH }]).status, MISMATCH);
});

test('no candidates at all yields a clean verdict', () => {
  assert.equal(chooseResolution([]).status, 'no_candidate');
});
