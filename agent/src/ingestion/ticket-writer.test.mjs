import assert from 'node:assert/strict';
import test from 'node:test';

import { writeIngestedMessages } from './ticket-writer.mjs';
import { createAuditCollector } from './spam-audit.mjs';

// In-memory store standing in for Supabase, so the threading + idempotency logic
// is exercised without a database.
function createFakeStore() {
  const tickets = new Map(); // key: shopId|conversationId -> row
  const messages = new Map(); // key: shopId|graphMessageId -> row
  let ticketSeq = 0;

  return {
    tickets,
    messages,
    async findTicketByConversation(shopId, conversationId) {
      return tickets.get(`${shopId}|${conversationId}`) || null;
    },
    async insertTicket(row) {
      ticketSeq += 1;
      const stored = { id: `ticket-${ticketSeq}`, ...row };
      tickets.set(`${shopId(row)}|${row.graph_conversation_id}`, stored);
      return stored;
    },
    async updateTicket(ticketId, patch) {
      for (const row of tickets.values()) {
        if (row.id === ticketId) Object.assign(row, patch);
      }
    },
    async upsertMessage(row) {
      messages.set(`${row.shop_id}|${row.graph_message_id}`, row);
    }
  };

  function shopId(row) {
    return row.shop_id;
  }
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
  const counts = await writeIngestedMessages(store, 'shop-1', [
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

  await writeIngestedMessages(store, 'shop-1', batch);
  const second = await writeIngestedMessages(store, 'shop-1', batch);

  assert.equal(second.ticketsCreated, 0);
  assert.equal(store.tickets.size, 1);
  assert.equal(store.messages.size, 2);
});

test('advances last_message_at as the thread grows, keeps first_message_at', async () => {
  const store = createFakeStore();
  await writeIngestedMessages(store, 'shop-1', [
    mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' }),
    mappedMessage({ id: 'm2', conversationId: 'c1', at: '2026-07-24T11:30:00Z' })
  ]);

  const ticket = store.tickets.get('shop-1|c1');
  assert.equal(ticket.first_message_at, '2026-07-24T10:00:00Z');
  assert.equal(ticket.last_message_at, '2026-07-24T11:30:00Z');
});

test('counts removed tombstones without creating rows', async () => {
  const store = createFakeStore();
  const counts = await writeIngestedMessages(store, 'shop-1', [
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
  await writeIngestedMessages(store, 'shop-1', [first], { triage, audit });
  await writeIngestedMessages(
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
    'shop-1',
    [mappedMessage({ id: 'm1', conversationId: 'c1', at: '2026-07-24T10:00:00Z' })],
    { triage: async () => ({ spam: false }) }
  );
  assert.equal(counts.messagesIngested, 1);
});
