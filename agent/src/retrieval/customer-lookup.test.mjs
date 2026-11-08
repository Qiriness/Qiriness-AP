import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';
import { postgrestPage } from '../../../scripts/lib/postgrest-paging-fake.mjs';
import { createCustomerLookup } from './customer-lookup.mjs';

const MARIE = {
  id: 'c1',
  shopify_customer_id: 'gid://shopify/Customer/1',
  display_name: 'Marie Martin',
  email: 'marie.martin@example.test',
  state: 'ENABLED',
  verified_email: true,
  tags: [],
  on_email_marketing_list: true,
  email_marketing_state: 'SUBSCRIBED',
  default_address_city: 'Lyon',
  default_address_country: 'France',
  number_of_orders: 4,
  amount_spent: '312.50',
  amount_spent_currency: 'EUR',
  last_order_name: '#1009',
  last_order_at: '2026-06-02T09:00:00Z',
  last_order_total: '89.50',
  rfm_group: 'LOYAL'
};

const PAUL = {
  id: 'c2',
  shopify_customer_id: 'gid://shopify/Customer/2',
  display_name: 'Paul Durand',
  email: 'Paul.Durand@Example.test',
  state: 'INVITED',
  verified_email: false,
  tags: [],
  on_email_marketing_list: false,
  number_of_orders: 1,
  amount_spent: '42.00',
  amount_spent_currency: 'EUR',
  rfm_group: 'NEW'
};

const CUSTOMERS = [MARIE, PAUL];

/**
 * Stands in for PostgREST: honours the filters this module actually sends
 * (`id`, `email=ilike`) and the `Range` header `supabaseSelectAll` pages by — a
 * mock that ignores the range returns the same page forever and hangs the test.
 */
function buildSupabase() {
  const queries = [];
  const inserts = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));

    if (init?.method === 'POST') {
      inserts.push({ table: parsed.pathname.split('/').pop(), body: JSON.parse(init.body) });
      return { ok: true, json: async () => JSON.parse(init.body) };
    }

    queries.push(String(url));
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    if (from > 0) {
      return { ok: true, json: async () => [] };
    }

    const id = parsed.searchParams.get('id');
    if (id) {
      return { ok: true, json: async () => CUSTOMERS.filter((c) => c.id === id.replace('eq.', '')) };
    }

    const email = parsed.searchParams.get('email');
    if (email?.startsWith('ilike.')) {
      const wanted = email.slice('ilike.'.length).toLowerCase();
      return { ok: true, json: async () => CUSTOMERS.filter((c) => c.email.toLowerCase() === wanted) };
    }

    return { ok: true, json: async () => CUSTOMERS };
  };

  return {
    queries,
    inserts,
    client: { baseUrl: 'https://example.test/rest/v1', key: 'test-key' },
    restore: () => { globalThis.fetch = originalFetch; }
  };
}

test('findByEmail matches case-insensitively', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });

  assert.equal((await lookup.findByEmail('marie.martin@example.test')).id, 'c1');
  assert.equal((await lookup.findByEmail('  PAUL.DURAND@example.TEST  ')).id, 'c2');
  assert.equal(await lookup.findByEmail('nobody@example.test'), null);
});

test('findByEmailHash resolves a ticket hash without a raw address', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const found = await lookup.findByEmailHash(hashIdentifier('marie.martin@example.test'));

  assert.equal(found.id, 'c1');
  assert.ok(
    !sb.queries.some((q) => q.includes('marie.martin')),
    'the raw address must never appear in a query'
  );
});

test('findByEmailHash matches the hash of an address stored with mixed case', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  // The ticket hashes what the sender typed; the customer row holds mixed case.
  // Both go through `hashIdentifier`, which lowercases, so they must still meet.
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  assert.equal((await lookup.findByEmailHash(hashIdentifier('paul.durand@example.test'))).id, 'c2');
});

