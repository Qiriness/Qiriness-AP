import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';
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
