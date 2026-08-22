import assert from 'node:assert/strict';
import test from 'node:test';

import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { ORDER_LINE, buildSyntheticTicket } from './synthetic-message.mjs';

const SHOP = 'shop-1';
const build = (input) => buildSyntheticTicket(input, { shopId: SHOP, now: new Date('2026-08-22T10:00:00Z') });

test('a rehearsal needs a shop and a message', () => {
  assert.throws(() => buildSyntheticTicket({ body: 'x' }, {}), /requires a shopId/);
  assert.throws(() => build({ body: '   ' }), /needs a message/);
});

test('the ticket arrives in the state ingestion leaves a new thread in', () => {
  // If these are wrong the first pass finds nothing to do, and a transcript
  // shows an empty run rather than a broken fixture.
  const { ticket } = build({ body: 'Bonjour', email: 'a@b.fr' });
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.needs_categorisation, true);
  assert.equal(ticket.needs_investigation, false);
  assert.equal(ticket.deleted_at, null);
  assert.equal(ticket.archived_at, null);
  assert.equal(ticket.category, null);
});

test('the identity is hashed the way ingestion hashes it', () => {
  // Not a detail: `customer-lookup` matches on this hash, so an address hashed
  // differently here would report every known customer as unknown.
  const { ticket, identity } = build({ body: 'x', email: '  Marie.Durand@Orange.FR ' });
  assert.equal(identity.email, 'marie.durand@orange.fr');
  assert.equal(ticket.requester_email_hash, hashIdentifier('marie.durand@orange.fr'));
  assert.equal(identity.masked, 'm***d@orange.fr');
});

test('an anonymous run carries no hash rather than a hash of nothing', () => {
  const { ticket, identity } = build({ body: 'x' });
  assert.equal(ticket.requester_email_hash, null);
  assert.equal(identity.masked, null);
});

test('an order number goes into the body, never straight onto the ticket', () => {
  // The rule this file exists to state. On a real email the number is in the
  // text and `shopifyOrderCandidates` has to find it; stamping the column would
  // skip the pass the run is meant to be testing.
  const { ticket, message, bodyText, firstInbound } = build({
    body: 'Ma commande est en retard.',
    orderNumber: '#1006'
  });
  assert.equal(ticket.shopify_order_number, null);
  assert.match(message.body_text, /#1006/);
  assert.equal(bodyText, `Ma commande est en retard.\n\n${ORDER_LINE('#1006')}`);
  // The order resolver reads the view, not the message table.
  assert.equal(firstInbound.body_text, bodyText);
});

test('no order number leaves the body exactly as typed', () => {
  const { bodyText } = build({ body: 'Bonjour, une question.' });
  assert.equal(bodyText, 'Bonjour, une question.');
});

test('the message is inbound, and its attachments are known-empty', () => {
  // `[]` means fetched and empty; `null` means never fetched. A typed message
  // genuinely has none, so the photo check should read "nothing attached"
  // rather than "not asked".
  const { message } = build({ body: 'x' });
  assert.equal(message.direction, 'inbound');
  assert.deepEqual(message.attachments, []);
  assert.equal(message.has_attachments, false);
  assert.equal(message.embedding, null);
});

test('nothing links it to another thread, and nothing marks it as ours', () => {
  // All three would silently stop the run short of a draft.
  const { ticket } = build({ body: 'x' });
  assert.equal(ticket.duplicate_of_ticket_id, null);
  assert.equal(ticket.related_ticket_id, null);
  assert.equal(ticket.sender_label, null);
});

test('the ticket and its message agree on which thread they are', () => {
  const { ticket, message, firstInbound } = build({ body: 'x' });
  assert.equal(message.ticket_id, ticket.id);
  assert.equal(firstInbound.ticket_id, ticket.id);
  assert.equal(message.shop_id, SHOP);
});