test('the hash index is built once and reset by refresh()', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const hash = hashIdentifier('marie.martin@example.test');
  // One load is several requests, because `supabaseSelectAll` pages until it
  // gets an empty page. Count loads by watching the total move, not by
  // assuming a load is one request.
  const indexRequests = () => sb.queries.filter((q) => q.includes('select=id%2Cemail')).length;

  await lookup.findByEmailHash(hash);
  const afterFirst = indexRequests();
  assert.ok(afterFirst > 0);

  await lookup.findByEmailHash(hash);
  assert.equal(indexRequests(), afterFirst, 'the second lookup must reuse the cached index');

  lookup.refresh();
  await lookup.findByEmailHash(hash);
  assert.ok(indexRequests() > afterFirst, 'refresh() must force a rebuild');
});

test('lookupCustomer resolves from a ticket hash alone', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const result = await lookup.lookupCustomer({
    ticket: { requester_email_hash: hashIdentifier('marie.martin@example.test') }
  });

  assert.equal(result.found, true);
  assert.equal(result.matchedBy, 'email_hash');
  assert.equal(result.customer.ordersCount, 4);
  assert.equal(result.account.canSignIn, true);
  assert.ok(result.promptText.includes('Marie Martin'));
});

test('lookupCustomer returns the row id beside the bundle, never inside it', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  // The resolution pass writes this onto tickets.customer_id. It stays out of
  // the bundle because that shape is stored in tickets.resolved_context.customer.
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const result = await lookup.lookupCustomer({ email: 'marie.martin@example.test' });

  assert.equal(result.customerId, 'c1');
  assert.equal(result.customer.id, undefined);
});

test('lookupCustomer surfaces an account that was never activated', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const result = await lookup.lookupCustomer({ email: 'Paul.Durand@Example.test' });

  assert.equal(result.matchedBy, 'email');
  assert.equal(result.account.neverActivated, true);
  assert.ok(result.promptText.includes('jamais été activé'));
});

test('lookupCustomer distinguishes no match from no identifier', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });

  const noMatch = await lookup.lookupCustomer({ email: 'nobody@example.test' });
  assert.equal(noMatch.found, false);
  assert.equal(noMatch.reason, 'no_match');

  const noIdentifier = await lookup.lookupCustomer({ ticket: { requester_email_hash: null } });
  assert.equal(noIdentifier.found, false);
  assert.equal(noIdentifier.reason, 'no_identifier');
});

test('lookupCustomer writes a hashed data-access event on a hit', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1' });
  await lookup.lookupCustomer({ email: 'marie.martin@example.test' });

  const events = sb.inserts.filter((i) => i.table === 'data_access_events');
  assert.equal(events.length, 1);

  const [event] = events[0].body;
  assert.equal(event.action, 'customer_lookup');
  assert.equal(event.actor_type, 'service');
  assert.equal(event.resource_id_hash, hashIdentifier(MARIE.shopify_customer_id));
  assert.ok(!JSON.stringify(event).includes('marie.martin'), 'the audit row must not hold the address');
});

test('lookupCustomer still answers when the audit write fails', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      throw new Error('audit unavailable');
    }
    return inner(url, init);
  };

  const errors = [];
  const lookup = createCustomerLookup({
    supabase: sb.client,
    shopId: 's1',
    logger: { info() {}, error: (event) => errors.push(event) }
  });

  const result = await lookup.lookupCustomer({ email: 'marie.martin@example.test' });
  assert.equal(result.found, true);
  assert.deepEqual(errors, ['customer.audit_failed']);
});

test('the log line carries no personal data', async (t) => {
  const sb = buildSupabase();
  t.after(sb.restore);

  const logged = [];
  const lookup = createCustomerLookup({
    supabase: sb.client,
    shopId: 's1',
    audit: false,
    logger: { info: (event, fields) => logged.push({ event, fields }) }
  });

  await lookup.lookupCustomer({ email: 'marie.martin@example.test' });

  const serialised = JSON.stringify(logged);
  assert.ok(!serialised.includes('marie.martin'));
  assert.ok(!serialised.includes('Marie Martin'));
});

