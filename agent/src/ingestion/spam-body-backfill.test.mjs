import assert from 'node:assert/strict';
import test from 'node:test';

import { runSpamBodyBackfill } from './spam-body-backfill.mjs';

function graphMessage(id, { body = 'Bonjour, ceci est le corps.', from = 'spam@example.com' } = {}) {
  return {
    id,
    conversationId: `c-${id}`,
    subject: 'Offre exceptionnelle',
    from: { emailAddress: { address: from, name: 'Sender' } },
    receivedDateTime: '2026-01-01T00:00:00.000Z',
    body: { contentType: 'text', content: body }
  };
}

function createStore(rows) {
  const saved = [];
  return {
    saved,
    async listRowsMissingBody() {
      return rows;
    },
    async saveBody(id, patch) {
      saved.push({ id, patch });
    }
  };
}

test('fills a body and writes it through the shared patch builder', async () => {
  const store = createStore([{ id: 'a1', graph_message_id: 'm1', subject: 's' }]);
  const totals = await runSpamBodyBackfill({
    store,
    graphClient: { async getMessage() { return graphMessage('m1'); } },
    shopId: 'shop-1',
    retentionDays: 30
  });

  assert.deepEqual(totals, {
    considered: 1,
    filled: 1,
    gone: 0,
    empty: 0,
    failed: 0,
    mailboxMismatch: false
  });
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].id, 'a1');
  assert.equal(store.saved[0].patch.body_text, 'Bonjour, ceci est le corps.');
  // The expiry is set from capture time, which is now — so all that can be
  // asserted here is that it is 30 days out from the capture stamp.
  const { body_captured_at: captured, body_expires_at: expires } = store.saved[0].patch;
  assert.equal(Date.parse(expires) - Date.parse(captured), 30 * 86400000);
});

test('a message the mailbox no longer holds counts as gone, not as a failure', async () => {
  const store = createStore([{ id: 'a1', graph_message_id: 'm1' }]);
  const totals = await runSpamBodyBackfill({
    store,
    graphClient: { async getMessage() { return null; } },
    shopId: 'shop-1'
  });

  assert.equal(totals.gone, 1);
  assert.equal(totals.failed, 0);
  assert.equal(store.saved.length, 0);
});

test('one unreadable message never ends the run', async () => {
  const store = createStore([
    { id: 'a1', graph_message_id: 'm1' },
    { id: 'a2', graph_message_id: 'm2' }
  ]);
  const totals = await runSpamBodyBackfill({
    store,
    graphClient: {
      async getMessage(id) {
        if (id === 'm1') throw new Error('Graph message request failed: HTTP 500');
        return graphMessage('m2');
      }
    },
    shopId: 'shop-1'
  });

  assert.equal(totals.failed, 1);
  assert.equal(totals.filled, 1);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].id, 'a2');
});

test('an empty body is counted, not stored as an empty string', async () => {
  const store = createStore([{ id: 'a1', graph_message_id: 'm1' }]);
  const totals = await runSpamBodyBackfill({
    store,
    graphClient: { async getMessage() { return graphMessage('m1', { body: '   ' }); } },
    shopId: 'shop-1'
  });

  assert.equal(totals.empty, 1);
  assert.equal(totals.filled, 0);
  assert.equal(store.saved.length, 0);
});

test('a dry run makes the Graph calls and writes nothing', async () => {
  const store = createStore([{ id: 'a1', graph_message_id: 'm1' }]);
  let fetched = 0;
  const totals = await runSpamBodyBackfill({
    store,
    graphClient: {
      async getMessage() {
        fetched += 1;
        return graphMessage('m1');
      }
    },
    shopId: 'shop-1',
    dryRun: true
  });

  assert.equal(fetched, 1, 'the dry run must exercise the same fetch');
  assert.equal(totals.filled, 1, 'so the count says what a real run would do');
  assert.equal(store.saved.length, 0);
});

test('the body goes through the ingestion mapper, so a contact form yields the customer text', async () => {
  // The mapper replaces the Shopify wrapper with what the customer typed. A
  // backfilled body that kept the wrapper would not match what ingestion writes
  // for the same email today.
  const store = createStore([{ id: 'a1', graph_message_id: 'm1' }]);
  const raw = graphMessage('m1', {
    from: 'mailer@shopify.com',
    body: [
      'Vous avez reçu un nouveau message du formulaire de contact de votre boutique en ligne.',
      '',
      'Name:',
      'Marie Dupont',
      '',
      'E-mail:',
      'marie@example.com',
      '',
      'Corps:',
      'Je souhaite annuler ma commande.'
    ].join('\n')
  });

  await runSpamBodyBackfill({
    store,
    graphClient: { async getMessage() { return raw; } },
    shopId: 'shop-1'
  });

  assert.equal(store.saved.length, 1);
  assert.match(store.saved[0].patch.body_text, /annuler ma commande/);
  assert.doesNotMatch(store.saved[0].patch.body_text, /E-mail:/);
});

test('an empty batch is a clean no-op', async () => {
  const totals = await runSpamBodyBackfill({
    store: createStore([]),
    graphClient: { async getMessage() { throw new Error('should not be called'); } },
    shopId: 'shop-1'
  });

  assert.deepEqual(totals, {
    considered: 0,
    filled: 0,
    gone: 0,
    empty: 0,
    failed: 0,
    mailboxMismatch: false
  });
});

test('a mailbox mismatch stops the run rather than counting rows as gone', async () => {
  // Exchange ids are mailbox-scoped: if one is invalid for this mailbox they all
  // are, so continuing burns Graph calls and reports a data problem the operator
  // cannot fix. "gone" would send them to look for deleted mail that never left.
  const store = createStore([
    { id: 'a1', graph_message_id: 'm1' },
    { id: 'a2', graph_message_id: 'm2' },
    { id: 'a3', graph_message_id: 'm3' }
  ]);
  let calls = 0;

  const totals = await runSpamBodyBackfill({
    store,
    graphClient: {
      async getMessage() {
        calls += 1;
        const error = new Error('invalid for this mailbox');
        error.mailboxMismatch = true;
        throw error;
      }
    },
    shopId: 'shop-1'
  });

  assert.equal(calls, 1, 'stops at the first mismatch');
  assert.equal(totals.mailboxMismatch, true);
  assert.equal(totals.gone, 0, 'a mismatch is never reported as deleted mail');
  assert.equal(totals.failed, 0, 'nor as a per-row failure');
  assert.equal(store.saved.length, 0);
});
