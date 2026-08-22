import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DroppedMailPromotionError,
  canPromote,
  mapAuditRowToItem,
  promoteDroppedMail,
  promotionBlocker
} from './promote-dropped-mail.mjs';

// Same in-memory stand-in as ticket-writer.test.mjs, and deliberately so: the
// promotion's contract is that it writes through the ingestion path, so the
// assertions worth making are about the rows that path produced.
function createFakeStore() {
  const tickets = new Map();
  const messages = new Map();
  let ticketSeq = 0;

  return {
    tickets,
    messages,
    async findByConversation(conversationId) {
      return tickets.get(`shop-1|${conversationId}`) || null;
    },
    async create(row) {
      ticketSeq += 1;
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

function blockedRow(overrides = {}) {
  return {
    id: 'audit-1',
    graph_message_id: 'msg-1',
    graph_conversation_id: 'conv-1',
    outcome: 'blocked',
    decided_by: 'llm',
    label: 'irrelevant',
    reason: 'newsletter',
    from_email: 'marie@example.com',
    subject: 'Votre commande',
    body_text: 'Ou est mon colis ?',
    decided_at: '2026-08-19T09:00:00.000Z',
    ...overrides
  };
}

test('a blocked row carrying a body can be promoted', () => {
  assert.equal(promotionBlocker(blockedRow()), null);
  assert.equal(canPromote(blockedRow()), true);
});

test('a row with no stored body cannot be promoted, expired or never captured alike', () => {
  assert.equal(promotionBlocker(blockedRow({ body_text: null })).code, 'no_body');
  assert.equal(promotionBlocker(blockedRow({ body_text: '   ' })).code, 'no_body');
});

test('a kept row is refused: it is already a ticket', () => {
  assert.equal(promotionBlocker(blockedRow({ outcome: 'kept' })).code, 'not_blocked');
});

test('a row with no Graph message id is refused: nothing to be idempotent on', () => {
  assert.equal(promotionBlocker(blockedRow({ graph_message_id: null })).code, 'no_message_id');
});

test('maps an audit row into the shape the mapper produces', () => {
  const item = mapAuditRowToItem(blockedRow());

  assert.equal(item.removed, false);
  assert.equal(item.graphMessageId, 'msg-1');
  assert.equal(item.conversationId, 'conv-1');
  // Inbound, always: our own replies never reach either gate, so no outbound
  // message can have an audit row to promote.
  assert.equal(item.message.direction, 'inbound');
  assert.equal(item.message.body_text, 'Ou est mon colis ?');
  assert.equal(item.message.subject, 'Votre commande');
  // Never fetched, which is not the same as "no attachments".
  assert.equal(item.message.attachments, null);
  // The decision time stands in for the arrival time — the audit row has no
  // other clock.
  assert.equal(item.message.received_at, '2026-08-19T09:00:00.000Z');
  assert.equal(item.conversation.message_at, '2026-08-19T09:00:00.000Z');
  // The hash, never the address.
  assert.ok(item.conversation.requester_email_hash);
  assert.notEqual(item.conversation.requester_email_hash, 'marie@example.com');
});

test('provenance travels on the message, and never a second copy of the body', () => {
  const payload = mapAuditRowToItem(blockedRow()).message.raw_graph_payload;

  assert.deepEqual(payload.promotedFromSpamAudit, {
    spamAuditId: 'audit-1',
    decidedBy: 'llm',
    label: 'irrelevant',
    reason: 'newsletter',
    decidedAt: '2026-08-19T09:00:00.000Z'
  });
  assert.equal(JSON.stringify(payload).includes('colis'), false);
});

test('a conversation id is not required: the message id stands in', () => {
  const item = mapAuditRowToItem(blockedRow({ graph_conversation_id: null }));
  assert.equal(item.conversationId, 'msg-1');
  assert.equal(item.message.graph_conversation_id, 'msg-1');
});

test('promoting writes a ticket and its message, flagged for categorisation', async () => {
  const store = createFakeStore();

  const result = await promoteDroppedMail({
    store,
    record: store,
    shopId: 'shop-1',
    auditRow: blockedRow()
  });

  assert.equal(result.ticketCreated, true);
  assert.equal(result.messagesIngested, 1);

  const ticket = store.tickets.get('shop-1|conv-1');
  assert.equal(result.ticketId, ticket.id);
  assert.equal(ticket.subject, 'Votre commande');
  assert.equal(ticket.first_message_at, '2026-08-19T09:00:00.000Z');

  const message = store.messages.get('shop-1|msg-1');
  assert.equal(message.ticket_id, ticket.id);
  assert.equal(message.body_text, 'Ou est mon colis ?');
});

test('promoting the same row twice lands on one ticket and one message', async () => {
  const store = createFakeStore();
  const row = blockedRow();

  const first = await promoteDroppedMail({ store, record: store, shopId: 'shop-1', auditRow: row });
  const second = await promoteDroppedMail({ store, record: store, shopId: 'shop-1', auditRow: row });

  assert.equal(second.ticketId, first.ticketId);
  assert.equal(second.ticketCreated, false);
  assert.equal(store.tickets.size, 1);
  assert.equal(store.messages.size, 1);
});

test('a blocked reply joins the ticket its conversation already has', async () => {
  const store = createFakeStore();
  // The thread exists and has been closed — the blocklist matches senders, so it
  // blocks replies into live threads as readily as first contact.
  await store.create({
    graph_conversation_id: 'conv-1',
    subject: 'Votre commande',
    first_message_at: '2026-07-01T09:00:00.000Z',
    last_message_at: '2026-07-01T09:00:00.000Z'
  });
  store.tickets.get('shop-1|conv-1').status = 'closed';

  const result = await promoteDroppedMail({
    store,
    record: store,
    shopId: 'shop-1',
    auditRow: blockedRow()
  });

  const ticket = store.tickets.get('shop-1|conv-1');
  assert.equal(result.ticketCreated, false);
  assert.equal(result.ticketId, ticket.id);
  // Ingestion's own rules, unchanged by the detour: the window extends, the
  // thread reopens, and the categoriser is asked to read it again.
  assert.equal(ticket.last_message_at, '2026-08-19T09:00:00.000Z');
  assert.equal(ticket.needs_categorisation, true);
  assert.equal(ticket.status, 'open');
});

test('an own-side sender is labelled at creation, like any ingested thread', async () => {
  const store = createFakeStore();

  await promoteDroppedMail({
    store,
    record: store,
    shopId: 'shop-1',
    auditRow: blockedRow({ from_email: 'ops@lap-groupe.com' }),
    senderLabel: () => 'internal'
  });

  assert.equal(store.tickets.get('shop-1|conv-1').sender_label, 'internal');
});

test('a row with nothing to read is refused before anything is written', async () => {
  const store = createFakeStore();

  await assert.rejects(
    () =>
      promoteDroppedMail({
        store,
        record: store,
        shopId: 'shop-1',
        auditRow: blockedRow({ body_text: null })
      }),
    (error) => error instanceof DroppedMailPromotionError && error.code === 'no_body'
  );

  assert.equal(store.tickets.size, 0);
  assert.equal(store.messages.size, 0);
});
