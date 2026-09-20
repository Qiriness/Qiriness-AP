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
    // The ticket record's half of the interface. It is a separate object in the
    // real wiring; the poll takes both and this fake plays both.
    async findByConversation(conversationId) {
      return tickets.get(`shop-1|${conversationId}`) || null;
    },
    async create(row) {
      seq += 1;
      const stored = { id: `t${seq}`, shop_id: 'shop-1', ...row };
      tickets.set(`shop-1|${row.graph_conversation_id}`, stored);
      return stored;
    },
    async recordMessageArrival() {},
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

  const totals = await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' });

  assert.equal(totals.pages, 2);
  assert.equal(totals.messagesIngested, 3);
  assert.equal(totals.ticketsCreated, 2);
  assert.equal(cursorStore.saved(), 'https://graph/delta-final');
  // First request used the null (initial) cursor, second followed nextLink.
  assert.deepEqual(graphClient.requestedUrls, [null, 'https://graph/page2']);
});

test('asks Graph about every kept message, not only the flagged ones', async () => {
  // THE INLINE-PHOTO REGRESSION. Exchange reports `hasAttachments: false` when a
  // message's only attachment is embedded in the body, which is how Gmail sends
  // a pasted photo. Gating the fetch on that flag left those rows at
  // `attachments: null` forever — the backfill filtered the same way — and the
  // photo check then read the null as "nothing attached". Ticket d48f1c08 sat on
  // a 3.6 MB inline PNG from July until 2026-09-20 because of it.
  const unflagged = graphMessage('m1', 'c1');
  unflagged.hasAttachments = false;

  const asked = [];
  const graphClient = {
    ...fakeGraphClient([{ messages: [unflagged], nextLink: null, deltaLink: 'https://graph/delta-final' }]),
    async getAttachmentMetadata(id) {
      asked.push(id);
      return [{ name: 'gmail_image.png', contentType: 'image/png', size: 3_623_198, isInline: true }];
    }
  };
  const store = fakeStore();

  await runDeltaPoll({
    graphClient,
    store,
    record: store,
    cursorStore: fakeCursorStore(null),
    shopId: 'shop-1'
  });

  assert.deepEqual(asked, ['m1']);
  assert.equal(store.messages.get('shop-1|m1').attachments.length, 1);
});

test('a message Graph knows nothing about keeps its null rather than an empty array', async () => {
  // The distinction the column exists for: `[]` means we asked and there was
  // nothing, `null` means we never learned. A failed lookup must not claim the
  // first — see `summarisePhotoEvidence`, which reads the two differently.
  const message = graphMessage('m1', 'c1');
  const graphClient = {
    ...fakeGraphClient([{ messages: [message], nextLink: null, deltaLink: 'https://graph/delta-final' }]),
    async getAttachmentMetadata() {
      return null;
    }
  };
  const store = fakeStore();

  await runDeltaPoll({
    graphClient,
    store,
    record: store,
    cursorStore: fakeCursorStore(null),
    shopId: 'shop-1'
  });

  assert.equal(store.messages.get('shop-1|m1').attachments ?? null, null);
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
    record: store,
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

test('flushes one audit row per gate decision, from both passes', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [
        graphMessage('m1', 'c1', 'marie@example.com'),
        graphMessage('m2', 'c2', 'spammer@bad.com')
      ],
      nextLink: null,
      deltaLink: 'https://graph/delta-final'
    }
  ]);
  const spamGate = buildSpamGate([
    { id: 'r-email', pattern_type: 'email', pattern: 'spammer@bad.com' }
  ]);

  let flushed = null;
  const totals = await runDeltaPoll({
    graphClient,
    ...(() => { const s = fakeStore(); return { store: s, record: s }; })(),
    cursorStore: fakeCursorStore(null),
    shopId: 'shop-1',
    spamGate,
    auditStore: {
      async flush(_shopId, entries) {
        flushed = entries;
        return entries.length;
      }
    },
    // The LLM pass keeps marie@example.com; the blocklist already dropped the other.
    triage: async () => ({ spam: false, label: 'keep', reason: 'unsure', model: 'gpt-4o-mini' })
  });

  assert.equal(totals.spamAudited, 2);
  assert.equal(flushed.length, 2);

  const blocked = flushed.find((entry) => entry.outcome === 'blocked');
  assert.equal(blocked.decidedBy, 'blocklist');
  assert.equal(blocked.graphMessageId, 'm2');
  assert.equal(blocked.ruleId, 'r-email');
  // The reason names the pattern that matched, not just "blocklist".
  assert.match(blocked.reason, /spammer@bad\.com/);

  const kept = flushed.find((entry) => entry.outcome === 'kept');
  assert.equal(kept.decidedBy, 'llm');
  assert.equal(kept.reason, 'unsure');
});

