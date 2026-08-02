import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emailDomain,
  isInternalSender,
  partitionByAudience,
  resolveInternalDomains
} from './message-audience.mjs';

test('the internal domain is derived from the support mailbox, not hardcoded', () => {
  assert.deepEqual(
    resolveInternalDomains({ supportMailbox: 'support@example.com' }),
    ['example.com']
  );
});

test('extra domains cover what the mailbox cannot imply, without duplicating it', () => {
  const domains = resolveInternalDomains({
    supportMailbox: 'support@example.com',
    extra: ['logistics.test', '@example.com', ' OTHER.test ']
  });
  assert.deepEqual(domains.sort(), ['example.com', 'logistics.test', 'other.test']);
});

test('no mailbox configured yields no internal domains, so nothing is misclassified', () => {
  assert.deepEqual(resolveInternalDomains({}), []);
  assert.deepEqual(resolveInternalDomains({ supportMailbox: 'not-an-address' }), []);
});

test('our own senders are recognised, customers are not', () => {
  const domains = ['example.com'];
  assert.equal(isInternalSender('colleague@example.com', domains), true);
  assert.equal(isInternalSender('Colleague@Example.COM ', domains), true);
  assert.equal(isInternalSender('shopper@gmail.com', domains), false);
});

test('subdomains of an internal domain are internal too', () => {
  assert.equal(isInternalSender('bot@mail.example.com', ['example.com']), true);
});

test('a lookalike domain is not internal', () => {
  // Suffix matching must not treat `notexample.com` as a subdomain of
  // `example.com`, or a real customer's mail would be hidden from the report.
  assert.equal(isInternalSender('someone@notexample.com', ['example.com']), false);
  assert.equal(isInternalSender('someone@example.com.evil.test', ['example.com']), false);
});

test('an unparseable sender is treated as a customer', () => {
  // The safe failure is over-reporting demand, not silently dropping a question.
  const domains = ['example.com'];
  assert.equal(isInternalSender(null, domains), false);
  assert.equal(isInternalSender('', domains), false);
  assert.equal(isInternalSender('no-at-sign', domains), false);
});

test('with no internal domains resolved, every sender counts as a customer', () => {
  assert.equal(isInternalSender('colleague@example.com', []), false);
});

test('partitioning returns both sides, so internal threads stay reportable', () => {
  const messages = [
    { id: 'a', from_email: 'shopper@gmail.com' },
    { id: 'b', from_email: 'colleague@example.com' },
    { id: 'c', from_email: 'another@customer.test' }
  ];
  const { customer, internal } = partitionByAudience(messages, ['example.com']);

  assert.deepEqual(customer.map((m) => m.id), ['a', 'c']);
  assert.deepEqual(internal.map((m) => m.id), ['b']);
});

test('emailDomain takes the part after the last @', () => {
  assert.equal(emailDomain('a@b@example.com'), 'example.com');
  assert.equal(emailDomain('plain'), null);
  assert.equal(emailDomain('trailing@'), null);
});
