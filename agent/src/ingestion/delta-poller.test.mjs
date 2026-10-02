import assert from 'node:assert/strict';
import test from 'node:test';

import { CURSOR_KEYS, runDeltaPoll as runDeltaPollOverProvider, withDeltaLink, withoutLinks } from './delta-poller.mjs';
import { buildSpamGate } from './spam-gate.mjs';
import { createOutlookGraphAdapter } from '../mail/outlook-graph-adapter.mjs';

// These tests script raw Graph pages. The poller reads through a MailProvider,
// so each run wraps the fake Graph client in the real Outlook adapter: what is
// under test is the poller plus the adapter, which is what the worker runs.
const runDeltaPoll = ({ graphClient, ...options }) =>
  runDeltaPollOverProvider({ ...options, provider: createOutlookGraphAdapter({ graphClient, mailbox: options.mailbox }) });

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

// Fake Graph client that serves a scripted list of delta pages. A page that is
// an Error is thrown instead of returned.
function fakeGraphClient(pages) {
  let index = 0;
  const requestedUrls = [];
  const requestedOptions = [];
  return {
    requestedUrls,
    requestedOptions,
    async getDeltaPage(url, options) {
      requestedUrls.push(url);
      requestedOptions.push(options);
      const page = pages[index++];
      if (page instanceof Error) throw page;
      return page;
    }
  };
}

