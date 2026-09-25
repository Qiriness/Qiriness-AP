import assert from 'node:assert/strict';
import test from 'node:test';

import { createKlaviyoClient } from './klaviyo-client.mjs';

const KEY = 'pk_dummy0123456789abcdef0123';

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('every request carries the key, the revision, and follows pages', async () => {
  const seen = [];
  const pages = [
    reply(200, { data: [{ id: 'a' }], links: { next: 'https://a.klaviyo.com/api/metrics/?page[cursor]=2' } }),
    reply(200, { data: [{ id: 'b' }], links: { next: null } })
  ];
  const client = createKlaviyoClient(KEY, {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return pages.shift();
    }
  });
  assert.deepEqual((await client.listMetrics()).map((m) => m.id), ['a', 'b']);
  assert.equal(seen[0].init.headers.Authorization, `Klaviyo-API-Key ${KEY}`);
  assert.ok(seen[0].init.headers.revision);
  assert.equal(seen[1].url, 'https://a.klaviyo.com/api/metrics/?page[cursor]=2');
});

test('a 429 is waited out for as long as Retry-After says', async () => {
  const waits = [];
  const answers = [reply(429, {}, { 'retry-after': '12' }), reply(200, { data: { attributes: { results: [] } } })];
  const client = createKlaviyoClient(KEY, { fetchImpl: async () => answers.shift(), sleep: async (ms) => waits.push(ms) });
  await client.flowSeriesReport({});
  assert.deepEqual(waits, [12_000]);
});

test('an error names the call and Klaviyo\'s reason, never the key', async () => {
  const client = createKlaviyoClient(KEY, {
    fetchImpl: async () => reply(403, { errors: [{ detail: 'Missing scope flows:read' }] })
  });
  await assert.rejects(client.flowSeriesReport({}), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /flow-series-reports.*403.*flows:read/);
    assert.doesNotMatch(error.message, /pk_/);
    return true;
  });
});
