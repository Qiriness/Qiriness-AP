import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeltaPoll } from './delta-poller.mjs';
import { buildSpamGate } from './spam-gate.mjs';

function graphMessage(id, conversationId, address = 'marie@example.com') {
  return {
    id,
    conversationId,
    subject: 'Subject',
    from: { emailAddress: { name: 'Marie', address } },
    receivedDateTime: '2026-07-24T10:00:00Z',
    body: { contentType: 'text', content: 'hello' }
  };
}

// Fake Graph client that serves a scripted list of delta pages.
function fakeGraphClient(pages) {
  let index = 0;
  const requestedUrls = [];
  return {
    requestedUrls,
    async getDeltaPage(url) {
      requestedUrls.push(url);
      return pages[index++];
    }
  };
}

function fakeStore() {
  const tickets = new Map();
  const messages = new Map();
  let seq = 0;
  return {
    tickets,
    messages,
    async findTicketByConversation(shopId, conversationId) {
      return tickets.get(`${shopId}|${conversationId}`) || null;
    },
    async insertTicket(row) {
      seq += 1;
      const stored = { id: `t${seq}`, ...row };
      tickets.set(`${row.shop_id}|${row.graph_conversation_id}`, stored);
      return stored;
    },
    async updateTicket() {},
    async upsertMessage(row) {
      messages.set(`${row.shop_id}|${row.graph_message_id}`, row);
    }
  };
}

function fakeCursorStore(initial = null) {
  let link = initial;
  return {
    saved: () => link,
    async getDeltaLink() {
      return link;
    },
    async setDeltaLink(_shopId, deltaLink) {
      link = deltaLink;
    }
  };
}

test('follows nextLink pages to the deltaLink and persists the cursor', async () => {
  const graphClient = fakeGraphClient([
    { messages: [graphMessage('m1', 'c1')], nextLink: 'https://graph/page2', deltaLink: null },
    { messages: [graphMessage('m2', 'c1'), graphMessage('m3', 'c2')], nextLink: null, deltaLink: 'https://graph/delta-final' }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);

  const totals = await runDeltaPoll({ graphClient, store, cursorStore, shopId: 'shop-1' });

  assert.equal(totals.pages, 2);
  assert.equal(totals.messagesIngested, 3);
  assert.equal(totals.ticketsCreated, 2);
  assert.equal(cursorStore.saved(), 'https://graph/delta-final');
  // First request used the null (initial) cursor, second followed nextLink.
  assert.deepEqual(graphClient.requestedUrls, [null, 'https://graph/page2']);
});

test('drops blocklisted senders before writing and records rule hits', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [
        graphMessage('m1', 'c1', 'marie@example.com'),
        graphMessage('m2', 'c2', 'spammer@bad.com'),
        graphMessage('m3', 'c3', 'anyone@junk.example')
      ],
      nextLink: null,
      deltaLink: 'https://graph/delta-final'
    }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);
  const spamGate = buildSpamGate([
    { id: 'r-email', pattern_type: 'email', pattern: 'spammer@bad.com' },
    { id: 'r-domain', pattern_type: 'domain', pattern: 'junk.example' }
  ]);

  let recorded = null;
  const totals = await runDeltaPoll({
    graphClient,
    store,
    cursorStore,
    shopId: 'shop-1',
    spamGate,
    recordSpamHits: async (hits) => {
      recorded = hits;
    }
  });

  assert.equal(totals.spamBlocked, 2);
  assert.equal(totals.messagesIngested, 1); // only marie@example.com stored
  assert.equal(store.messages.size, 1);
  assert.ok(store.messages.has('shop-1|m1'));
  assert.ok(!store.messages.has('shop-1|m2'));
  assert.ok(!store.messages.has('shop-1|m3'));
  assert.equal(recorded.get('r-email'), 1);
  assert.equal(recorded.get('r-domain'), 1);
});

test('respects --limit and does not advance the cursor when truncating mid-inbox', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [graphMessage('m1', 'c1'), graphMessage('m2', 'c2'), graphMessage('m3', 'c3')],
      nextLink: 'https://graph/page2',
      deltaLink: null
    }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);

  const totals = await runDeltaPoll({ graphClient, store, cursorStore, shopId: 'shop-1', limit: 2 });

  assert.equal(totals.messagesIngested, 2);
  assert.equal(totals.limitReached, true);
  assert.equal(store.messages.size, 2);
  assert.equal(cursorStore.saved(), null); // cursor intentionally not advanced
});

test('resumes from the stored deltaLink on the next run', async () => {
  const graphClient = fakeGraphClient([
    { messages: [], nextLink: null, deltaLink: 'https://graph/delta-next' }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore('https://graph/delta-saved');

  await runDeltaPoll({ graphClient, store, cursorStore, shopId: 'shop-1' });

  assert.equal(graphClient.requestedUrls[0], 'https://graph/delta-saved');
  assert.equal(cursorStore.saved(), 'https://graph/delta-next');
});
