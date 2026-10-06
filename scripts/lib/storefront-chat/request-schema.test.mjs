import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatRequestError, MAX_MESSAGE_CHARS, parseChatRequest } from './request-schema.mjs';

const TOKEN = '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f';

test('a full request is kept, trimmed and typed', () => {
  assert.deepEqual(parseChatRequest({
    sessionId: TOKEN.toUpperCase(),
    message: '  Quel soin pour une peau sèche ?  ',
    action: 'find_product',
    context: { pageType: 'product', productHandle: 'creme-hydratante', collectionHandle: null, locale: 'fr', path: '/products/creme-hydratante' }
  }), {
    sessionToken: TOKEN,
    message: 'Quel soin pour une peau sèche ?',
    action: 'find_product',
    choice: null,
    context: { pageType: 'product', productHandle: 'creme-hydratante', collectionHandle: null, locale: 'fr', path: '/products/creme-hydratante' }
  });
});

test('an empty, missing or oversized message is refused', () => {
  for (const body of [null, [], {}, { message: '   ' }, { message: 42 }, { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }]) {
    assert.throws(() => parseChatRequest(body), ChatRequestError);
  }
});

test('a malformed session token starts a new session rather than failing', () => {
  assert.equal(parseChatRequest({ message: 'bonjour', sessionId: 'not-a-uuid' }).sessionToken, null);
});

test('an unknown action is dropped, the message kept', () => {
  const parsed = parseChatRequest({ message: 'bonjour', action: 'run_sql' });
  assert.equal(parsed.action, null);
  assert.equal(parsed.message, 'bonjour');
});

test('context fields outside their shape are dropped, not passed on', () => {
  const { context } = parseChatRequest({
    message: 'bonjour',
    context: { pageType: 'product<script>', productHandle: 'a b', locale: 'fr-FR', path: '//evil.example/x', extra: 'ignored' }
  });
  assert.deepEqual(context, { pageType: null, productHandle: null, collectionHandle: null, locale: 'fr-FR', path: null });
});

test('the path loses its query and fragment', () => {
  const { context } = parseChatRequest({ message: 'bonjour', context: { path: '/account/login?email=a@b.fr#top' } });
  assert.equal(context.path, '/account/login');
});

test('accented handles are accepted', () => {
  assert.equal(parseChatRequest({ message: 'x', context: { productHandle: 'crème-éclat' } }).context.productHandle, 'crème-éclat');
});

test('a chip choice is kept when it looks like an id or a care type, dropped otherwise', () => {
  assert.equal(parseChatRequest({ message: 'Sérum', choice: 'Sérum' }).choice, 'Sérum');
  assert.equal(parseChatRequest({ message: 'x', choice: '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f' }).choice, '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f');
  assert.equal(parseChatRequest({ message: 'x', choice: '<script>' }).choice, null);
  assert.equal(parseChatRequest({ message: 'x', choice: 42 }).choice, null);
});
