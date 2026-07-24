import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./007_tickets.sql', import.meta.url), 'utf8');

test('tickets migration creates the tickets and ticket_messages tables', () => {
  assert.match(migration, /create table public\.tickets/i);
  assert.match(migration, /create table public\.ticket_messages/i);
});

test('tickets are keyed to a Graph conversation, one ticket per conversation per shop', () => {
  assert.match(migration, /graph_conversation_id text not null/i);
  assert.match(
    migration,
    /constraint tickets_shop_conversation_unique unique \(shop_id, graph_conversation_id\)/i
  );
});

test('ticket_messages ingest idempotently on shop_id + graph_message_id', () => {
  assert.match(migration, /graph_message_id text not null/i);
  assert.match(
    migration,
    /constraint ticket_messages_shop_message_unique unique \(shop_id, graph_message_id\)/i
  );
});

test('ticket_messages direction is restricted to inbound/outbound', () => {
  assert.match(
    migration,
    /constraint ticket_messages_direction_check check \(\s*direction in \('inbound', 'outbound'\)\s*\)/i
  );
});

test('ticket level is constrained to the 1-4 handling levels from the brief', () => {
  assert.match(
    migration,
    /constraint tickets_level_check check \(level is null or level between 1 and 4\)/i
  );
});

test('responsible_team is restricted to the four teams plus contact', () => {
  assert.match(
    migration,
    /responsible_team in \('finance', 'marketing', 'sales', 'logistics', 'contact'\)/i
  );
});

test('ticket status covers the draft-only lifecycle including spam', () => {
  for (const status of [
    'open',
    'awaiting_customer',
    'awaiting_human',
    'forwarded',
    'resolved',
    'closed',
    'spam'
  ]) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
});

test('the ticket row minimises personal data: hashed requester email, no raw email column', () => {
  const ticketsTable =
    migration.match(/create table public\.tickets \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.match(ticketsTable, /requester_email_hash text/i);
  // Raw requester email must not live on the ticket row — it belongs on
  // ticket_messages, where it is required to send the reply.
  assert.doesNotMatch(ticketsTable, /^\s*requester_email\s+text/im);
});

test('raw reply addresses live on ticket_messages', () => {
  const messagesTable =
    migration.match(/create table public\.ticket_messages \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.match(messagesTable, /from_email text/i);
  assert.match(messagesTable, /to_emails text\[\] not null default '\{\}'/i);
});

test('tickets link to shops and customers with the established FK behaviour', () => {
  assert.match(
    migration,
    /shop_id uuid not null references public\.shops\(id\) on delete cascade/i
  );
  assert.match(
    migration,
    /customer_id uuid references public\.customers\(id\) on delete set null/i
  );
  assert.match(
    migration,
    /ticket_id uuid not null references public\.tickets\(id\) on delete cascade/i
  );
});

test('tickets migration enables lookup indexes and RLS on both tables', () => {
  assert.match(migration, /create index tickets_shop_status_idx on public\.tickets \(shop_id, status\)/i);
  assert.match(
    migration,
    /create index tickets_shop_requester_email_hash_idx on public\.tickets \(shop_id, requester_email_hash\)/i
  );
  assert.match(migration, /create index ticket_messages_ticket_id_idx on public\.ticket_messages \(ticket_id\)/i);
  assert.match(migration, /alter table public\.tickets enable row level security/i);
  assert.match(migration, /alter table public\.ticket_messages enable row level security/i);
});

test('both tables maintain updated_at via the shared trigger', () => {
  assert.match(migration, /create trigger tickets_set_updated_at\s+before update on public\.tickets/i);
  assert.match(
    migration,
    /create trigger ticket_messages_set_updated_at\s+before update on public\.ticket_messages/i
  );
});
