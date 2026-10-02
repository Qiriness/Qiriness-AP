import assert from 'node:assert/strict';
import test from 'node:test';

import { isStaffReplyToCustomer, writeIngestedMessages } from './ticket-writer.mjs';
import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';
import { createAuditCollector } from './spam-audit.mjs';

// In-memory stand-in for Supabase, so the threading + idempotency logic is
// exercised without a database.
//
// Plays both roles the writer now takes: the MESSAGE store (`upsertMessage`,
// which owns ticket_messages) and the TICKET record (`findByConversation`,
// `create`, `recordMessageArrival`). They are separate objects in the real
// wiring; a test wants one place to look.
function createFakeStore() {
  const tickets = new Map(); // key: shopId|conversationId -> row
  const messages = new Map(); // key: shopId|graphMessageId -> row
  let ticketSeq = 0;

  return {
    tickets,
    messages,
    async findByConversation(conversationId) {
      return tickets.get(`shop-1|${conversationId}`) || null;
    },
    async create(row) {
      ticketSeq += 1;
      // The record stamps shop_id from the shop it was built for.
      const stored = { id: `ticket-${ticketSeq}`, shop_id: 'shop-1', ...row };
      tickets.set(`shop-1|${row.graph_conversation_id}`, stored);
      return stored;
    },
    async recordMessageArrival(ticketId, patch) {
      if (!patch || Object.keys(patch).length === 0) return null;
      for (const row of tickets.values()) {
        if (row.id === ticketId) Object.assign(row, patch);
      }
      return null;
    },
    async upsertMessage(row) {
      messages.set(`${row.shop_id}|${row.graph_message_id}`, row);
    }
  };
}

function mappedMessage({ id, conversationId, at, subject = 'Subject', direction = 'inbound' }) {
  return {
    removed: false,
    graphMessageId: id,
    conversationId,
    message: {
      graph_message_id: id,
      from_email: 'marie@example.com',
      subject,
      graph_conversation_id: conversationId,
      direction,
      body_text: 'body',
      received_at: at
    },
    conversation: {
      graph_conversation_id: conversationId,
      subject,
      requester_email_hash: 'hash',
      requester_name: 'Marie',
      message_at: at
    }
  };
}

test('creates one ticket per conversation and ingests each message', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:00:00Z' }),
    mappedMessage({ id: 'm3', conversationId: 'c2', at: '2026-07-24T12:00:00Z' })
  ]);

  assert.equal(counts.ticketsCreated, 2);
  assert.equal(counts.messagesIngested, 3);
  assert.equal(store.tickets.size, 2);
  assert.equal(store.messages.size, 3);
});

test('re-ingesting the same messages is idempotent (no dup tickets or messages)', async () => {
  const store = createFakeStore();
  const batch = [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:00:00Z' })
  ];

  await writeIngestedMessages(store, store, 'shop-1', batch);
  const second = await writeIngestedMessages(store, store, 'shop-1', batch);

  assert.equal(second.ticketsCreated, 0);
  assert.equal(store.tickets.size, 1);
  assert.equal(store.messages.size, 2);
});

test('advances last_message_at as the thread grows, keeps first_message_at', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);

  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.first_message_at, '2026-07-24T10:00:00Z');
  assert.equal(ticket.last_message_at, '2026-07-24T11:30:00Z');
});

test('first_message_at moves backwards when an older message arrives later', async () => {
  // Graph's delta does not return messages in chronological order, so on an
  // initial enumeration a thread is routinely opened by one of its later
  // replies. Without this the column holds "the first message we saw", which
  // mis-sorts the categoriser queue (ordered on first_message_at).
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);

  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.first_message_at, '2026-07-24T10:00:00Z');
  // ... and the later message still holds the top of the window.
  assert.equal(ticket.last_message_at, '2026-07-24T11:30:00Z');
});

test('an out-of-order batch settles on the true window whatever the order', async () => {
  const order = ['2026-07-24T12:00:00Z', '2026-07-24T09:00:00Z', '2026-07-24T15:00:00Z'];
  const store = createFakeStore();
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    order.map((at, i) => mappedMessage({ id: `m${i}`, conversationId: 'c1', at }))
  );

  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.first_message_at, '2026-07-24T09:00:00Z');
  assert.equal(ticket.last_message_at, '2026-07-24T15:00:00Z');
});

