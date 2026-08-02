import assert from 'node:assert/strict';
import test from 'node:test';

import { runForwarding } from './forward-runner.mjs';

function buildStore({ book = [['careers', 'hr@example.com']], pending = [] } = {}) {
  const recorded = [];
  return {
    recorded,
    async loadAddressBook() {
      return new Map(book);
    },
    async findPending() {
      return pending;
    },
    async recordForward(entry) {
      recorded.push(entry);
    }
  };
}

function buildGraph({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async forwardMessage(id, options) {
      if (fail) {
        throw new Error('ErrorAccessDenied');
      }
      sent.push({ id, ...options });
    }
  };
}

const CAREERS_ITEM = {
  messageId: 'msg-1',
  graphMessageId: 'graph-1',
  subject: 'Candidature Spontanée',
  ticket: { id: 'ticket-1', category: 'careers', request_kind: 'contact' }
};

test('a qualifying message is forwarded to its category address and recorded', async () => {
  const store = buildStore({ pending: [CAREERS_ITEM] });
  const graphClient = buildGraph();

  const totals = await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.deepEqual(totals, { considered: 1, forwarded: 1, failed: 0, skipped: 0 });
  assert.deepEqual(graphClient.sent[0].toRecipients, ['hr@example.com']);
  assert.equal(graphClient.sent[0].id, 'graph-1');
  assert.match(graphClient.sent[0].comment, /Pour information, nous avons reçu une candidature/);
  assert.equal(store.recorded[0].error, null);
  assert.equal(store.recorded[0].messageId, 'msg-1');
});

test('an empty address book sends nothing and does not even query', async () => {
  // The safe default: a fresh install forwards no mail at all.
  let queried = false;
  const store = {
    async loadAddressBook() { return new Map(); },
    async findPending() { queried = true; return []; },
    async recordForward() { throw new Error('must not record'); }
  };

  const totals = await runForwarding({ store, graphClient: buildGraph(), shopId: 'shop-1' });

  assert.deepEqual(totals, { considered: 0, forwarded: 0, failed: 0, skipped: 0 });
  assert.equal(queried, false);
});

test('a non-contact ticket that slipped into the pending set is skipped, not sent', async () => {
  const store = buildStore({
    pending: [{ ...CAREERS_ITEM, ticket: { id: 't', category: 'careers', request_kind: 'problem' } }]
  });
  const graphClient = buildGraph();

  const totals = await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.equal(totals.skipped, 1);
  assert.equal(totals.forwarded, 0);
  assert.equal(graphClient.sent.length, 0);
  assert.equal(store.recorded.length, 0, 'a skip is not an attempt, so it leaves no row');
});

test('mail from our own domain is skipped by the pass, not just by the rule', async () => {
  const store = buildStore({
    pending: [{ ...CAREERS_ITEM, fromEmail: 'colleague@lap-groupe.com' }]
  });
  const graphClient = buildGraph();

  const totals = await runForwarding({
    store,
    graphClient,
    shopId: 'shop-1',
    internalDomains: ['lap-groupe.com']
  });

  assert.equal(totals.skipped, 1);
  assert.equal(graphClient.sent.length, 0);
  assert.equal(store.recorded.length, 0);
});

test('a message with no Graph id is skipped rather than re-composed', async () => {
  // Re-composing from stored text would lose the attachment that is often the
  // whole point — a CV, a purchase order.
  const store = buildStore({ pending: [{ ...CAREERS_ITEM, graphMessageId: null }] });
  const graphClient = buildGraph();

  const totals = await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.equal(totals.skipped, 1);
  assert.equal(graphClient.sent.length, 0);
});

test('a send failure is recorded as failed instead of vanishing', async () => {
  // A failure that left no row would be retried on every poll forever.
  const store = buildStore({ pending: [CAREERS_ITEM] });

  const totals = await runForwarding({ store, graphClient: buildGraph({ fail: true }), shopId: 'shop-1' });

  assert.deepEqual(totals, { considered: 1, forwarded: 0, failed: 1, skipped: 0 });
  assert.equal(store.recorded.length, 1);
  assert.match(store.recorded[0].error, /ErrorAccessDenied/);
});

