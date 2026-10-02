import assert from 'node:assert/strict';
import test from 'node:test';

import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

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

/**
 * The real ticket record over a fake transport, so `saved` holds what
 * `linkCustomer` was actually asked to record rather than a stub's echo.
 */
function buildStore(tickets) {
  const saved = [];
  const record = createTicketRecord({}, {
    shopId: 's1',
    transport: {
      async select() { return []; },
      async selectAll() { return tickets; },
      async insert(_c, _t, rows) { return rows; },
      async update() { return []; },
      async updateById() { return {}; }
    }
  });
  const linkCustomer = record.linkCustomer.bind(record);
  return Object.assign(record, {
    saved,
    async linkCustomer(ticket, resolution) {
      saved.push({ ticket, resolution });
      return linkCustomer(ticket, resolution);
    }
  });
}

const TICKET = { id: 't1', customer_id: null, requester_email_hash: MARIE_HASH, metadata: {} };

test('a ticket whose sender is a known customer is linked', async () => {
  const record = buildStore([TICKET]);
  const lookup = buildLookup();
  const totals = await runCustomerResolution({ record, lookup, now: NOW });

  assert.equal(totals.linked, 1);
  assert.equal(record.saved[0].resolution.customerId, 'c1');
  assert.equal(record.saved[0].resolution.matchedBy, 'email_hash');
});

test('no match is recorded, not treated as a failure', async () => {
  // Writing in from an address that never ordered is the ordinary pre-sales case.
  const record = buildStore([{ ...TICKET, requester_email_hash: STRANGER_HASH }]);
  const totals = await runCustomerResolution({ record, lookup: buildLookup(), now: NOW });

  assert.equal(totals.no_match, 1);
  assert.equal(record.saved[0].resolution.customerId, null);
  assert.equal(record.saved[0].resolution.status, 'no_match');
  assert.equal(record.saved[0].resolution.emailHash, STRANGER_HASH);
});

test('a Shopify notification address is never resolved to a customer', async () => {
  // A contact-form body that fails to parse leaves mailer@shopify.com as the
  // requester; linking those would give every one of them the same customer.
  const hash = hashIdentifier(NOTIFICATION_SENDERS[0]);
  const record = buildStore([{ ...TICKET, requester_email_hash: hash }]);
  const lookup = buildLookup({ known: { [hash]: 'c9' } });
  const totals = await runCustomerResolution({ record, lookup, now: NOW });

  assert.equal(totals.not_a_customer_address, 1);
  assert.equal(lookup.calls.length, 0, 'the lookup must not even be asked');
  assert.equal(record.saved[0].resolution.customerId, null);
});

test('the support mailbox is excluded by the caller', async () => {
  const hash = hashIdentifier('support@qiriness.test');
  const record = buildStore([{ ...TICKET, requester_email_hash: hash }]);
  const lookup = buildLookup({ known: { [hash]: 'c9' } });
  const totals = await runCustomerResolution({
    record,
    lookup,
    now: NOW,
    excludedEmails: ['support@qiriness.test']
  });

  assert.equal(totals.not_a_customer_address, 1);
  assert.equal(lookup.calls.length, 0);
});