test('a new inbound message puts the ticket back in the categoriser queue', async () => {
  // Without this the first label a ticket receives is permanent, and a thread
  // that turns into a lost parcel (or a threat to sue) keeps the labels of the
  // email that opened it.
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);
  // Simulate the categoriser having settled the ticket.
  const ticket = store.tickets.get('shop-1|c1');
  ticket.needs_categorisation = false;

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);
  assert.equal(ticket.needs_categorisation, true);
});

test('our own outbound reply does not trigger a re-categorisation', async () => {
  // last_message_at advances on outbound too, so gating on the message direction
  // is what stops the agent paying to re-read a thread it just answered itself.
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);
  const ticket = store.tickets.get('shop-1|c1');
  ticket.needs_categorisation = false;

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({
      id: 'm2',
      conversationId: 'c1',
      at: '2026-07-24T12:00:00Z',
      direction: 'outbound'
    })
  ]);
  assert.equal(ticket.needs_categorisation, false);
  // ... the thread timestamp still moves, though.
  assert.equal(ticket.last_message_at, '2026-07-24T12:00:00Z');
});

test('a customer reply reopens a ticket that auto-close had retired', async () => {
  // The other half of lifecycle/auto-close.mjs: without this, a reply lands on a
  // closed ticket and nobody sees it — the queue is tidy and wrong.
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-06-01T10:00:00Z' })
  ]);
  const ticket = store.tickets.get('shop-1|c1');
  Object.assign(ticket, {
    status: 'closed',
    closed_at: '2026-06-22T10:00:00Z',
    resolved_at: '2026-06-22T10:00:00Z'
  });

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);

  assert.equal(ticket.status, 'open');
  // Cleared together with the status, or the ticket still reads as finished to
  // anything looking at the timestamps rather than at the status.
  assert.equal(ticket.closed_at, null);
  assert.equal(ticket.resolved_at, null);
});

test('our own reply into a closed ticket does not reopen it', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-06-01T10:00:00Z' })
  ]);
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'closed';

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({
      id: 'm2',
      conversationId: 'c1',
      at: '2026-07-24T12:00:00Z',
      direction: 'outbound'
    })
  ]);
  assert.equal(ticket.status, 'closed');
});

test('a reply pulls a ticket back out of awaiting_customer', async () => {
  // REVERSED 2026-08-14, and the earlier rule was right for its time: only the
  // terminal statuses were rewritten, because "the worker's other states are its
  // own". Nothing set them, so nothing could go wrong.
  //
  // The investigation now sets `awaiting_customer` from a `needs_customer_input`
  // verdict, and BOTH the categoriser and the investigation runner select on
  // `status = 'open'`. Left parked, a ticket whose customer answered the question
  // we asked would never be read again — the reply lands, the pipeline ignores
  // it, and the queue looks clean because the work vanished.
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'awaiting_customer';

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);
  assert.equal(ticket.status, 'open');
});

test('an inbound reply into an already-open ticket rewrites nothing', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);
  const ticket = store.tickets.get('shop-1|c1');
  // The column defaults to 'open' in the database; the fake store does not.
  ticket.status = 'open';
  ticket.closed_at = null;

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.closed_at, null, 'nothing was rewritten');
});

test('counts removed tombstones without creating rows', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(store, store, 'shop-1', [
    { removed: true, graphMessageId: 'm9', conversationId: 'c9' }
  ]);
  assert.equal(counts.removed, 1);
  assert.equal(counts.messagesIngested, 0);
  assert.equal(store.tickets.size, 0);
});

test('LLM triage drops a new-conversation spam before anything is stored', async () => {
  const store = createFakeStore();
  const triage = async () => ({ spam: true });
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { triage }
  );

  assert.equal(counts.llmSpamFiltered, 1);
  assert.equal(counts.ticketsCreated, 0);
  assert.equal(counts.messagesIngested, 0);
  assert.equal(store.tickets.size, 0);
  assert.equal(store.messages.size, 0);
});

test('LLM triage is skipped for replies into an existing ticket', async () => {
  const store = createFakeStore();
  // First message creates the ticket (triage keeps it).
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { triage: async () => ({ spam: false }) }
  );

  let triageCalls = 0;
  const triage = async () => {
    triageCalls += 1;
    return { spam: true };
  };
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:00:00Z' })],
    { triage }
  );

  assert.equal(triageCalls, 0); // existing ticket -> reply is never triaged
  assert.equal(counts.messagesIngested, 1);
  assert.equal(store.messages.size, 2);
});

