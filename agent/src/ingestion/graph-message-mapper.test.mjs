import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { mapGraphMessage, cleanBody } from './graph-message-mapper.mjs';

const sampleMessage = {
  id: 'AAMkAGI1',
  conversationId: 'CONV123',
  internetMessageId: '<abc@mail>',
  subject: 'Where is my order?',
  from: { emailAddress: { name: 'Marie Dupont', address: 'Marie.Dupont@Example.com' } },
  toRecipients: [{ emailAddress: { name: 'Support', address: 'support@lap-groupe.com' } }],
  ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
  receivedDateTime: '2026-07-24T10:00:00Z',
  bodyPreview: 'Bonjour, ma commande...',
  body: { contentType: 'html', content: '<p>Bonjour,</p><p>o&ugrave; est ma commande #1042&nbsp;?</p>' },
  hasAttachments: false
};

test('maps a Graph message to ticket_messages fields', () => {
  const { message, removed } = mapGraphMessage(sampleMessage);
  assert.equal(removed, false);
  assert.equal(message.graph_message_id, 'AAMkAGI1');
  assert.equal(message.graph_conversation_id, 'CONV123');
  assert.equal(message.internet_message_id, '<abc@mail>');
  assert.equal(message.direction, 'inbound');
  assert.equal(message.from_email, 'Marie.Dupont@Example.com');
  assert.deepEqual(message.to_emails, ['support@lap-groupe.com']);
  assert.deepEqual(message.cc_emails, ['cc@example.com']);
  assert.equal(message.received_at, '2026-07-24T10:00:00Z');
  assert.equal(message.has_attachments, false);
});

test('cleans the HTML body to text and decodes entities', () => {
  const { message } = mapGraphMessage(sampleMessage);
  assert.match(message.body_text, /Bonjour/);
  assert.match(message.body_text, /où est ma commande #1042/);
  assert.doesNotMatch(message.body_text, /<p>|&ugrave;|&nbsp;/);
});

test('plain-text bodies are not HTML-stripped', () => {
  const text = cleanBody({ contentType: 'text', content: 'a < b and c > d' });
  assert.equal(text, 'a < b and c > d');
});

test('requester email is hashed the same way orders.customer_email_hash is', () => {
  const { conversation } = mapGraphMessage(sampleMessage);
  const expected = createHash('sha256').update('marie.dupont@example.com').digest('hex');
  assert.equal(conversation.requester_email_hash, expected);
  assert.equal(conversation.requester_name, 'Marie Dupont');
  assert.equal(conversation.message_at, '2026-07-24T10:00:00Z');
});

test('the raw payload keeps traceability metadata but not the body content', () => {
  const { message } = mapGraphMessage(sampleMessage);
  assert.equal(message.raw_graph_payload.id, 'AAMkAGI1');
  assert.equal(message.raw_graph_payload.conversationId, 'CONV123');
  assert.ok(!('body' in message.raw_graph_payload));
  assert.ok(!('content' in message.raw_graph_payload));
});

test('removed tombstones are flagged, not mapped to a full row', () => {
  const result = mapGraphMessage({ id: 'AAMkAGI1', conversationId: 'CONV123', '@removed': { reason: 'deleted' } });
  assert.equal(result.removed, true);
  assert.equal(result.graphMessageId, 'AAMkAGI1');
  assert.equal(result.conversationId, 'CONV123');
  assert.equal(result.message, undefined);
});

test('outbound direction does not set requester identity on the ticket', () => {
  const { conversation, message } = mapGraphMessage(sampleMessage, { direction: 'outbound' });
  assert.equal(message.direction, 'outbound');
  assert.equal(conversation.requester_email_hash, null);
  assert.equal(conversation.requester_name, null);
});
