import assert from 'node:assert/strict';
import test from 'node:test';

import {
  supabaseHeaders,
  supabaseInsert,
  supabaseSelectAll,
  supabaseUpdateById,
  supabaseUpsert
} from './supabase-rest-client.mjs';

const CLIENT = { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' };

test('new Supabase API keys are sent as apikey only, not as bearer JWTs', () => {
  const headers = supabaseHeaders({ baseUrl: CLIENT.baseUrl, key: 'sb_secret_example' });

  assert.equal(headers.apikey, 'sb_secret_example');
  assert.equal(Object.hasOwn(headers, 'Authorization'), false);
});

test('legacy Supabase JWT keys still get the bearer Authorization header', () => {
  const legacyKey = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  const headers = supabaseHeaders({ baseUrl: CLIENT.baseUrl, key: legacyKey });

  assert.equal(headers.apikey, legacyKey);
  assert.equal(headers.Authorization, `Bearer ${legacyKey}`);
});

/**
 * A PostgREST that caps every response at `maxRows` however large a Range is
 * asked for — the behaviour that silently truncated the clustering report.
 */
function stubCappedServer(totalRows, maxRows) {
  const requests = [];
  // Ids sort as strings in the same order as their index, like a uuid primary key.
  const all = Array.from({ length: totalRows }, (_, i) => ({ id: `row-${String(i).padStart(6, '0')}`, n: i }));
  globalThis.fetch = async (url, options) => {
    const params = new URL(url).searchParams;
    const after = params.get('id')?.replace(/^gt\./, '') ?? null;
    requests.push({ url, range: options.headers.Range, after });
    const [from, to] = options.headers.Range.split('-').map(Number);
    const pool = after === null ? all : all.filter((row) => row.id > after);
    const end = Math.min(to, from + maxRows - 1, pool.length - 1);
    const columns = params.get('select').split(',');
    const rows = pool.slice(from, end + 1).map((row) =>
      columns.includes('*') ? row : Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
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
  // Keyset: every page starts at row 0 AFTER the last id seen, never at an offset.
  assert.deepEqual(requests.map((r) => [r.range, r.after]), [
    ['0-999', null],
    ['0-999', 'row-000999'],
    ['0-999', 'row-001110']
  ]);
});

test('supabaseSelectAll fetches id for the cursor and hands back only the columns asked for', async () => {
  // THE COST THIS REMOVES. Offset paging made Postgres re-read every earlier row
  // per page: on 61k customers that was 71% of all buffer reads in production.
  const originalFetch = globalThis.fetch;
  const requests = stubCappedServer(2500, 1000);

  let rows;
  try {
    rows = await supabaseSelectAll(CLIENT, 'customers', {}, 'n');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rows.length, 2500);
  assert.deepEqual(rows.slice(0, 2), [{ n: 0 }, { n: 1 }]);
  assert.equal(new Set(rows.map((r) => r.n)).size, 2500);
  assert.match(requests[0].url, /select=n%2Cid/);
});

test('supabaseSelectAll keeps offset paging for another sort order or an id filter', async () => {
  const originalFetch = globalThis.fetch;
  let requests = stubCappedServer(1500, 1000);
  try {
    await supabaseSelectAll(CLIENT, 'tickets', {}, 'id', { order: 'created_at.desc' });
    assert.deepEqual(requests.map((r) => [r.range, r.after]), [['0-999', null], ['1000-1999', null], ['1500-2499', null]]);

    requests = stubCappedServer(10, 1000);
    await supabaseSelectAll(CLIENT, 'tickets', { id: { operator: 'in', value: '(a,b)' } }, 'id');
    assert.match(requests[0].url, /id=in.%28a%2Cb%29/);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].range, '10-1009');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('returning minimal asks PostgREST for no body on upserts and updates', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push(options);
    return { ok: true, json: async () => { throw new Error('a minimal response has no body to parse'); } };
  };
  try {
    const upserted = await supabaseUpsert(CLIENT, 'customers', [{ id: 1 }], 'id', { returning: 'minimal' });
    const updated = await supabaseUpdateById(CLIENT, 'tickets', 't1', { status: 'open' }, { returning: 'minimal' });
    assert.deepEqual(upserted, []);
    assert.equal(updated, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0].headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(requests[1].headers.Prefer, 'return=minimal');
});

test('a limited read never asks for a bigger page than it keeps', async () => {
  const originalFetch = globalThis.fetch;
  const requests = stubCappedServer(5000, 1000);
  try {
    const rows = await supabaseSelectAll(CLIENT, 'tickets', {}, 'id', { limit: 500 });
    assert.equal(rows.length, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0].range, '0-499');
});
