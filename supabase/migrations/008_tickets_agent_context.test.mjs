import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./008_tickets_agent_context.sql', import.meta.url), 'utf8');

test('adds a re-resolvable order-context bundle distinct from metadata', () => {
  assert.match(migration, /add column resolved_context jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /add column context_resolved_at timestamptz/i);
  assert.match(migration, /add constraint tickets_resolved_context_object_check/i);
});

test('does not re-introduce duplicated first-class order columns on the ticket row', () => {
  // The bundle is assembled from orders/customers into resolved_context; the
  // individual fields must not become columns on tickets.
  assert.doesNotMatch(migration, /add column tracking_number\b/i);
  assert.doesNotMatch(migration, /add column billing_address\b/i);
  assert.doesNotMatch(migration, /add column order_name\b/i);
  assert.doesNotMatch(migration, /add column rfm_group\b/i);
});

test('adds a secondary category for multi-topic emails, with an index', () => {
  assert.match(migration, /add column secondary_category text/i);
  assert.match(
    migration,
    /create index tickets_shop_secondary_category_idx on public\.tickets \(shop_id, secondary_category\)/i
  );
});

test('adds a bounded queue priority', () => {
  assert.match(migration, /add column priority smallint not null default 3/i);
  assert.match(migration, /add constraint tickets_priority_check check \(priority between 1 and 5\)/i);
});

test('adds the archival + retention lifecycle mechanism', () => {
  for (const col of ['resolved_at', 'closed_at', 'archived_at', 'retention_delete_after']) {
    assert.match(migration, new RegExp(`add column ${col} timestamptz`, 'i'));
  }
  assert.match(
    migration,
    /create index tickets_shop_archived_at_idx on public\.tickets \(shop_id, archived_at\)/i
  );
  assert.match(
    migration,
    /create index tickets_retention_delete_after_idx on public\.tickets \(shop_id, retention_delete_after\)/i
  );
});

test('embeds the email body on ticket_messages using the knowledge_chunks vector pattern', () => {
  assert.match(migration, /add column embedding vector\(1536\)/i);
  for (const col of ['embedding_model', 'embedding_dimensions', 'embedded_input_hash', 'embedded_at']) {
    assert.match(migration, new RegExp(`add column ${col}`, 'i'));
  }
  assert.match(
    migration,
    /create index ticket_messages_embedding_hnsw_idx on public\.ticket_messages using hnsw \(embedding vector_cosine_ops\)/i
  );
});
