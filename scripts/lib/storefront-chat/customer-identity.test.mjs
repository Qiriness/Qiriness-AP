import assert from 'node:assert/strict';
import test from 'node:test';

import { ANONYMOUS, customerIdentity, identityOfHistory, identityRef, mayContinue, purchaseHistoryEnabled } from './customer-identity.mjs';

const SHOP = 'dev-store.myshopify.com';
const SECRET = 'hush';
const ON = { STOREFRONT_CHAT_PURCHASE_HISTORY: 'on' };

const query = (id) => new URLSearchParams({ shop: SHOP, logged_in_customer_id: id, timestamp: '1' });

test('off by default: a signed-in customer is anonymous unless the setting is on', () => {
  assert.equal(purchaseHistoryEnabled({}), false);
  assert.equal(purchaseHistoryEnabled({ STOREFRONT_CHAT_PURCHASE_HISTORY: 'true' }), false);
  assert.deepEqual(customerIdentity(query('7001'), { shop: SHOP, secret: SECRET, env: {} }), ANONYMOUS);
  assert.equal(purchaseHistoryEnabled({ STOREFRONT_CHAT_PURCHASE_HISTORY: ' ON ' }), true);
});

test('the signed id becomes a customer identity with a ref that is not the id', () => {
  const identity = customerIdentity(query('7001'), { shop: SHOP, secret: SECRET, env: ON });
  assert.equal(identity.kind, 'customer');
  assert.equal(identity.shopifyCustomerId, '7001');
  assert.match(identity.ref, /^[0-9a-f]{32}$/);
  assert.ok(!identity.ref.includes('7001'));
});

test('not signed in, or anything that is not a Shopify id, is anonymous', () => {
  for (const id of ['', '0', '-3', '12abc', 'jane@example.com', '#1001', '1'.repeat(21)]) {
    assert.deepEqual(customerIdentity(query(id), { shop: SHOP, secret: SECRET, env: ON }), ANONYMOUS, id);
  }
  assert.deepEqual(customerIdentity(new URLSearchParams({ shop: SHOP }), { shop: SHOP, secret: SECRET, env: ON }), ANONYMOUS);
  assert.deepEqual(customerIdentity(query('7001'), { shop: SHOP, secret: '', env: ON }), ANONYMOUS);
});

test('the ref is stable per customer and shop, and changes with either or the secret', () => {
  const ref = identityRef(SHOP, '7001', SECRET);
  assert.equal(identityRef('Dev-Store.myshopify.com', '7001', SECRET), ref);
  assert.notEqual(identityRef(SHOP, '7002', SECRET), ref);
  assert.notEqual(identityRef('other.myshopify.com', '7001', SECRET), ref);
  assert.notEqual(identityRef(SHOP, '7001', 'other'), ref);
});

test('a conversation belongs to whoever any assistant row names, else nobody', () => {
  assert.equal(identityOfHistory([]), null);
  assert.equal(identityOfHistory([{ role: 'user', content: 'x', context: { identity: 'forged' } }]), null);
  const history = [
    { role: 'assistant', content: 'a', context: { identity: 'ref-a' } },
    { role: 'user', content: 'b', context: {} },
    // written while the setting was off: carries no ref, releases nothing
    { role: 'assistant', content: 'c', context: {} },
  ];
  assert.equal(identityOfHistory(history), 'ref-a');
});

test('only the same customer continues a customer conversation; anonymous ones may be signed into', () => {
  const a = { kind: 'customer', shopifyCustomerId: '1', ref: 'ref-a' };
  const b = { kind: 'customer', shopifyCustomerId: '2', ref: 'ref-b' };
  assert.equal(mayContinue(null, ANONYMOUS), true);
  assert.equal(mayContinue(null, a), true);
  assert.equal(mayContinue('ref-a', a), true);
  assert.equal(mayContinue('ref-a', b), false);
  assert.equal(mayContinue('ref-a', ANONYMOUS), false);
});