test('audits a dropped email — the only trace it leaves', async () => {
  const store = createFakeStore();
  const audit = createAuditCollector();
  const triage = async () => ({
    spam: true,
    label: 'spam',
    reason: 'prospection SEO non sollicitée',
    model: 'gpt-4o-mini'
  });

  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z', subject: 'Offre SEO' })],
    { triage, audit }
  );

  assert.equal(store.messages.size, 0); // nothing stored...
  assert.equal(audit.size, 1); // ...but the decision is recorded
  const [entry] = audit.entries();
  assert.equal(entry.outcome, 'blocked');
  assert.equal(entry.decidedBy, 'llm');
  assert.equal(entry.graphMessageId, 'm1');
  assert.equal(entry.reason, 'prospection SEO non sollicitée');
  assert.equal(entry.subject, 'Offre SEO');
  assert.equal(entry.failedOpen, false);
});

test('audits a kept email too, so a pass is reviewable', async () => {
  const store = createFakeStore();
  const audit = createAuditCollector();
  const triage = async () => ({ spam: false, label: 'keep', reason: 'unsure', model: 'gpt-4o-mini' });

  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { triage, audit }
  );

  assert.equal(store.messages.size, 1);
  const [entry] = audit.entries();
  assert.equal(entry.outcome, 'kept');
  assert.equal(entry.reason, 'unsure');
});

test('an untriaged reply produces no audit row (no decision was made)', async () => {
  const store = createFakeStore();
  const audit = createAuditCollector();
  const triage = async () => ({ spam: false, label: 'keep', reason: 'client légitime' });

  const first = mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' });
  await writeIngestedMessages(store, store, 'shop-1', [first], { triage, audit });
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:00:00Z' })],
    { triage, audit }
  );

  // Only the new conversation was judged; the reply bypassed the gate entirely.
  assert.equal(audit.size, 1);
  assert.equal(audit.entries()[0].graphMessageId, 'm1');
});

test('writes without an audit collector still work (auditing is optional)', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { triage: async () => ({ spam: false }) }
  );
  assert.equal(counts.messagesIngested, 1);
});

// --- inline embedding --------------------------------------------------------

test('the message is stored complete, with its vector, in one write', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { embedMessage: async () => ({ embedding: '[0.1,0.2]', embedding_model: 'text-embedding-3-small' }) }
  );

  const stored = store.messages.get('shop-1|m1');
  assert.equal(stored.embedding, '[0.1,0.2]');
  assert.equal(stored.embedding_model, 'text-embedding-3-small');
  // The body is still there — embedding augments the row, it does not replace it.
  assert.equal(stored.body_text, 'body');
});

test('an embedding failure never fails ingestion', async () => {
  // The contract the whole design rests on: a missing vector degrades retrieval
  // to the category filter, a failed ingestion loses an email.
  const store = createFakeStore();
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    {
      embedMessage: async () => {
        throw new Error('embeddings API down');
      }
    }
  );
  assert.equal(counts.messagesIngested, 1);
  assert.equal(counts.messagesEmbedded, 0);
  assert.ok(store.messages.get('shop-1|m1'));
});

test('a null embedding stores the message unchanged for the reconciler', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { embedMessage: async () => null }
  );
  const stored = store.messages.get('shop-1|m1');
  assert.equal(counts.messagesEmbedded, 0);
  assert.equal('embedding' in stored, false);
  assert.equal(stored.body_text, 'body');
});

test('without an embedder, ingestion is exactly as before', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);
  assert.equal(counts.messagesIngested, 1);
  assert.equal(counts.messagesEmbedded, 0);
  assert.equal('embedding' in store.messages.get('shop-1|m1'), false);
});

test('outbound replies are embedded too — they are the A half of Q->A', async () => {
  const store = createFakeStore();
  const seen = [];
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [
      mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
      mappedMessage({
        id: 'm2',
        conversationId: 'c1',
        at: '2026-07-24T11:00:00Z',
        direction: 'outbound'
      })
    ],
    {
      embedMessage: async (message) => {
        seen.push(message.direction);
        return { embedding: '[0]' };
      }
    }
  );
  assert.deepEqual(seen, ['inbound', 'outbound']);
});


test('a thread opened by one of our own addresses is labelled at creation', async () => {
  // The label is a FACT read off the address rather than a judgement, so it is
  // written in the same insert that creates the ticket instead of by a later
  // pass — there is no window in which a colleague's thread looks like a
  // customer's to the drafting queue.
  const store = createFakeStore();
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { senderLabel: () => 'internal' }
  );

  assert.equal([...store.tickets.values()][0].sender_label, 'internal');
});

test('a consumer thread carries no label, and none is invented', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { senderLabel: () => null }
  );

  assert.equal([...store.tickets.values()][0].sender_label, null);
});