function rejectedLink(status = 400, code = 'BadRequest') {
  const error = new Error(`Graph delta request failed: ${code}`);
  error.status = status;
  error.code = code;
  error.linkRejected = true;
  return error;
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

function fakeCursorStore(initial = null, { resumeLink = null, idType = 'rest' } = {}) {
  let link = initial;
  let resume = resumeLink;
  return {
    saved: () => link,
    resume: () => resume,
    async load() {
      return { deltaLink: link, resumeLink: resume, idType };
    },
    async saveResumeLink(_shopId, next) {
      resume = next;
    },
    async saveDeltaLink(_shopId, deltaLink) {
      link = deltaLink;
      resume = null;
    },
    async clearLinks() {
      link = null;
      resume = null;
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

// --- progress survives an interrupted read (2026-09-26) ----------------------

test('saves the nextLink after each page is written, so a dead read resumes there', async () => {
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);
  const graphClient = fakeGraphClient([
    { messages: [graphMessage('m1', 'c1')], nextLink: 'https://graph/p2', deltaLink: null },
    { messages: [graphMessage('m2', 'c2')], nextLink: 'https://graph/p3', deltaLink: null },
    new Error('socket hang up')
  ]);

  await assert.rejects(runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' }));

  assert.equal(store.messages.size, 2);
  assert.equal(cursorStore.resume(), 'https://graph/p3');
  assert.equal(cursorStore.saved(), null);
});

test('a saved resume link is preferred over the deltaLink, and cleared when the read completes', async () => {
  const store = fakeStore();
  const cursorStore = fakeCursorStore('https://graph/delta-old', { resumeLink: 'https://graph/p3' });
  const graphClient = fakeGraphClient([{ messages: [], nextLink: null, deltaLink: 'https://graph/delta-new' }]);

  await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' });

  assert.equal(graphClient.requestedUrls[0], 'https://graph/p3');
  assert.equal(cursorStore.saved(), 'https://graph/delta-new');
  assert.equal(cursorStore.resume(), null);
});

test('a saved link Graph rejects is logged, dropped, and the read starts over once', async () => {
  const warnings = [];
  const logger = { warn: (event, data) => warnings.push({ event, data }) };
  const store = fakeStore();
  const cursorStore = fakeCursorStore('https://graph/delta-expired');
  const graphClient = fakeGraphClient([
    rejectedLink(410, 'SyncStateNotFound'),
    { messages: [graphMessage('m1', 'c1')], nextLink: null, deltaLink: 'https://graph/delta-fresh' }
  ]);

  await runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1', logger });

  assert.deepEqual(graphClient.requestedUrls, ['https://graph/delta-expired', null]);
  assert.equal(warnings[0].event, 'ingest.cursor_expired');
  assert.deepEqual(warnings[0].data, { shopId: 'shop-1', folder: 'inbox', link: 'delta', status: 410, code: 'SyncStateNotFound' });
  assert.equal(cursorStore.saved(), 'https://graph/delta-fresh');
});

test('a rejected nextLink mid-read is an error, not a reason to start over', async () => {
  const store = fakeStore();
  const cursorStore = fakeCursorStore(null);
  const graphClient = fakeGraphClient([
    { messages: [], nextLink: 'https://graph/p2', deltaLink: null },
    rejectedLink()
  ]);

  await assert.rejects(runDeltaPoll({ graphClient, store, record: store, cursorStore, shopId: 'shop-1' }));
  assert.equal(graphClient.requestedUrls.length, 2);
  assert.equal(cursorStore.resume(), 'https://graph/p2');
});

test('a fresh read that Graph rejects is not retried', async () => {
  const store = fakeStore();
  const graphClient = fakeGraphClient([rejectedLink(), rejectedLink()]);

  await assert.rejects(
    runDeltaPoll({ graphClient, store, record: store, cursorStore: fakeCursorStore(null), shopId: 'shop-1' })
  );
  assert.equal(graphClient.requestedUrls.length, 1);
});

test('immutable ids are asked for on every page once the store says the ids were translated', async () => {
  const store = fakeStore();
  const graphClient = fakeGraphClient([
    { messages: [], nextLink: 'https://graph/p2', deltaLink: null },
    { messages: [], nextLink: null, deltaLink: 'https://graph/delta' }
  ]);

  await runDeltaPoll({
    graphClient, store, record: store, cursorStore: fakeCursorStore(null, { idType: 'immutable' }), shopId: 'shop-1'
  });

  assert.deepEqual(graphClient.requestedOptions.map((o) => o.immutableIds), [true, true]);
});

test('REST ids stay the default while the stored ids have not been translated', async () => {
  const store = fakeStore();
  const graphClient = fakeGraphClient([{ messages: [], nextLink: null, deltaLink: 'https://graph/delta' }]);

  await runDeltaPoll({ graphClient, store, record: store, cursorStore: fakeCursorStore(null), shopId: 'shop-1', limit: 5 });

  assert.equal(graphClient.requestedOptions[0].immutableIds, false);
});

test('the cutover time is written with the first deltaLink and never moved', () => {
  const first = withDeltaLink({ other: 'kept' }, 'https://graph/d1', new Date('2026-09-26T10:00:00Z'));
  assert.equal(first[CURSOR_KEYS.cutoverAt], '2026-09-26T10:00:00.000Z');
  assert.equal(first.other, 'kept');

  const later = withDeltaLink(
    { ...first, [CURSOR_KEYS.resumeLink]: 'https://graph/p9' },
    'https://graph/d2',
    new Date('2026-10-01T10:00:00Z')
  );
  assert.equal(later[CURSOR_KEYS.cutoverAt], '2026-09-26T10:00:00.000Z');
  assert.equal(later[CURSOR_KEYS.deltaLink], 'https://graph/d2');
  assert.equal(CURSOR_KEYS.resumeLink in later, false);
});

test('dropping the links keeps the cutover and the id type', () => {
  const cleared = withoutLinks({
    [CURSOR_KEYS.deltaLink]: 'd',
    [CURSOR_KEYS.resumeLink]: 'r',
    [CURSOR_KEYS.cutoverAt]: '2026-09-26T10:00:00.000Z',
    [CURSOR_KEYS.idType]: 'immutable'
  });
  assert.deepEqual(cleared, {
    [CURSOR_KEYS.cutoverAt]: '2026-09-26T10:00:00.000Z',
    [CURSOR_KEYS.idType]: 'immutable'
  });
});

// --- stage 2: the writer's options arrive, and Sent Items (2026-09-26) -------

function folderCursorStore() {
  const saved = [];
  return {
    saved,
    async load(_shopId, folder) {
      saved.push(['load', folder]);
      return { deltaLink: null, resumeLink: null, idType: 'immutable' };
    },
    async saveResumeLink(_shopId, link, folder) { saved.push(['resume', link, folder]); },
    async saveDeltaLink(_shopId, link, folder) { saved.push(['delta', link, folder]); },
    async clearLinks() {}
  };
}

test('senderLabel and detectRelated reach the writer (they were dropped here until 2026-09-26)', async () => {
  const store = fakeStore();
  const labelled = [];
  const graphClient = fakeGraphClient([
    { messages: [graphMessage('m1', 'c1', 'lea@staff.example')], nextLink: null, deltaLink: 'https://graph/d' }
  ]);

  await runDeltaPoll({
    graphClient, store, record: store, cursorStore: fakeCursorStore(null), shopId: 'shop-1',
    senderLabel: (from) => { labelled.push(from); return from.endsWith('@staff.example') ? 'internal' : null; }
  });

  assert.deepEqual(labelled, ['lea@staff.example']);
  assert.equal([...store.tickets.values()][0].sender_label, 'internal');
});

test('Sent Items: read from its own folder and cursor, filed outbound, never opening a ticket', async () => {
  const store = fakeStore();
  await store.create({ graph_conversation_id: 'c1', subject: 'Colis' });
  const cursorStore = folderCursorStore();
  const sent = (id, conversationId) => ({ ...graphMessage(id, conversationId, 'contact@shop.example'), sentDateTime: '2026-09-20T10:00:00Z' });
  const graphClient = fakeGraphClient([
    { messages: [sent('s1', 'c1'), sent('s2', 'c-nobody')], nextLink: 'https://graph/sent-p2', deltaLink: null },
    { messages: [], nextLink: null, deltaLink: 'https://graph/sent-delta' }
  ]);

  const totals = await runDeltaPoll({
    graphClient, store, record: store, cursorStore, shopId: 'shop-1', folder: 'sentitems', mailbox: 'contact@shop.example'
  });

  assert.deepEqual(graphClient.requestedOptions.map((o) => o.folder), ['sentitems', 'sentitems']);
  assert.deepEqual(cursorStore.saved, [
    ['load', 'sentitems'],
    ['resume', 'https://graph/sent-p2', 'sentitems'],
    ['delta', 'https://graph/sent-delta', 'sentitems']
  ]);
  assert.equal(store.messages.get('shop-1|s1').direction, 'outbound');
  assert.ok(!store.messages.has('shop-1|s2'));
  assert.equal(store.tickets.size, 1, 'no ticket opened');
  assert.equal(totals.skippedNoTicket, 1);
});

test('a Sent Items cursor never writes the cutover; dropping links with no folder clears both', () => {
  const sent = withDeltaLink({}, 'https://graph/sent', new Date('2026-09-26T10:00:00Z'), 'sentitems');
  assert.deepEqual(sent, { [CURSOR_KEYS.sentDeltaLink]: 'https://graph/sent' });

  const all = withoutLinks({
    [CURSOR_KEYS.deltaLink]: 'd', [CURSOR_KEYS.sentDeltaLink]: 's', [CURSOR_KEYS.sentResumeLink]: 'r',
    [CURSOR_KEYS.cutoverAt]: 'c'
  });
  assert.deepEqual(all, { [CURSOR_KEYS.cutoverAt]: 'c' });

  const inboxOnly = withoutLinks({ [CURSOR_KEYS.deltaLink]: 'd', [CURSOR_KEYS.sentDeltaLink]: 's' }, 'inbox');
  assert.deepEqual(inboxOnly, { [CURSOR_KEYS.sentDeltaLink]: 's' });
});

test('the case record reaches the writer: a new conversation opens its case', async () => {
  const store = fakeStore();
  const opened = [];
  const cases = { create: async () => (opened.push(1), { id: `case-${opened.length}` }) };
  const graphClient = fakeGraphClient([
    { messages: [graphMessage('m1', 'c1', 'marie@example.com')], nextLink: null, deltaLink: 'https://graph/d' }
  ]);
  await runDeltaPoll({ graphClient, store, record: store, cursorStore: fakeCursorStore(null), shopId: 'shop-1', cases });
  assert.equal(opened.length, 1);
  assert.equal([...store.tickets.values()][0].case_id, 'case-1');
});
