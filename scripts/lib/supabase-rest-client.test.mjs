import assert from 'node:assert/strict';
import test from 'node:test';

import { supabaseInsert, supabaseSelectAll, supabaseUpsert } from './supabase-rest-client.mjs';

const CLIENT = { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' };

/**
 * A PostgREST that caps every response at `maxRows` however large a Range is
 * asked for — the behaviour that silently truncated the clustering report.
 */
function stubCappedServer(totalRows, maxRows) {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, range: options.headers.Range });
    const [from, to] = options.headers.Range.split('-').map(Number);
    const end = Math.min(to, from + maxRows - 1, totalRows - 1);
    const rows = [];
    for (let i = from; i <= end; i += 1) {
      rows.push({ id: `row-${i}` });
    }
    return { ok: true, json: async () => rows };
  };
  return requests;
}

test('supabaseSelectAll pages past the silent 1000-row PostgREST cap', async () => {
  const originalFetch = globalThis.fetch;
  const requests = stubCappedServer(1111, 1000);

  let rows;
  try {
    rows = await supabaseSelectAll(CLIENT, 'ticket_messages', { direction: 'inbound' }, 'id');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The bug this replaces: one request, 1000 of 1111 rows, no error raised.
  assert.equal(rows.length, 1111);
  assert.deepEqual(new Set(rows.map((r) => r.id)).size, 1111);
  assert.deepEqual(requests.map((r) => r.range), ['0-999', '1000-1999', '1111-2110']);
});

test('supabaseSelectAll stays correct when the server cap is smaller than the page size', async () => {
  // Advancing by the requested page size rather than the rows actually returned
  // would stop after the first short page and silently lose the rest.
  const originalFetch = globalThis.fetch;
  stubCappedServer(250, 100);

  let rows;
  try {
    rows = await supabaseSelectAll(CLIENT, 'tickets', {}, 'id');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rows.length, 250);
});

test('supabaseSelectAll orders by id so offset paging cannot drop or repeat rows', async () => {
  const originalFetch = globalThis.fetch;
  const requests = stubCappedServer(10, 1000);

  try {
    await supabaseSelectAll(CLIENT, 'tickets', {}, 'id');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requests[0].url, /order=id.asc/);
});

test('supabaseSelectAll still honours an explicit limit', async () => {
  const originalFetch = globalThis.fetch;
  stubCappedServer(5000, 1000);

  let rows;
  try {
    rows = await supabaseSelectAll(CLIENT, 'tickets', {}, 'id', { limit: 1500 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rows.length, 1500);
});

test('supabaseSelectAll surfaces an error instead of returning a partial set', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: 'boom' })
  });

  try {
    await assert.rejects(
      () => supabaseSelectAll(CLIENT, 'tickets', {}, 'id'),
      /Supabase select from tickets failed: boom/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supabaseUpsert normalizes bulk rows with missing optional keys', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      json: async () => []
    };
  };

  try {
    await supabaseUpsert(
      { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
      'customers',
      [
        { shop_id: 'shop-1', shopify_customer_id: 'customer-1', email: 'a@example.com' },
        { shop_id: 'shop-1', shopify_customer_id: 'customer-2' }
      ],
      'shop_id,shopify_customer_id'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].email, null);
});

test('supabaseInsert normalizes bulk rows with missing optional keys', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      json: async () => []
    };
  };

  try {
    await supabaseInsert(
      { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
      'events',
      [
        { id: 'event-1', payload: {} },
        { id: 'event-2' }
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].payload, null);
});