test('a ticket already linked to a customer is answered from that link', async (t) => {
  // Linked by a confirmed order or by the address the customer gave us, while
  // the address they write from is unknown. The model used to be told to ask
  // which address the account was under.
  const sb = buildSupabase();
  t.after(sb.restore);

  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  const result = await lookup.lookupCustomer({
    ticket: { requester_email_hash: hashIdentifier('inconnu@example.test'), customer_id: 'c1' }
  });

  assert.equal(result.found, true);
  assert.equal(result.matchedBy, 'customer_id');
  assert.equal(result.customerId, 'c1');
});

// --- refreshIfChanged: the 5 MB index is read whole once, then by delta ---

/**
 * A customers table with `updated_at` and `deleted_at`, honouring the reads
 * the index makes: the stamp, the whole `id,email` read (live rows only) and
 * the delta (`updated_at=gte.`, deleted rows included).
 */
function stampedSupabase() {
  const rows = CUSTOMERS.map(({ id, email }) => ({ id, email, updated_at: '2026-10-11T08:00:00.000Z', deleted_at: null }));
  const state = { rows, fail: false, failRead: false, scans: 0, deltas: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const select = parsed.searchParams.get('select');
    if (select === 'updated_at') {
      if (state.fail) return { ok: false, status: 503, json: async () => ({ message: 'unavailable' }) };
      const newest = [...state.rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      return { ok: true, json: async () => [{ updated_at: newest.updated_at }] };
    }
    if (select === 'id,email' || select === 'id,email,deleted_at') {
      if (state.failRead) return { ok: false, status: 503, json: async () => ({ message: 'unavailable' }) };
      const since = parsed.searchParams.get('updated_at')?.replace('gte.', '');
      const first = !parsed.searchParams.has('id');
      if (since) {
        if (first) state.deltas.push(since);
      } else if (first) state.scans += 1;
      const pool = since
        ? state.rows.filter((r) => r.updated_at >= since).map(({ id, email, deleted_at }) => ({ id, email, deleted_at }))
        : state.rows.filter((r) => !r.deleted_at).map(({ id, email }) => ({ id, email }));
      return { ok: true, json: async () => postgrestPage(url, init, pool) };
    }
    // By id: one page, then an empty one, or the paging loop never ends.
    if (Number(String(init?.headers?.Range || '0-999').split('-')[0]) > 0) return { ok: true, json: async () => [] };
    const id = parsed.searchParams.get('id')?.replace('eq.', '');
    const live = state.rows.find((r) => r.id === id);
    const full = CUSTOMERS.find((c) => c.id === id);
    return { ok: true, json: async () => (live ? [{ ...(full ?? {}), ...live }] : []) };
  };
  const touch = (id, change, at) => {
    const row = state.rows.find((r) => r.id === id);
    if (row) Object.assign(row, change, { updated_at: at });
    else state.rows.push({ id, email: null, deleted_at: null, ...change, updated_at: at });
  };
  return { state, touch, client: { baseUrl: 'https://example.test/rest/v1', key: 'test-key' }, restore: () => { globalThis.fetch = originalFetch; } };
}

const marieHash = () => hashIdentifier('marie.martin@example.test');

test('the hash index is read whole once; a changed customer costs a delta, not a re-read', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false, now: () => 0 });

  assert.equal(await lookup.refreshIfChanged(), true, 'nothing read yet');
  assert.equal((await lookup.findByEmailHash(marieHash()))?.id, 'c1');
  assert.equal(sb.state.scans, 1);

  assert.equal(await lookup.refreshIfChanged(), false, 'same stamp: kept');
  await lookup.findByEmailHash(marieHash());
  assert.deepEqual([sb.state.scans, sb.state.deltas.length], [1, 0]);

  sb.touch('c2', { email: 'paul.new@example.test' }, '2026-10-11T09:00:00.000Z');
  assert.equal(await lookup.refreshIfChanged(), true, 'a customer moved');
  assert.equal(await lookup.findByEmailHash(hashIdentifier('paul.durand@example.test')), null, 'the old address no longer finds him');
  assert.equal((await lookup.findByEmailHash(hashIdentifier('paul.new@example.test')))?.id, 'c2');
  assert.equal(sb.state.scans, 1, 'never read whole again');
  // Read from ten minutes before the previous stamp: a transaction that began
  // before it but committed after it carries an older updated_at.
  assert.deepEqual(sb.state.deltas, ['2026-10-11T07:50:00.000Z']);
});

