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

test('immutable ids are asked for on continuation pages too, beside the page size', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage(null, { immutableIds: true });
  assert.equal(calls.at(-1).headers.Prefer, 'IdType="ImmutableId", odata.maxpagesize=50');
  await client.getDeltaPage('https://graph/next', { immutableIds: true });
  assert.equal(calls.at(-1).headers.Prefer, 'IdType="ImmutableId", odata.maxpagesize=50');
});

test('without the option no id type is asked for, so stored REST ids keep matching', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage('https://graph/next', { top: 400 });
  assert.equal(calls.at(-1).headers.Prefer, undefined);
  await client.getDeltaPage(null);
  assert.doesNotMatch(calls.at(-1).headers.Prefer, /IdType/);
});

test('a delta link Graph refuses is flagged, with its status and code', async () => {
  for (const [status, code, rejected] of [[400, 'BadRequest', true], [410, 'SyncStateNotFound', true], [503, 'ServiceUnavailable', false]]) {
    const client = createGraphClient(CONFIG, { fetchImpl: failingFetch(status, code) });
    const error = await client.getDeltaPage('https://graph/saved').catch((e) => e);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.linkRejected, rejected, `${status} ${code}`);
  }
});

test('translation returns one entry per input, in order, with failures counted not thrown', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    }
    const body = JSON.parse(init.body);
    bodies.push(body);
    return {
      ok: true,
      json: async () => ({
        value: body.inputIds.map((id) =>
          id === 'gone' ? { sourceId: id, errorDetails: { code: 'Format' } } : { sourceId: id, targetId: `imm-${id}` }
        )
      })
    };
  };
  const client = createGraphClient(CONFIG, { fetchImpl });
  const ids = Array.from({ length: 501 }, (_, i) => (i === 3 ? 'gone' : `r${i}`));

  const results = await client.translateToImmutableIds(ids);

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].sourceIdType, 'restId');
  assert.equal(bodies[0].targetIdType, 'restImmutableEntryId');
  assert.equal(results.length, 501);
  assert.deepEqual(results[0], { sourceId: 'r0', targetId: 'imm-r0', error: null });
  assert.deepEqual(results[3], { sourceId: 'gone', targetId: null, error: 'Format' });
  assert.equal(results[500].targetId, 'imm-r500');
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

test('a delta read can start from Sent Items, and an unknown folder is refused', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, { fetchImpl: fakeFetch(calls) });
  await client.getDeltaPage(null, { folder: 'sentitems' });
  assert.match(calls.at(-1).url, /mailFolders\/sentitems\/messages\/delta/);
  await assert.rejects(client.getDeltaPage(null, { folder: 'drafts' }), /Unknown mail folder/);
});

// --- the send path ----------------------------------------------------------

function scriptedFetch(calls, responses) {
  return async (url, init = {}) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    }
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift() ?? { status: 200, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
}

test('a reply draft is createReply then a PATCH of body and recipients, asking for immutable ids', async () => {
  const calls = [];
  const client = createGraphClient(CONFIG, {
    fetchImpl: scriptedFetch(calls, [
      { status: 201, body: { id: 'AAMk-draft', internetMessageId: '<a@b>' } },
      { status: 200, body: { id: 'AAMk-draft', internetMessageId: '<a@b>' } }
    ])
  });
  const draft = await client.createReplyDraft('AAMk-customer', { html: '<p>Bonjour</p>', toRecipients: ['marie@example.com'] });
  assert.deepEqual(draft, { id: 'AAMk-draft', internetMessageId: '<a@b>' });

  const [create, patch] = calls;
  assert.equal(create.method, 'POST');
  assert.match(create.url, /\/users\/support%40example\.com\/messages\/AAMk-customer\/createReply$/);
  assert.equal(create.headers.Prefer, 'IdType="ImmutableId"');
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /\/messages\/AAMk-draft$/);
  assert.deepEqual(patch.body.toRecipients, [{ emailAddress: { address: 'marie@example.com' } }]);
  assert.deepEqual(patch.body.body, { contentType: 'html', content: '<p>Bonjour</p>' });
});

test('a reply draft needs a recipient', async () => {
  const client = createGraphClient(CONFIG, { fetchImpl: scriptedFetch([], []) });
  await assert.rejects(client.createReplyDraft('m', { html: 'x', toRecipients: [' '] }), /at least one recipient/);
});

test('sending posts to the draft, and a refusal carries Graph\'s code', async () => {
  const calls = [];
  const ok = createGraphClient(CONFIG, { fetchImpl: scriptedFetch(calls, [{ status: 202, body: null }]) });
  await ok.sendDraft('AAMk-draft');
  assert.match(calls.at(-1).url, /\/messages\/AAMk-draft\/send$/);

  const refused = createGraphClient(CONFIG, {
    fetchImpl: scriptedFetch([], [{ status: 403, body: { error: { code: 'ErrorAccessDenied' } } }])
  });
  await assert.rejects(refused.sendDraft('AAMk-draft'), /Graph send failed: ErrorAccessDenied/);
});

test('a draft\'s state: still a draft, sent, or gone', async () => {
  const client = createGraphClient(CONFIG, {
    fetchImpl: scriptedFetch([], [
      { status: 200, body: { id: 'd', isDraft: true } },
      { status: 200, body: { id: 'd', isDraft: false, internetMessageId: '<a@b>' } },
      { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
    ])
  });
  assert.deepEqual(await client.getDraftState('d'), { isDraft: true, internetMessageId: null });
  assert.deepEqual(await client.getDraftState('d'), { isDraft: false, internetMessageId: '<a@b>' });
  assert.equal(await client.getDraftState('d'), null);
});
