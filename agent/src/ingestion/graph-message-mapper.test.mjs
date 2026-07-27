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

// --- direction ---------------------------------------------------------------
// The poller reads the Inbox, but the Inbox is not only inbound: the team's own
// replies land back in it. Measured on a real mailbox, 123 of 345 messages were
// sent BY the support address and were being stored as customer mail.

const supportMailbox = 'contact@qiriness.com';

test('a message sent by the support mailbox is our own reply, not customer mail', () => {
  const { message, conversation } = mapGraphMessage(
    { ...sampleMessage, from: { emailAddress: { name: 'contact', address: supportMailbox } } },
    { mailbox: supportMailbox }
  );
  assert.equal(message.direction, 'outbound');
  // ... and an outbound message never defines who the requester is.
  assert.equal(conversation.requester_email_hash, null);
  assert.equal(conversation.requester_name, null);
});

test('the mailbox comparison ignores case and surrounding space', () => {
  const { message } = mapGraphMessage(
    { ...sampleMessage, from: { emailAddress: { address: '  Contact@Qiriness.COM ' } } },
    { mailbox: supportMailbox }
  );
  assert.equal(message.direction, 'outbound');
});

test('mail from anyone else stays inbound', () => {
  const { message } = mapGraphMessage(sampleMessage, { mailbox: supportMailbox });
  assert.equal(message.direction, 'inbound');
});

test('without a mailbox the caller gets the old behaviour', () => {
  // A caller that has not been updated must be unchanged, not silently
  // mis-classified.
  const { message } = mapGraphMessage({
    ...sampleMessage,
    from: { emailAddress: { address: supportMailbox } }
  });
  assert.equal(message.direction, 'inbound');
});

// --- contact-form notifications ----------------------------------------------
// Shopify sends these from its own infrastructure, so the envelope identifies
// the wrong person: on a real inbox that made 95 tickets share 2 requester hashes.

const contactFormMessage = {
  ...sampleMessage,
  subject: 'Nouveau message de client le 27 juillet 2026 à 09:14',
  from: { emailAddress: { name: 'Qiriness (Shopify)', address: 'mailer@shopify.com' } },
  body: {
    contentType: 'text',
    content: [
      'Vous avez reçu un nouveau message du formulaire de contact de votre boutique en ligne.',
      '',
      'Indicatif de pays:',
      'FR',
      '',
      'Name:',
      'Delphine CADORET',
      '',
      'E-mail:',
      'delph-al@hotmail.fr',
      '',
      'Phone:',
      '',
      'Corps:',
      "Bonjour, je n'ai pas reçu mon code de -20%."
    ].join('\n')
  }
};

test('the customer in the body replaces Shopify in the envelope', () => {
  const { message, conversation } = mapGraphMessage(contactFormMessage, { mailbox: supportMailbox });
  assert.equal(message.from_email, 'delph-al@hotmail.fr');
  assert.equal(message.from_name, 'Delphine CADORET');
  assert.equal(conversation.requester_name, 'Delphine CADORET');
});

test('the requester hash is the customer, so order matching can work', () => {
  // The whole point: requester_email_hash joins to orders.customer_email_hash.
  // Hashing mailer@shopify.com gives every form ticket the same key.
  const { conversation } = mapGraphMessage(contactFormMessage, { mailbox: supportMailbox });
  const expected = createHash('sha256').update('delph-al@hotmail.fr').digest('hex');
  assert.equal(conversation.requester_email_hash, expected);

  const other = mapGraphMessage(
    {
      ...contactFormMessage,
      id: 'AAMkAGI2',
      body: {
        contentType: 'text',
        content: 'formulaire de contact\n\nName:\nAutre Client\n\nE-mail:\nautre@example.fr\n\nCorps:\nBonjour'
      }
    },
    { mailbox: supportMailbox }
  );
  assert.notEqual(other.conversation.requester_email_hash, conversation.requester_email_hash);
});

test('body_text is what the customer wrote, without the form scaffolding', () => {
  const { message } = mapGraphMessage(contactFormMessage, { mailbox: supportMailbox });
  assert.equal(message.body_text, "Bonjour, je n'ai pas reçu mon code de -20%.");
  assert.doesNotMatch(message.body_text, /formulaire de contact|Indicatif de pays|E-mail:/i);
});

test('the original envelope and the extra form fields survive for audit', () => {
  const { message, contactForm } = mapGraphMessage(contactFormMessage, { mailbox: supportMailbox });
  assert.equal(message.raw_graph_payload.contactForm.envelopeFrom.address, 'mailer@shopify.com');
  assert.equal(message.raw_graph_payload.contactForm.countryCode, 'FR');
  // Exposed to the writer too, for the fields the Shopify form will grow later.
  assert.equal(contactForm.countryCode, 'FR');
  assert.equal(contactForm.declaredCategory, null);
});

test('an ordinary email is untouched by the contact-form path', () => {
  const { message, contactForm } = mapGraphMessage(sampleMessage, { mailbox: supportMailbox });
  assert.equal(message.from_email, 'Marie.Dupont@Example.com');
  assert.equal(contactForm, null);
  assert.match(message.body_text, /où est ma commande/);
});