test('the label is read from the sender, not from the ticket it lands on', async () => {
  // Two conversations in one batch, one of ours and one a customer's: the
  // labeller is asked per message, so a colleague writing in does not taint the
  // customer thread that arrived beside it.
  const store = createFakeStore();
  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [
      mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
      mappedMessage({ id: 'm2', conversationId: 'c2', at: '2026-07-24T11:00:00Z' })
    ],
    { senderLabel: (from) => (from === 'colleague@lap-groupe.com' ? 'internal' : null) }
  );

  const labels = [...store.tickets.values()].map((row) => row.sender_label);
  assert.deepEqual(labels, [null, null], 'the fixture sender is a consumer on both');
});

test('with no labeller wired the column is simply null', async () => {
  // Optional like every other injected collaborator: a deployment without the
  // directory still ingests mail.
  const store = createFakeStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })
  ]);

  assert.equal([...store.tickets.values()][0].sender_label, null);
});

// --------------------------------------------------------------- re-delivery
//
// The regression these guard is measured, not hypothetical: a delta
// re-enumeration on 2026-08-20 reopened 136 auto-closed tickets, 128 of them off
// messages already in the database, and re-flagged 374 of 400 for
// categorisation. See DECISIONS.md § Re-delivery is not arrival.

function storeKnowing(...knownIds) {
  const store = createFakeStore();
  store.knownMessageIds = async () => new Set(knownIds);
  return store;
}

test('a RE-DELIVERED inbound message does not reopen a closed ticket', async () => {
  const store = storeKnowing('m1');
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    first_message_at: '2026-05-01T09:00:00.000Z',
    last_message_at: '2026-05-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'closed';
  ticket.closed_at = '2026-06-01T09:00:00.000Z';
  ticket.needs_categorisation = false;

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-05-01T09:00:00.000Z' })
  ]);

  assert.equal(ticket.status, 'closed', 'stayed closed');
  assert.equal(ticket.closed_at, '2026-06-01T09:00:00.000Z', 'kept its close date');
  assert.notEqual(ticket.needs_categorisation, true, 'not re-queued for the categoriser');
  // The message itself is still written: the upsert is idempotent and is what
  // makes a re-sync safe to run at all.
  assert.ok(store.messages.get('shop-1|m1'));
});

test('a genuinely NEW inbound message still reopens a closed ticket', async () => {
  const store = storeKnowing('m1'); // m1 known, m2 is new
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    first_message_at: '2026-05-01T09:00:00.000Z',
    last_message_at: '2026-05-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'closed';
  ticket.closed_at = '2026-06-01T09:00:00.000Z';

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-08-20T09:00:00.000Z' })
  ]);

  assert.equal(ticket.status, 'open', 'a customer writing back still reopens');
  assert.equal(ticket.closed_at, null);
  assert.equal(ticket.needs_categorisation, true);
});

test('a re-delivered message still repairs a missing requester', async () => {
  // The repair is idempotent and outside the guard on purpose: a re-sync is the
  // second chance to learn who wrote in.
  const store = storeKnowing('m1');
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    requester_email_hash: null,
    requester_name: null,
    first_message_at: '2026-05-01T09:00:00.000Z',
    last_message_at: '2026-05-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-05-01T09:00:00.000Z' })
  ]);

  assert.equal(ticket.requester_email_hash, 'hash');
  assert.equal(ticket.requester_name, 'Marie');
});

test('the known-id lookup stays under the URL length measured to fail', async () => {
  // 100 real Graph ids failed every attempt and 75 succeeded (2026-09-14). A
  // worst case of 152 characters, a third of them percent-encoded, must fit
  // well inside what 75 proved.
  const { KNOWN_ID_CHUNK } = await import('./ticket-writer.mjs');
  const encoded = (n) => n * (152 + 2 * Math.ceil(152 / 3) + 3);
  assert.ok(KNOWN_ID_CHUNK <= 50);
  assert.ok(encoded(KNOWN_ID_CHUNK) < encoded(75));
});

test('a store with no knownMessageIds behaves exactly as before', async () => {
  // Backwards compatibility is the contract: the guard makes a re-sync safe and
  // its absence must never change ingestion.
  const store = createFakeStore();
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    first_message_at: '2026-05-01T09:00:00.000Z',
    last_message_at: '2026-05-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'closed';

  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-05-01T09:00:00.000Z' })
  ]);

  assert.equal(ticket.status, 'open');
});

