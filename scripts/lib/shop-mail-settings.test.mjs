import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRecipients, validateRecipients, validateSender } from './shop-mail-settings.mjs';

test('a sender is an email address, trimmed and lower-cased; empty clears it', () => {
  assert.deepEqual(validateSender('  Contact@Shop.Example '), { ok: true, value: 'contact@shop.example' });
  assert.deepEqual(validateSender(''), { ok: true, value: null });
  assert.deepEqual(validateSender(null), { ok: true, value: null });
  for (const bad of ['contact', 'contact@shop', 'a b@shop.example', 42]) assert.equal(validateSender(bad).ok, false, String(bad));
});

test('recipients: dashboard roles and any address, roles first, no repeats', () => {
  assert.deepEqual(
    validateRecipients([{ email: 'B@x.example' }, { role: 'management' }, { email: 'b@x.example' }, { email: 'a@x.example' }, { role: 'management' }]),
    { ok: true, value: [{ role: 'management' }, { email: 'a@x.example' }, { email: 'b@x.example' }] }
  );
  assert.deepEqual(validateRecipients(null), { ok: true, value: [] });
  assert.equal(validateRecipients([{ role: 'owner' }]).ok, false);
  assert.equal(validateRecipients([{ email: 'nope' }]).ok, false);
  assert.equal(validateRecipients([{ name: 'x' }]).ok, false);
  assert.equal(validateRecipients('a@x.example').ok, false);
});

test('a role stands for its active accounts when the mail goes; addresses go as they are', () => {
  const user = (email, role, banned_until = null) => ({ email, app_metadata: { dashboard_role: role }, banned_until });
  const users = [
    user('boss@x.example', 'management'),
    user('gone@x.example', 'management', '2999-01-01T00:00:00Z'),
    user('agent@x.example', 'contact'),
    user('Dev@x.example', 'developer')
  ];
  assert.deepEqual(resolveRecipients([{ role: 'management' }, { email: 'outside@y.example' }, { email: 'boss@x.example' }], users), [
    'boss@x.example',
    'outside@y.example'
  ]);
  assert.deepEqual(resolveRecipients([], users), []);
});