test('a fresh no_match is not asked again on the next poll', async () => {
  const record = buildStore([
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
  const totals = await runCustomerResolution({ record, lookup, now: NOW });

  assert.equal(totals.deferred, 1);
  assert.equal(lookup.calls.length, 0);
  assert.equal(record.saved.length, 0, 'a deferred ticket must not be rewritten every poll');
  assert.equal(lookup.refreshes, 0, 'nothing to do means no index rebuild');
});

test('a stale no_match is asked again — the customer may have synced since', async () => {
  const record = buildStore([
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
  const totals = await runCustomerResolution({ record, lookup: buildLookup(), now: NOW });

  assert.equal(totals.linked, 1);
  assert.equal(record.saved[0].resolution.customerId, 'c1');
});

test('a backfilled requester is asked again immediately', async () => {
  // ticket-writer backfills requester_email_hash when a thread was opened by one
  // of our own replies. A decision about the old identity says nothing about this one.
  const record = buildStore([
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
  const totals = await runCustomerResolution({ record, lookup: buildLookup(), now: NOW });

  assert.equal(totals.deferred, 0);
  assert.equal(totals.linked, 1);
});

test('a refused address is never retried, however old', async () => {
  const hash = hashIdentifier(NOTIFICATION_SENDERS[0]);
  const record = buildStore([
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
  const totals = await runCustomerResolution({ record, lookup: buildLookup(), now: NOW });

  assert.equal(totals.deferred, 1);
  assert.equal(record.saved.length, 0);
});

test('the cached hash index is rebuilt once per working pass', async () => {
  const record = buildStore([TICKET, { ...TICKET, id: 't2' }]);
  const lookup = buildLookup();
  await runCustomerResolution({ record, lookup, now: NOW });

  assert.equal(lookup.refreshes, 1);
  assert.equal(lookup.calls.length, 2);
});

test('a dry run resolves but writes nothing', async () => {
  const record = buildStore([TICKET]);
  const totals = await runCustomerResolution({ record, lookup: buildLookup(), now: NOW, dryRun: true });

  assert.equal(totals.linked, 1);
  assert.equal(record.saved.length, 0);
});

test('the log line carries counts only', async () => {
  const logged = [];
  const record = buildStore([TICKET]);
  await runCustomerResolution({
    record,
    lookup: buildLookup(),
    now: NOW,
    logger: { info: (event, fields) => logged.push({ event, fields }) }
  });

  assert.equal(logged[0].event, 'customer.resolution');
  assert.equal(logged[0].fields.linked, 1);
  assert.ok(!JSON.stringify(logged).includes(MARIE_HASH), 'not even the hash belongs in the log');
});

// --- the address the customer gave when we asked -----------------------------

const WROTE_FROM = hashIdentifier('autre.adresse@example.test');

function answeringLookup(known) {
  return {
    refresh() {},
    async lookupCustomer({ ticket, emailHash }) {
      const customerId = known[emailHash || ticket.requester_email_hash] || null;
      return customerId
        ? { found: true, matchedBy: 'email_hash', customerId }
        : { found: false, reason: 'no_match', customerId: null };
    }
  };
}

function withAnswers(store, answers) {
  return Object.assign(store, { async addressAnswersByTicket() { return new Map(Object.entries(answers)); } });
}

const FROM_ELSEWHERE = { ...TICKET, requester_email_hash: WROTE_FROM };

test('an address given in answer to our question links the customer', async () => {
  const store = withAnswers(buildStore([FROM_ELSEWHERE]), {
    t1: ['Bonjour, mon compte est sous marie.martin@example.test']
  });
  const totals = await runCustomerResolution({
    record: store,
    lookup: answeringLookup({ [MARIE_HASH]: 'c1' }),
    shopId: 's1',
    now: NOW
  });
  assert.equal(totals.linked, 1);
  assert.equal(store.saved[0].resolution.customerId, 'c1');
  assert.equal(store.saved[0].resolution.matchedBy, 'reply_email');
  // Recorded against the sender's address, so the back-off still reads it.
  assert.equal(store.saved[0].resolution.emailHash, WROTE_FROM);
});

test('two addresses on two different customers link nobody', async () => {
  const store = withAnswers(buildStore([FROM_ELSEWHERE]), {
    t1: ['soit marie.martin@example.test soit paul@example.test']
  });
  const totals = await runCustomerResolution({
    record: store,
    lookup: answeringLookup({ [MARIE_HASH]: 'c1', [hashIdentifier('paul@example.test')]: 'c2' }),
    shopId: 's1',
    now: NOW
  });
  assert.equal(totals.no_match, 1);
  assert.equal(store.saved[0].resolution.customerId, null);
});

test('the sender’s own address wins over an answer', async () => {
  const store = withAnswers(buildStore([TICKET]), { t1: ['paul@example.test'] });
  await runCustomerResolution({
    record: store,
    lookup: answeringLookup({ [MARIE_HASH]: 'c1', [hashIdentifier('paul@example.test')]: 'c2' }),
    shopId: 's1',
    now: NOW
  });
  assert.equal(store.saved[0].resolution.customerId, 'c1');
  assert.equal(store.saved[0].resolution.matchedBy, 'email_hash');
});

test('a new message since the last attempt is retried at once, not after a day', async () => {
  const attempted = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const previous = { status: 'no_match', email_hash: WROTE_FROM, attempted_at: attempted };
  const quiet = { ...FROM_ELSEWHERE, metadata: { customer_resolution: previous }, last_message_at: attempted };
  const replied = { ...quiet, id: 't2', last_message_at: NOW.toISOString() };

  const totals = await runCustomerResolution({
    record: buildStore([quiet, replied]),
    lookup: answeringLookup({}),
    shopId: 's1',
    now: NOW
  });
  assert.equal(totals.deferred, 1);
  assert.equal(totals.no_match, 1);
});