test('a failing knownMessageIds lookup fails OPEN, never silently swallowing a reopen', async () => {
  const store = createFakeStore();
  store.knownMessageIds = async () => { throw new Error('supabase down'); };
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    first_message_at: '2026-05-01T09:00:00.000Z',
    last_message_at: '2026-05-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'closed';

  const warnings = [];
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-05-01T09:00:00.000Z' })
  ], { logger: { warn: (name) => warnings.push(name) } });

  // Reopened, because an unknown must never be read as "already held" — that
  // would strand a real reply on a closed ticket.
  assert.equal(ticket.status, 'open');
  assert.ok(warnings.includes('ingest.known_message_lookup_failed'));
});

// --- a colleague answering from a personal inbox is OUR reply (2026-09-26) ---
//
// 105 such messages were stored `inbound` on 80 tickets: each re-queued its
// ticket, could reopen it, and did not count as an answer for drafting.

const CUSTOMER = 'marie@example.com';
const staffLabel = (from) => (/@(shop\.example|staff\.example)$/i.test(from) ? 'internal' : /@partner\.example$/.test(from) ? 'logistics' : null);
const customerTicket = { requester_email_hash: hashIdentifier(CUSTOMER), sender_label: null };

function staffMessage({ from = 'lea@staff.example', to = [CUSTOMER], cc = [] } = {}) {
  return { direction: 'inbound', from_email: from, to_emails: to, cc_emails: cc };
}

test('a staff address writing to the customer is our reply', () => {
  assert.equal(isStaffReplyToCustomer(staffMessage(), customerTicket, staffLabel), true);
  assert.equal(isStaffReplyToCustomer(staffMessage({ from: 'anna@shop.example', to: ['x@partner.example'], cc: ['MARIE@example.com'] }), customerTicket, staffLabel), true, 'Cc counts, and case does not matter');
});

test('a staff address not writing to the customer stays a colleague message', () => {
  assert.equal(isStaffReplyToCustomer(staffMessage({ to: ['x@partner.example'] }), customerTicket, staffLabel), false);
});

test('only internal staff: a partner writing to the customer is not our reply', () => {
  assert.equal(isStaffReplyToCustomer(staffMessage({ from: 'ops@partner.example' }), customerTicket, staffLabel), false);
});

test('no rule on a thread a colleague opened, or before the customer is known', () => {
  assert.equal(isStaffReplyToCustomer(staffMessage(), { ...customerTicket, sender_label: 'internal' }, staffLabel), false);
  assert.equal(isStaffReplyToCustomer(staffMessage(), { requester_email_hash: null }, staffLabel), false);
  const selfRequester = { requester_email_hash: hashIdentifier('lea@staff.example'), sender_label: null };
  assert.equal(isStaffReplyToCustomer(staffMessage({ to: ['lea@staff.example'] }), selfRequester, staffLabel), false);
});

test('without a labeller nothing is reclassified', () => {
  assert.equal(isStaffReplyToCustomer(staffMessage(), customerTicket, undefined), false);
});

test('a new staff reply to the customer is stored outbound, and neither reopens nor re-queues', async () => {
  const store = storeKnowing();
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    requester_email_hash: hashIdentifier(CUSTOMER),
    first_message_at: '2026-09-01T09:00:00.000Z',
    last_message_at: '2026-09-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'awaiting_customer';
  ticket.needs_categorisation = false;

  const item = mappedMessage({ id: 'm9', conversationId: 'c1', at: '2026-09-02T09:00:00.000Z' });
  Object.assign(item.message, { from_email: 'lea@staff.example', to_emails: [CUSTOMER], cc_emails: ['contact@shop.example'] });
  Object.assign(item.conversation, { requester_email_hash: hashIdentifier('lea@staff.example'), requester_name: 'Léa' });

  await writeIngestedMessages(store, store, 'shop-1', [item], { senderLabel: staffLabel });

  assert.equal(store.messages.get('shop-1|m9').direction, 'outbound');
  assert.equal(ticket.status, 'awaiting_customer', 'our reply does not reopen');
  assert.notEqual(ticket.needs_categorisation, true, 'our reply does not re-queue');
  assert.equal(ticket.requester_email_hash, hashIdentifier(CUSTOMER), 'the requester is not touched');
  assert.equal(ticket.last_message_at, '2026-09-02T09:00:00.000Z');
});

