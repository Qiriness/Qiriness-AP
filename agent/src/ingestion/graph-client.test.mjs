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
