import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BY_MARKETPLACE_ORDER_NUMBER,
  BY_MESSAGE_EMAIL,
  BY_SENDER_EMAIL,
  CONFIRMED,
  MISMATCH,
  NAME_MATCH,
  NOT_FOUND,
  chooseResolution,
  isAnonymousPlaceholder,
  isSafeToWrite,
  verifyOrder
} from './order-verification.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

test('a matching email hash is proof, and is the only safe path', () => {
  // Both sides are sha256 of the trimmed lowercased address (hashIdentifier),
  // so they are directly comparable without either holding the raw address.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A },
    ticket: { requester_email_hash: HASH_A }
  });
  assert.equal(r.status, CONFIRMED);
  assert.equal(r.verifiedBy, BY_SENDER_EMAIL);
  assert.equal(isSafeToWrite(r.status), true);
});

test('the order’s own address in the message confirms it even though the sender differs', () => {
  // The measured case: 6 tickets whose order number parsed fine were refused as
  // `mismatch` while the order's registered address sat in the message — 3 of
  // them in a forwarded confirmation, 3 quoted some other way.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Paul Durand' },
    customer: { display_name: 'Marie Martin' },
    messageEmailHashes: [HASH_C, HASH_A]
  });
  assert.equal(r.status, CONFIRMED);
  assert.equal(r.verifiedBy, BY_MESSAGE_EMAIL, 'the weaker provenance stays visible');
  assert.equal(r.emailStatus, 'differs');
  assert.equal(isSafeToWrite(r.status), true);
});

test('the sender’s own address still ranks first when both paths would confirm', () => {
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A },
    ticket: { requester_email_hash: HASH_A },
    messageEmailHashes: [HASH_A]
  });
  assert.equal(r.verifiedBy, BY_SENDER_EMAIL);
});

test('the message-address path outranks a name agreement', () => {
  // Holding the address the order is registered to is stronger evidence than
  // two names looking alike.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Marie Martin' },
    customer: { display_name: 'Marie Martin' },
    messageEmailHashes: [HASH_A]
  });
  assert.equal(r.verifiedBy, BY_MESSAGE_EMAIL);
});

test('unrelated addresses in the message confirm nothing', () => {
  // A signature, a colleague on cc and a forwarded newsletter all put addresses
  // in the text. Only the order's own hash counts.
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Paul Durand' },
    customer: { display_name: 'Marie Martin' },
    messageEmailHashes: [HASH_B, HASH_C]
  });
  assert.equal(r.status, MISMATCH);
});

test('an order with no email hash is never confirmed by the message', () => {
  // Otherwise a null on both sides would compare equal and confirm everything.
  const r = verifyOrder({
    order: { customer_email_hash: null, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Paul Durand' },
    customer: { display_name: 'Marie Martin' },
    messageEmailHashes: [null, HASH_C]
  });
  assert.notEqual(r.status, CONFIRMED);
});

test('callers that pass no hashes get exactly the old behaviour', () => {
  const r = verifyOrder({
    order: { customer_email_hash: HASH_A, customer_id: 'c1' },
    ticket: { requester_email_hash: HASH_B, requester_name: 'Paul Durand' },
    customer: { display_name: 'Marie Martin' }
  });
  assert.equal(r.status, MISMATCH);
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

// --- marketplace orders with an anonymous buyer ------------------------------

// The real shape of an Amazon order (#6059): Shopify's placeholder buyer, and an
// email hash that can never be the customer's.
const AMAZON_ORDER = { customer_email_hash: HASH_A, customer_id: 'c1', sales_channel_handle: 'amazon' };
const ANONYMOUS = { display_name: 'Anonymous Customer', first_name: 'Anonymous', last_name: 'Customer', anonymous: true };
const CUSTOMER_TICKET = { requester_email_hash: HASH_B, requester_name: 'Joachim Randt' };

test('an anonymous Amazon order quoted as the only order number is confirmed, and labelled as such', () => {
  const r = verifyOrder({ order: AMAZON_ORDER, ticket: CUSTOMER_TICKET, customer: ANONYMOUS, soleOrderNumber: true });
  assert.equal(r.status, CONFIRMED);
  assert.equal(r.verifiedBy, BY_MARKETPLACE_ORDER_NUMBER, 'ownership was not checked, and that stays visible');
  assert.equal(r.suggestedAction, undefined, 'asking for the purchase email is pointless here');
  assert.equal(isSafeToWrite(r.status), true);
});

test('the marketplace path is closed unless the caller says the number stands alone', () => {
  // Default false: the tracking-number path and a message naming several orders
  // both leave it closed, and so does any caller written before it existed.
  const r = verifyOrder({ order: AMAZON_ORDER, ticket: CUSTOMER_TICKET, customer: ANONYMOUS });
  assert.equal(r.status, MISMATCH);
});

test('a web order with a different email is still a mismatch, even with the flag set', () => {
  const r = verifyOrder({
    order: { ...AMAZON_ORDER, sales_channel_handle: 'online_store' },
    ticket: CUSTOMER_TICKET,
    customer: { ...ANONYMOUS },
    soleOrderNumber: true
  });
  assert.equal(r.status, MISMATCH, 'the placeholder only counts on a marketplace channel');
});

test('a marketplace order with a real named buyer is not waved through', () => {
  // Yves Rocher (Mirakl) orders carry the buyer's real name: the name check can
  // work there, so the number alone is not enough.
  const r = verifyOrder({
    order: { customer_email_hash: null, customer_id: 'c1', sales_channel_handle: 'connect-dev-1' },
    ticket: CUSTOMER_TICKET,
    customer: { display_name: 'Audrey Regnier', anonymous: false },
    soleOrderNumber: true
  });
  assert.equal(r.status, NOT_FOUND);
});

test('the sender’s own email still outranks the marketplace path', () => {
  const r = verifyOrder({
    order: AMAZON_ORDER,
    ticket: { ...CUSTOMER_TICKET, requester_email_hash: HASH_A },
    customer: ANONYMOUS,
    soleOrderNumber: true
  });
  assert.equal(r.verifiedBy, BY_SENDER_EMAIL);
});

test('only the exact Amazon placeholder counts as anonymous', () => {
  assert.equal(
    isAnonymousPlaceholder({ first_name: 'Anonymous', last_name: 'Customer', email: 'anonymous-1036554851892@example.com' }),
    true
  );
  assert.equal(
    isAnonymousPlaceholder({ first_name: 'Anonymous', last_name: 'Customer', email: 'someone@gmail.com' }),
    false,
    'a real address is a real buyer'
  );
  assert.equal(
    isAnonymousPlaceholder({ first_name: 'Virginie', last_name: 'Fernier', email: 'x@example.com' }),
    false,
    'a real name is a real buyer'
  );
  assert.equal(isAnonymousPlaceholder({}), false);
  assert.equal(isAnonymousPlaceholder(), false);
});
