import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGraphClient } from './graph-client.mjs';

const CONFIG = {
  graph: { tenantId: 't', clientId: 'c', clientSecret: 's', mailbox: 'support@example.com' }
};

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    if (String(url).includes('oauth2')) {
      return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({ value: [], '@odata.deltaLink': 'https://delta' }) };
  };
}

test('a limited initial read asks for the newest mail first', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage(null, { top: 400 });
  const read = calls.at(-1);
  assert.match(read.url, /\$orderby=receivedDateTime desc$/);
  assert.equal(read.headers.Prefer, 'odata.maxpagesize=400');
});

test('an unlimited initial read is unchanged, because its deltaLink becomes the cursor', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage(null);
  assert.doesNotMatch(calls.at(-1).url, /orderby/);
});

test('a continuation link is followed verbatim', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage('https://graph/next', { top: 400 });
  assert.equal(calls.at(-1).url, 'https://graph/next');
});

// --- wrong mailbox vs missing mail -------------------------------------------

/** Answers every Graph read with one error payload, at one status. */
function failingFetch(status, code) {
  return async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    }
    return { ok: false, status, json: async () => ({ error: { code } }) };
  };
}

// All three readers share the branch, so all three are asserted: the bug was
// survivable precisely because only one of them was ever exercised by hand.
const READERS = [
  ['getMessage', (c) => c.getMessage('AAMk-id')],
  ['getAttachmentMetadata', (c) => c.getAttachmentMetadata('AAMk-id')],
  ['listAttachmentHandles', (c) => c.listAttachmentHandles('AAMk-id')],
];

test('a 404 ErrorInvalidUser is a wrong mailbox, not a message that left', async () => {
  // MEASURED 2026-09-20: a SUPPORT_MAILBOX naming another address, in this
  // domain or another tenant, answers 404 ErrorInvalidUser. Returning null for
  // it told operators the mail was gone while it sat in the real mailbox.
  for (const [name, call] of READERS) {
    const client = createGraphClient(CONFIG, {
      fetchImpl: failingFetch(404, 'ErrorInvalidUser'),
    });
    await assert.rejects(
      () => call(client),
      (error) => {
        assert.equal(error.mailboxMismatch, true, `${name} must flag the mailbox`);
        assert.equal(error.code, 'ErrorInvalidUser');
        assert.match(error.message, /SUPPORT_MAILBOX/);
        return true;
      },
      name
    );
  }
});

test('a mailbox-scoped id is still a wrong mailbox, at any status', async () => {
  for (const [name, call] of READERS) {
    const client = createGraphClient(CONFIG, {
      fetchImpl: failingFetch(400, 'ErrorInvalidMailboxItemId'),
    });
    await assert.rejects(
      () => call(client),
      (error) => error.mailboxMismatch === true,
      name
    );
  }
});

test('a 404 that is not about the mailbox still means the message is gone', async () => {
  // The distinction the fix turns on: `ErrorItemNotFound` is a real deletion
  // from the right mailbox, and must keep returning null rather than throwing.
  for (const [name, call] of READERS) {
    const client = createGraphClient(CONFIG, {
      fetchImpl: failingFetch(404, 'ErrorItemNotFound'),
    });
    assert.equal(await call(client), null, name);
  }
});
