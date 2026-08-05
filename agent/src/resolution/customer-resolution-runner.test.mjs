import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';
import {
  NOTIFICATION_SENDERS,
  RETRY_AFTER_MS,
  runCustomerResolution
} from './customer-resolution-runner.mjs';

const NOW = new Date('2026-08-04T10:00:00Z');
const MARIE_HASH = hashIdentifier('marie.martin@example.test');
const STRANGER_HASH = hashIdentifier('nobody@example.test');

/** Stands in for retrieval/customer-lookup.mjs: one known customer, by hash. */
function buildLookup({ known = { [MARIE_HASH]: 'c1' } } = {}) {
  return {
    calls: [],
    refreshes: 0,
    refresh() { this.refreshes += 1; },
    async lookupCustomer({ ticket }) {
      this.calls.push(ticket.requester_email_hash);
      const customerId = known[ticket.requester_email_hash] || null;
      return customerId
        ? { found: true, matchedBy: 'email_hash', customerId, customer: {}, account: {} }
        : { found: false, reason: 'no_match', matchedBy: null, customerId: null };
    }
  };
}

function buildStore(tickets) {
  const saved = [];
  return {
    saved,
    async findUnlinked() { return tickets; },
    async recordResolution(ticket, resolution) { saved.push({ ticket, resolution }); }
  };
}

const TICKET = { id: 't1', customer_id: null, requester_email_hash: MARIE_HASH, metadata: {} };

test('a ticket whose sender is a known customer is linked', async () => {
  const store = buildStore([TICKET]);
  const lookup = buildLookup();
  const totals = await runCustomerResolution({ store, lookup, shopId: 's1', now: NOW });

  assert.equal(totals.linked, 1);
  assert.equal(store.saved[0].resolution.customerId, 'c1');
  assert.equal(store.saved[0].resolution.matchedBy, 'email_hash');
});

test('no match is recorded, not treated as a failure', async () => {
  // Writing in from an address that never ordered is the ordinary pre-sales case.
  const store = buildStore([{ ...TICKET, requester_email_hash: STRANGER_HASH }]);
  const totals = await runCustomerResolution({ store, lookup: buildLookup(), shopId: 's1', now: NOW });

  assert.equal(totals.no_match, 1);
  assert.equal(store.saved[0].resolution.customerId, null);
  assert.equal(store.saved[0].resolution.status, 'no_match');
  assert.equal(store.saved[0].resolution.emailHash, STRANGER_HASH);
});

test('a Shopify notification address is never resolved to a customer', async () => {
  // A contact-form body that fails to parse leaves mailer@shopify.com as the
  // requester; linking those would give every one of them the same customer.
  const hash = hashIdentifier(NOTIFICATION_SENDERS[0]);
  const store = buildStore([{ ...TICKET, requester_email_hash: hash }]);
  const lookup = buildLookup({ known: { [hash]: 'c9' } });
  const totals = await runCustomerResolution({ store, lookup, shopId: 's1', now: NOW });

  assert.equal(totals.not_a_customer_address, 1);
  assert.equal(lookup.calls.length, 0, 'the lookup must not even be asked');
  assert.equal(store.saved[0].resolution.customerId, null);
});

test('the support mailbox is excluded by the caller', async () => {
  const hash = hashIdentifier('support@qiriness.test');
  const store = buildStore([{ ...TICKET, requester_email_hash: hash }]);
  const lookup = buildLookup({ known: { [hash]: 'c9' } });
  const totals = await runCustomerResolution({
    store,
    lookup,
    shopId: 's1',
    now: NOW,
    excludedEmails: ['support@qiriness.test']
  });

  assert.equal(totals.not_a_customer_address, 1);
  assert.equal(lookup.calls.length, 0);
});

test('a fresh no_match is not asked again on the next poll', async () => {
  const store = buildStore([
    {
      ...TICKET,
      requester_email_hash: STRANGER_HASH,
      metadata: {
        customer_resolution: {
          status: 'no_match',
          email_hash: STRANGER_HASH,
          attempted_at: new Date(NOW.getTime() - 60_000).toISOString()
        }
      }
    }
  ]);
  const lookup = buildLookup();
  const totals = await runCustomerResolution({ store, lookup, shopId: 's1', now: NOW });

  assert.equal(totals.deferred, 1);
  assert.equal(lookup.calls.length, 0);
  assert.equal(store.saved.length, 0, 'a deferred ticket must not be rewritten every poll');
  assert.equal(lookup.refreshes, 0, 'nothing to do means no index rebuild');
});

test('a stale no_match is asked again — the customer may have synced since', async () => {
  const store = buildStore([
    {
      ...TICKET,
      metadata: {
        customer_resolution: {
          status: 'no_match',
          email_hash: MARIE_HASH,
          attempted_at: new Date(NOW.getTime() - RETRY_AFTER_MS - 1000).toISOString()
        }
      }
    }
  ]);
  const totals = await runCustomerResolution({ store, lookup: buildLookup(), shopId: 's1', now: NOW });

  assert.equal(totals.linked, 1);
  assert.equal(store.saved[0].resolution.customerId, 'c1');
});

test('a backfilled requester is asked again immediately', async () => {
  // ticket-writer backfills requester_email_hash when a thread was opened by one
  // of our own replies. A decision about the old identity says nothing about this one.
  const store = buildStore([
    {
      ...TICKET,
      metadata: {
        customer_resolution: {
          status: 'no_match',
          email_hash: STRANGER_HASH,
          attempted_at: NOW.toISOString()
        }
      }
    }
  ]);
  const totals = await runCustomerResolution({ store, lookup: buildLookup(), shopId: 's1', now: NOW });

  assert.equal(totals.deferred, 0);
  assert.equal(totals.linked, 1);
});

test('a refused address is never retried, however old', async () => {
  const hash = hashIdentifier(NOTIFICATION_SENDERS[0]);
  const store = buildStore([
    {
      ...TICKET,
      requester_email_hash: hash,
      metadata: {
        customer_resolution: {
          status: 'not_a_customer_address',
          email_hash: hash,
          attempted_at: new Date(NOW.getTime() - RETRY_AFTER_MS * 30).toISOString()
        }
      }
    }
  ]);
  const totals = await runCustomerResolution({ store, lookup: buildLookup(), shopId: 's1', now: NOW });

  assert.equal(totals.deferred, 1);
  assert.equal(store.saved.length, 0);
});

test('the cached hash index is rebuilt once per working pass', async () => {
  const store = buildStore([TICKET, { ...TICKET, id: 't2' }]);
  const lookup = buildLookup();
  await runCustomerResolution({ store, lookup, shopId: 's1', now: NOW });

  assert.equal(lookup.refreshes, 1);
  assert.equal(lookup.calls.length, 2);
});

test('a dry run resolves but writes nothing', async () => {
  const store = buildStore([TICKET]);
  const totals = await runCustomerResolution({ store, lookup: buildLookup(), shopId: 's1', now: NOW, dryRun: true });

  assert.equal(totals.linked, 1);
  assert.equal(store.saved.length, 0);
});

test('the log line carries counts only', async () => {
  const logged = [];
  const store = buildStore([TICKET]);
  await runCustomerResolution({
    store,
    lookup: buildLookup(),
    shopId: 's1',
    now: NOW,
    logger: { info: (event, fields) => logged.push({ event, fields }) }
  });

  assert.equal(logged[0].event, 'customer.resolution');
  assert.equal(logged[0].fields.linked, 1);
  assert.ok(!JSON.stringify(logged).includes(MARIE_HASH), 'not even the hash belongs in the log');
});
