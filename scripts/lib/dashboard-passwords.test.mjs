import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_PASSWORD_LENGTH, validatePassword } from './dashboard-passwords.mjs';

test('twelve characters is the floor, and the message says so', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  const short = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
  assert.equal(short.ok, false);
  assert.match(short.error, /at least 12 characters/);
  assert.deepEqual(validatePassword('correct horse battery'), { ok: true });
});

test('a passphrase at exactly the minimum passes', () => {
  assert.deepEqual(validatePassword('abcdefghijkl'), { ok: true });
});

test('nothing, or something that is not a string, is not a password', () => {
  for (const value of [undefined, null, '', 12345678901234, {}]) {
    assert.equal(validatePassword(value).ok, false);
  }
});

test('one character repeated is refused however long it is', () => {
  assert.equal(validatePassword('aaaaaaaaaaaaaaaa').ok, false);
  assert.equal(validatePassword('aaaaaaaaaaaab').ok, true);
});

test('an absurdly long password is refused rather than sent on', () => {
  const long = 'passphrase-'.repeat(30); // 330 characters
  assert.equal(validatePassword(long).ok, false);
  assert.equal(validatePassword(long.slice(0, 256)).ok, true);
});
