import assert from 'node:assert/strict';
import test from 'node:test';

import { shopifyGraphql } from './shopify-admin-client.mjs';

const CLIENT = { endpoint: 'https://example.myshopify.com/admin/api/x/graphql.json', token: 't' };

/** Replaces global fetch with a scripted sequence of responses. */
function withFetch(responses) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    const next = responses[calls.length - 1];
    if (typeof next === 'function') return next();
    return next;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const throttled = () =>
  json({
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: {
      cost: { requestedQueryCost: 300, throttleStatus: { currentlyAvailable: 100, restoreRate: 1000 } }
    }
  });

test('a THROTTLED reply is retried, not thrown', async () => {
  // Shopify reports throttling as HTTP 200 with an error body, so status alone
  // never catches it. Unretried, the first one ended the sync partway.
  const f = withFetch([throttled(), json({ data: { ok: true } })]);
  try {
    const data = await shopifyGraphql(CLIENT, '{ x }');
    assert.deepEqual(data, { ok: true });
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test('a dropped connection is retried', async () => {
  const f = withFetch([
    () => { throw new Error('fetch failed'); },
    json({ data: { ok: 1 } })
  ]);
  try {
    assert.deepEqual(await shopifyGraphql(CLIENT, '{ x }'), { ok: 1 });
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test('a 429 is retried and a 500 is retried', async () => {
  for (const status of [429, 503]) {
    const f = withFetch([json({}, status), json({ data: { ok: status } })]);
    try {
      assert.deepEqual(await shopifyGraphql(CLIENT, '{ x }'), { ok: status });
      assert.equal(f.calls.length, 2, String(status));
    } finally {
      f.restore();
    }
  }
});

test('a 4xx is NOT retried — the request is wrong, not the timing', async () => {
  const f = withFetch([json({ errors: [{ message: 'Access denied' }] }, 403)]);
  try {
    await assert.rejects(() => shopifyGraphql(CLIENT, '{ x }'), /HTTP 403/);
    assert.equal(f.calls.length, 1, 'retrying a 403 only fails slower');
  } finally {
    f.restore();
  }
});

test('a real GraphQL error still throws rather than being retried away', async () => {
  // A missing scope must surface immediately, not after five silent retries.
  const f = withFetch([json({ errors: [{ message: 'Access denied for orders field.' }] })]);
  try {
    await assert.rejects(() => shopifyGraphql(CLIENT, '{ x }'), /Access denied for orders/);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('retries are bounded, so a permanent outage fails rather than hanging', async () => {
  const f = withFetch(Array.from({ length: 10 }, () => throttled()));
  try {
    await assert.rejects(() => shopifyGraphql(CLIENT, '{ x }'), /Throttled/);
    assert.ok(f.calls.length <= 5, `gave up after ${f.calls.length} attempts`);
  } finally {
    f.restore();
  }
});