test('a staff message to a colleague still reopens and re-queues, as any inbound does', async () => {
  const store = storeKnowing();
  await store.create({
    graph_conversation_id: 'c1',
    subject: 'Colis',
    requester_email_hash: hashIdentifier(CUSTOMER),
    first_message_at: '2026-09-01T09:00:00.000Z',
    last_message_at: '2026-09-01T09:00:00.000Z'
  });
  const ticket = store.tickets.get('shop-1|c1');
  ticket.status = 'awaiting_customer';

  const item = mappedMessage({ id: 'm9', conversationId: 'c1', at: '2026-09-02T09:00:00.000Z' });
  Object.assign(item.message, { from_email: 'lea@staff.example', to_emails: ['contact@shop.example'], cc_emails: [] });

  await writeIngestedMessages(store, store, 'shop-1', [item], { senderLabel: staffLabel });

  assert.equal(store.messages.get('shop-1|m9').direction, 'inbound');
  assert.equal(ticket.status, 'open');
});

// --- stage 2: copies of our own mail, and attach-only (2026-09-26) -----------

test('an outbound message already stored under another Graph id is skipped as a copy', async () => {
  const store = storeKnowing();
  store.storedInternetMessageIds = async () => new Map([['<r1@x>', new Set(['inbox-copy'])]]);
  await store.create({ graph_conversation_id: 'c1', subject: 'Colis' });

  const item = mappedMessage({ id: 'sent-copy', conversationId: 'c1', at: '2026-09-20T10:00:00Z', direction: 'outbound' });
  item.message.internet_message_id = '<r1@x>';
  const counts = await writeIngestedMessages(store, store, 'shop-1', [item]);

  assert.equal(counts.skippedCopies, 1);
  assert.equal(store.messages.size, 0);
});

test('re-delivery of the same Graph item is not a copy, and inbound mail is never skipped as one', async () => {
  const store = storeKnowing();
  store.storedInternetMessageIds = async () => new Map([['<r1@x>', new Set(['m1'])]]);
  await store.create({ graph_conversation_id: 'c1', subject: 'Colis' });

  const same = mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-09-20T10:00:00Z', direction: 'outbound' });
  same.message.internet_message_id = '<r1@x>';
  const inbound = mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-09-20T11:00:00Z' });
  inbound.message.internet_message_id = '<r1@x>';

  const counts = await writeIngestedMessages(store, store, 'shop-1', [same, inbound]);
  assert.equal(counts.skippedCopies, 0);
  assert.equal(store.messages.size, 2);
});

test('attachOnly skips a thread with no ticket instead of opening one', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(
    store, store, 'shop-1',
    [mappedMessage({ id: 's1', conversationId: 'c-new', at: '2026-09-20T10:00:00Z', direction: 'outbound' })],
    { attachOnly: true }
  );
  assert.equal(counts.skippedNoTicket, 1);
  assert.equal(store.tickets.size, 0);
  assert.equal(store.messages.size, 0);
});

// --- the opener and the requester come from the thread, not from arrival order (2026-09-26)
//
// 174 tickets had a colleague as requester after the first full read: Graph
// delivered the staff reply before the customer's message, and whichever
// message created the ticket named its requester for good.

const IDENTITY_MAILBOX = 'contact@shop.example';
const ownLabel = (from) => (/@(shop\.example|staff\.example)$/i.test(from) ? 'internal' : null);
const notCourier = (from) => !/@courier\.example$/i.test(from);

// A store that can read a thread back, like the Supabase one.
function threadStore() {
  const store = storeKnowing();
  store.threadMessages = async (ticketId) =>
    [...store.messages.values()].filter((m) => m.ticket_id === ticketId).map((m) => ({ ...m, id: m.graph_message_id }));
  store.directionChanges = [];
  store.setMessageDirection = async (id, direction) => {
    store.directionChanges.push([id, direction]);
    for (const m of store.messages.values()) if (m.graph_message_id === id) m.direction = direction;
  };
  return store;
}

function message({ id, from, name, to = [], at, conversationId = 'c1' }) {
  const item = mappedMessage({ id, conversationId, at });
  Object.assign(item.message, { from_email: from, from_name: name, to_emails: to, cc_emails: [] });
  Object.assign(item.conversation, { requester_email_hash: hashIdentifier(from), requester_name: name });
  return item;
}