test('one failure does not stop the rest of the pass', async () => {
  const items = [
    CAREERS_ITEM,
    { ...CAREERS_ITEM, messageId: 'msg-2', graphMessageId: 'graph-2' },
    { ...CAREERS_ITEM, messageId: 'msg-3', graphMessageId: 'graph-3' }
  ];
  const store = buildStore({ pending: items });
  let calls = 0;
  const graphClient = {
    sent: [],
    async forwardMessage(id, options) {
      calls += 1;
      if (calls === 2) throw new Error('ErrorMailboxNotEnabled');
      this.sent.push({ id, ...options });
    }
  };

  const totals = await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.deepEqual(totals, { considered: 3, forwarded: 2, failed: 1, skipped: 0 });
  assert.equal(store.recorded.length, 3, 'every attempt is recorded');
});

test('the recorded row snapshots the category and address used', async () => {
  // The address book is editable; changing where careers mail goes tomorrow
  // must not rewrite where it went yesterday.
  const store = buildStore({ pending: [CAREERS_ITEM] });
  await runForwarding({ store, graphClient: buildGraph(), shopId: 'shop-1' });

  assert.deepEqual(store.recorded[0], {
    shopId: 'shop-1',
    ticketId: 'ticket-1',
    messageId: 'msg-1',
    category: 'careers',
    address: 'hr@example.com',
    error: null,
    priorAttempts: 0
  });
});

test('a dry run decides everything but sends and records nothing', async () => {
  const store = buildStore({ pending: [CAREERS_ITEM] });
  const graphClient = buildGraph();
  const previews = [];

  const totals = await runForwarding({
    store,
    graphClient,
    shopId: 'shop-1',
    dryRun: true,
    onPreview: (p) => previews.push(p)
  });

  assert.equal(totals.forwarded, 1, 'still reports what it would do');
  assert.equal(graphClient.sent.length, 0, 'nothing sent');
  assert.equal(store.recorded.length, 0, 'nothing recorded, so a later real run still sends it');
  assert.equal(previews[0].address, 'hr@example.com');
  assert.match(previews[0].comment, /Pour information/);
});

test('a retry carries the attempt count forward', async () => {
  // The bug this covers: the first real run failed all 42 messages with a
  // transient Exchange error, and the ledger row then excluded them from every
  // later pass. A failed row must be updatable, and must count.
  const store = buildStore({ pending: [{ ...CAREERS_ITEM, priorAttempts: 2 }] });

  await runForwarding({ store, graphClient: buildGraph(), shopId: 'shop-1' });

  assert.equal(store.recorded[0].priorAttempts, 2);
});

test('a first attempt reports no prior attempts', async () => {
  const store = buildStore({ pending: [CAREERS_ITEM] });
  await runForwarding({ store, graphClient: buildGraph(), shopId: 'shop-1' });
  assert.equal(store.recorded[0].priorAttempts, 0);
});

test('a transient Graph failure does not consume a retry attempt', async () => {
  // The worker polls every 60s. Counting "mailbox mid-move" against a cap of 5
  // would permanently abandon the mail within five minutes of a condition that
  // takes hours to clear — which is exactly what the first real run hit.
  const store = buildStore({ pending: [{ ...CAREERS_ITEM, priorAttempts: 3 }] });
  const graphClient = {
    async forwardMessage() { throw new Error('Graph forward failed: ErrorMailboxMoveInProgress'); }
  };

  await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.equal(store.recorded[0].priorAttempts, 2, 'stays put rather than climbing');
  assert.match(store.recorded[0].error, /ErrorMailboxMoveInProgress/, 'still recorded, still visible');
});

test('a permanent Graph failure does consume an attempt', async () => {
  const store = buildStore({ pending: [{ ...CAREERS_ITEM, priorAttempts: 3 }] });
  const graphClient = {
    async forwardMessage() { throw new Error('Graph forward failed: ErrorInvalidRecipients'); }
  };

  await runForwarding({ store, graphClient, shopId: 'shop-1' });

  assert.equal(store.recorded[0].priorAttempts, 3, 'so the store writes attempts = 4');
});