test('a delta takes in new customers and drops soft-deleted ones', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false, now: () => 0 });
  await lookup.refreshIfChanged();
  await lookup.findByEmailHash(marieHash());

  sb.touch('c1', { deleted_at: '2026-10-11T09:00:00.000Z' }, '2026-10-11T09:00:00.000Z');
  sb.touch('c3', { email: 'new.customer@example.test' }, '2026-10-11T09:05:00.000Z');
  await lookup.refreshIfChanged();
  assert.equal(await lookup.findByEmailHash(marieHash()), null, 'soft-deleted');
  assert.equal((await lookup.findByEmailHash(hashIdentifier('new.customer@example.test')))?.id, 'c3');
  assert.equal(sb.state.scans, 1);
});

test('two stamps between lookups: one delta from the older one', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false, now: () => 0 });
  await lookup.refreshIfChanged();
  await lookup.findByEmailHash(marieHash());

  sb.touch('c3', { email: 'first@example.test' }, '2026-10-11T09:00:00.000Z');
  await lookup.refreshIfChanged();
  sb.touch('c4', { email: 'second@example.test' }, '2026-10-11T10:00:00.000Z');
  await lookup.refreshIfChanged();
  assert.equal((await lookup.findByEmailHash(hashIdentifier('first@example.test')))?.id, 'c3');
  assert.equal((await lookup.findByEmailHash(hashIdentifier('second@example.test')))?.id, 'c4');
  assert.deepEqual(sb.state.deltas, ['2026-10-11T07:50:00.000Z']);
});

test('a customer deleted outright moves no stamp: found missing at lookup, and the next one on the address answers', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  sb.touch('c0', { email: 'MARIE.MARTIN@example.test' }, '2026-10-11T08:00:00.000Z');
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false, now: () => 0 });
  await lookup.refreshIfChanged();
  assert.equal((await lookup.findByEmailHash(marieHash()))?.id, 'c0', 'first writer (smallest id) wins, as before');

  sb.state.rows = sb.state.rows.filter((r) => r.id !== 'c0');
  assert.equal(await lookup.refreshIfChanged(), false);
  assert.equal((await lookup.findByEmailHash(marieHash()))?.id, 'c1');
  assert.equal(sb.state.scans, 1);
});

test('the index is read whole again after a week, and a failed read is not kept', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  let clock = 0;
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false, now: () => clock });
  await lookup.refreshIfChanged();
  await lookup.findByEmailHash(marieHash());

  clock = 7 * 24 * 60 * 60 * 1000;
  assert.equal(await lookup.refreshIfChanged(), true);
  await lookup.findByEmailHash(marieHash());
  assert.equal(sb.state.scans, 2);

  sb.touch('c2', { email: 'paul.new@example.test' }, '2026-10-11T09:00:00.000Z');
  await lookup.refreshIfChanged();
  sb.state.failRead = true;
  await assert.rejects(lookup.findByEmailHash(marieHash()));
  sb.state.failRead = false;
  assert.equal((await lookup.findByEmailHash(hashIdentifier('paul.new@example.test')))?.id, 'c2', 'read whole again');
  assert.equal(sb.state.scans, 3);
});

test('when the stamp cannot be read the index is dropped, as every pass did before', async (t) => {
  const sb = stampedSupabase();
  t.after(sb.restore);
  const lookup = createCustomerLookup({ supabase: sb.client, shopId: 's1', audit: false });
  await lookup.refreshIfChanged();
  await lookup.findByEmailHash(hashIdentifier('marie.martin@example.test'));
  sb.state.fail = true;
  assert.equal(await lookup.refreshIfChanged(), true);
  sb.state.fail = false;
  await lookup.findByEmailHash(hashIdentifier('marie.martin@example.test'));
  assert.equal(sb.state.scans, 2);
});