test('a staff reply ingested BEFORE the customer message it answers: the customer still ends up the requester', async () => {
  const store = threadStore();
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX };
  const reply = message({ id: 'r1', from: 'lea@staff.example', name: 'Léa', to: [CUSTOMER], at: '2026-09-02T10:00:00Z' });
  const question = message({ id: 'q1', from: CUSTOMER, name: 'Marie', to: [IDENTITY_MAILBOX], at: '2026-09-01T10:00:00Z' });

  // Graph's order: the reply first.
  await writeIngestedMessages(store, store, 'shop-1', [reply], options);
  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.requester_email_hash, hashIdentifier('lea@staff.example'), 'the bug, reproduced: the colleague first');
  assert.equal(ticket.sender_label, 'internal');

  const counts = await writeIngestedMessages(store, store, 'shop-1', [question], options);

  assert.equal(ticket.requester_email_hash, hashIdentifier(CUSTOMER));
  assert.equal(ticket.requester_name, 'Marie');
  assert.equal(ticket.sender_label, null, 'the real opener is the customer');
  assert.equal(store.messages.get('shop-1|r1').direction, 'outbound', 'the earlier staff reply is re-filed as ours');
  assert.equal(store.messages.get('shop-1|q1').direction, 'inbound');
  assert.deepEqual([counts.requestersCorrected, counts.openersCorrected, counts.directionsCorrected], [1, 1, 1]);
});

test('in chronological order nothing needs correcting', async () => {
  const store = threadStore();
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q1', from: CUSTOMER, name: 'Marie', at: '2026-09-01T10:00:00Z' })], options);
  const counts = await writeIngestedMessages(
    store, store, 'shop-1',
    [message({ id: 'r1', from: 'lea@staff.example', name: 'Léa', to: [CUSTOMER], at: '2026-09-02T10:00:00Z' })],
    options
  );
  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.requester_email_hash, hashIdentifier(CUSTOMER));
  assert.equal(store.messages.get('shop-1|r1').direction, 'outbound');
  assert.deepEqual([counts.requestersCorrected, counts.openersCorrected, counts.directionsCorrected], [0, 0, 0]);
});

test('a customer requester is never replaced by another correspondent: write-once still holds for them', async () => {
  const store = threadStore();
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q1', from: CUSTOMER, name: 'Marie', at: '2026-09-02T10:00:00Z' })], options);
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q0', from: 'paul@example.com', name: 'Paul', at: '2026-09-01T10:00:00Z' })], options);
  assert.equal(store.tickets.get('shop-1|c1').requester_email_hash, hashIdentifier(CUSTOMER));
});

test('a colleague thread ABOUT a customer keeps its label; the customer who writes becomes the requester', async () => {
  const store = threadStore();
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'n1', from: 'lea@staff.example', name: 'Léa', at: '2026-09-01T10:00:00Z' })], options);
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q1', from: CUSTOMER, name: 'Marie', at: '2026-09-02T10:00:00Z' })], options);
  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.sender_label, 'internal', 'the colleague really did open it');
  assert.equal(ticket.requester_email_hash, hashIdentifier(CUSTOMER), 'whose case it is');
});

test("a courier's mail never becomes the requester", async () => {
  const store = threadStore();
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'n1', from: 'lea@staff.example', name: 'Léa', at: '2026-09-01T10:00:00Z' })], options);
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 't1', from: 'suivi@courier.example', name: 'Suivi', at: '2026-09-02T10:00:00Z' })], options);
  assert.equal(store.tickets.get('shop-1|c1').requester_email_hash, hashIdentifier('lea@staff.example'));
});

test('a thread read that fails leaves the ticket as it was and still stores the message', async () => {
  const store = threadStore();
  const warnings = [];
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX, logger: { warn: (e) => warnings.push(e), info() {} } };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'r1', from: 'lea@staff.example', name: 'Léa', to: [CUSTOMER], at: '2026-09-02T10:00:00Z' })], options);
  store.threadMessages = async () => { throw new Error('timeout'); };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q1', from: CUSTOMER, name: 'Marie', at: '2026-09-01T10:00:00Z' })], options);
  assert.ok(store.messages.get('shop-1|q1'));
  assert.deepEqual(warnings, ['ingest.thread_identity_failed']);
});

test('each stored message carries its actor, and a re-filed staff reply moves to support', async () => {
  const store = threadStore();
  const actorFor = (m) => (m.direction === 'outbound' ? 'support' : ownLabel(m.from_email) ? 'colleague' : 'customer');
  const options = { senderLabel: ownLabel, isCandidate: notCourier, mailbox: IDENTITY_MAILBOX, actorFor };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'r1', from: 'lea@staff.example', name: 'Léa', to: [CUSTOMER], at: '2026-09-02T10:00:00Z' })], options);
  assert.equal(store.messages.get('shop-1|r1').actor, 'colleague', 'before the customer is known');

  store.setMessageDirection = async (id, direction, actor) => {
    for (const m of store.messages.values()) if (m.graph_message_id === id) Object.assign(m, { direction, actor });
  };
  await writeIngestedMessages(store, store, 'shop-1', [message({ id: 'q1', from: CUSTOMER, name: 'Marie', at: '2026-09-01T10:00:00Z' })], options);
  assert.equal(store.messages.get('shop-1|q1').actor, 'customer');
  assert.deepEqual([store.messages.get('shop-1|r1').direction, store.messages.get('shop-1|r1').actor], ['outbound', 'support']);
});