test('an audit-store failure is logged, not fatal — mail is never re-dropped', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [graphMessage('m1', 'c1', 'spammer@bad.com')],
      nextLink: null,
      deltaLink: 'https://graph/delta-final'
    }
  ]);
  const cursorStore = fakeCursorStore(null);
  const warnings = [];

  const totals = await runDeltaPoll({
    graphClient,
    ...(() => { const s = fakeStore(); return { store: s, record: s }; })(),
    cursorStore,
    shopId: 'shop-1',
    logger: { warn: (event) => warnings.push(event) },
    spamGate: buildSpamGate([{ id: 'r1', pattern_type: 'email', pattern: 'spammer@bad.com' }]),
    auditStore: {
      async flush() {
        throw new Error('supabase down');
      }
    }
  });

  assert.equal(totals.spamBlocked, 1);
  assert.equal(totals.spamAudited, 0);
  assert.ok(warnings.includes('ingest.spam_audit_failed'));
  // The cursor still advanced, so the poll is not retried and mail is not re-processed.
  assert.equal(cursorStore.saved(), 'https://graph/delta-final');
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

  const totals = await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1', limit: 2 });

  assert.equal(totals.messagesIngested, 2);
  assert.equal(totals.limitReached, true);
  assert.equal(store.messages.size, 2);
  assert.equal(cursorStore.saved(), null); // cursor intentionally not advanced
});

function dated(id, conversationId, receivedDateTime) {
  return { ...graphMessage(id, conversationId), receivedDateTime };
}

test('under --limit a thread is written oldest first, so its ticket is created from the opening message', async () => {
  // Graph serves newest first. The bug this guards: the ticket was created from
  // the reply, so every creation-time rule read the wrong sender.
  const graphClient = fakeGraphClient([
    {
      messages: [
        dated('reply-2', 'c1', '2026-09-10T12:00:00Z'),
        dated('reply-1', 'c1', '2026-09-10T11:00:00Z'),
        dated('opening', 'c1', '2026-09-10T10:00:00Z')
      ],
      nextLink: null,
      deltaLink: 'https://graph/delta-final'
    }
  ]);
  const store = fakeStore();
  const created = [];
  const create = store.create;
  store.create = async (row) => (created.push(row), create(row));

  await runDeltaPoll({ graphClient, store, record: store, cursorStore: fakeCursorStore(null), shopId: 'shop-1', limit: 10 });

  assert.deepEqual([...store.messages.values()].map((m) => m.graph_message_id), ['opening', 'reply-1', 'reply-2']);
  // One ticket, and the opening message was the first thing written into it.
  assert.equal(created.length, 1);
});

test('under --limit the newest N are kept across pages, then written oldest first', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [dated('m4', 'c4', '2026-09-04T00:00:00Z'), dated('m3', 'c3', '2026-09-03T00:00:00Z')],
      nextLink: 'https://graph/page2',
      deltaLink: null
    },
    {
      messages: [
        dated('m2', 'c2', '2026-09-02T00:00:00Z'),
        dated('m1', 'c1', '2026-09-01T00:00:00Z'),
        dated('m0', 'c0', '2026-08-31T00:00:00Z')
      ],
      nextLink: 'https://graph/page3',
      deltaLink: null
    }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);

  const totals = await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1', limit: 4 });

  assert.deepEqual([...store.messages.values()].map((m) => m.graph_message_id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(totals.limitReached, true);
  assert.equal(totals.pages, 2);
  assert.equal(cursorStore.saved(), null);
});

test('without --limit pages are written as Graph serves them, and the cursor advances', async () => {
  const graphClient = fakeGraphClient([
    {
      messages: [dated('m2', 'c2', '2026-09-02T00:00:00Z'), dated('m1', 'c1', '2026-09-01T00:00:00Z')],
      nextLink: null,
      deltaLink: 'https://graph/delta-final'
    }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);

  await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' });

  assert.deepEqual([...store.messages.values()].map((m) => m.graph_message_id), ['m2', 'm1']);
  assert.equal(cursorStore.saved(), 'https://graph/delta-final');
});

test('resumes from the stored deltaLink on the next run', async () => {
  const graphClient = fakeGraphClient([
    { messages: [], nextLink: null, deltaLink: 'https://graph/delta-next' }
  ]);
  const store = fakeStore();
  const cursorStore = fakeCursorStore('https://graph/delta-saved');

  await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' });

  assert.equal(graphClient.requestedUrls[0], 'https://graph/delta-saved');
  assert.equal(cursorStore.saved(), 'https://graph/delta-next');
});