// ------------------------------------------------------------------- snooze

function snoozedStore(...knownIds) {
  const store = storeKnowing(...knownIds);
  store.woken = [];
  store.wakeSnooze = async (shopId, ticketId, reason) => {
    store.woken.push({ shopId, ticketId, reason });
    return { id: 's1' };
  };
  return store;
}

test('a new message from the customer wakes a snoozed ticket; a re-delivered one does not', async () => {
  const store = snoozedStore('m1');
  const counts = await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-09-01T09:00:00.000Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-09-30T09:00:00.000Z' })
  ], { actorFor: () => 'customer' });
  assert.equal(store.woken.length, 1);
  assert.equal(store.woken[0].reason, 'customer_message');
  assert.equal(counts.snoozesWoken, 1);
});

test('a partner writing wakes it as a partner message; our own reply wakes nothing', async () => {
  const store = snoozedStore();
  await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-09-29T09:00:00.000Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-09-30T09:00:00.000Z', direction: 'outbound' })
  ], { actorFor: (message) => (message.direction === 'outbound' ? 'support' : 'partner') });
  assert.deepEqual(store.woken.map((w) => w.reason), ['partner_message']);
});

test('a failed wake never fails ingestion', async () => {
  const store = snoozedStore();
  store.wakeSnooze = async () => { throw new Error('supabase down'); };
  const counts = await writeIngestedMessages(store, store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-09-30T09:00:00.000Z' })
  ]);
  assert.equal(counts.messagesIngested, 1);
  assert.equal(counts.snoozesWoken, 0);
});

// ---------------------------------------------------------------- cases

function createFakeCases() {
  const created = [];
  const decisions = [];
  const threadsByCase = new Map();
  return {
    created,
    decisions,
    threadsByCase,
    async create() {
      const row = { id: `case-${created.length + 1}` };
      created.push(row);
      return row;
    },
    async applyDecision(decision) {
      decisions.push(decision);
      return { decision: 'link', caseId: decision.toCaseId };
    },
    async threads(caseId) {
      return threadsByCase.get(caseId) ?? [];
    }
  };
}

test('a new conversation opens its own case, pending a link decision', async () => {
  const store = createFakeStore();
  const cases = createFakeCases();
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [
      mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
      mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:00:00Z' })
    ],
    { cases }
  );
  assert.equal(counts.casesCreated, 1, 'a reply on the same thread opens no second case');
  const ticket = [...store.tickets.values()][0];
  assert.equal(ticket.case_id, 'case-1');
  assert.equal(ticket.case_link_state, 'pending');
});

test('a duplicate joins its original case instead of being silenced', async () => {
  const store = createFakeStore();
  store.linkDuplicate = async () => assert.fail('with cases, no duplicate link is written');
  const cases = createFakeCases();
  const counts = await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c-new', at: '2026-07-24T10:00:00Z' })],
    {
      cases,
      detectDuplicate: async () => ({ ticketId: 'ticket-old', caseId: 'case-old', reason: 'reply_chain' })
    }
  );
  assert.equal(counts.duplicatesLinked, 1);
  assert.deepEqual(cases.decisions, [
    {
      ticketId: 'ticket-1',
      fromCaseId: 'case-1',
      toCaseId: 'case-old',
      method: 'reply_chain',
      candidates: [{ case_id: 'case-old', reasons: ['reply_chain'] }]
    }
  ]);
});

test('a new customer message wakes the snoozes of every thread of its case', async () => {
  const store = createFakeStore();
  const woken = [];
  store.wakeSnooze = async (_shop, ticketId, reason) => {
    woken.push([ticketId, reason]);
    return true;
  };
  store.tickets.set('shop-1|c1', { id: 'ticket-a', shop_id: 'shop-1', case_id: 'case-9', status: 'open' });
  const cases = createFakeCases();
  cases.threadsByCase.set('case-9', [{ id: 'ticket-a' }, { id: 'ticket-b' }]);

  await writeIngestedMessages(
    store,
    store,
    'shop-1',
    [mappedMessage({ id: 'm-new', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { cases }
  );
  assert.deepEqual(woken, [
    ['ticket-a', 'customer_message'],
    ['ticket-b', 'customer_message']
  ]);
});
