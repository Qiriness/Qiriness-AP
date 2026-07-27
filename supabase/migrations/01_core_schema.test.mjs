import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./01_core_schema.sql', import.meta.url), 'utf8');

/** The body of one `create table public.X ( ... );` block. */
function tableBody(sql, name) {
  return sql.match(new RegExp(`create table public\\.${name} \\(([\\s\\S]*?)\\n\\);`, 'i'))?.[1] || '';
}

// ---------------------------------------------------------------------------
// Baseline properties
//
// These three files describe a schema, not a history. The tests below are what
// keep that true: a data statement or a corrective ALTER creeping back in would
// mean the file no longer says what a fresh database gets.
// ---------------------------------------------------------------------------

test('the baseline creates schema, never migrates data', () => {
  // A fresh database has no rows to rename or backfill. The one-off data
  // statements from the historical migrations were dropped on purpose; an
  // update/insert here would either be a no-op or a surprise.
  for (const line of statements(migration)) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('the baseline states the final shape, with no corrective re-work', () => {
  // Historically a corrective migration had to drop and re-add a constraint an
  // earlier one got wrong. In a baseline that correction IS the definition, so
  // nothing should be dropped or re-typed on the way through.
  const sql = statements(migration).join('\n');
  assert.doesNotMatch(sql, /drop constraint/i);
  assert.doesNotMatch(sql, /alter column \w+ type/i);
});

test('every table it creates has RLS enabled', () => {
  // Enabled with no policies: the service-role worker bypasses RLS and every
  // other role is denied by default. A table added without this line would be
  // reachable by the anon key.
  for (const name of createdTables(migration)) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${name} enable row level security`, 'i'),
      `${name} is missing RLS`
    );
  }
});

test('every table carrying updated_at maintains it with the shared trigger', () => {
  for (const name of createdTables(migration)) {
    if (!/updated_at timestamptz/i.test(tableBody(migration, name))) continue;
    assert.match(
      migration,
      new RegExp(`create trigger ${name}_set_updated_at\\s+before update on public\\.${name}`, 'i'),
      `${name} has updated_at but no trigger to maintain it`
    );
  }
});

// ---------------------------------------------------------------------------
// Shopify snapshots
// ---------------------------------------------------------------------------

test('orders are keyed to Shopify identity', () => {
  assert.match(migration, /create table public\.orders/i);
  assert.match(migration, /shopify_order_id text not null/i);
  assert.match(migration, /constraint orders_shopify_order_unique unique \(shop_id, shopify_order_id\)/i);
});

test('orders keep customer-adjacent fields lean', () => {
  assert.match(migration, /customer_email_hash text/i);
  assert.match(migration, /customer_phone_hash text/i);
  assert.match(migration, /shipping_destination jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /returns jsonb not null default '\[\]'::jsonb/i);
  // Street address and postcode are deliberately never stored.
  assert.doesNotMatch(migration, /shipping_address_line/i);
  assert.doesNotMatch(migration, /billing_address_line/i);
});

test('orders store the merchant-facing sales channel separately from the raw source name', () => {
  assert.match(migration, /source_name text/i);
  assert.match(migration, /sales_channel text/i);
  assert.match(migration, /sales_channel_handle text/i);
  assert.match(migration, /create index orders_sales_channel_idx/i);
  assert.match(migration, /create index orders_sales_channel_handle_idx/i);
});

test('orders carry a dashboard-facing status and the retention anchors', () => {
  assert.match(migration, /constraint orders_order_status_check check/i);
  assert.match(migration, /'return_refund_in_progress'/i);
  assert.match(migration, /'delivered'/i);
  for (const col of [
    'delivered_at',
    'return_refund_opened_at',
    'return_refund_completed_at',
    'retention_delete_after'
  ]) {
    assert.match(migration, new RegExp(`${col} timestamptz`, 'i'), col);
  }
  for (const rule of [
    'delivered_plus_3_months',
    'undelivered_plus_6_months',
    'return_refund_completed_plus_3_months',
    'return_refund_open_plus_6_months'
  ]) {
    assert.match(migration, new RegExp(`'${rule}'`), rule);
  }
  assert.match(migration, /create index orders_retention_delete_after_idx/i);
});

test('promotions are keyed per shop and hold no customer personal data', () => {
  assert.match(migration, /constraint promotions_promotion_key_unique unique \(shop_id, promotion_key\)/i);
  assert.match(migration, /applies_once_per_customer boolean/i);
  assert.match(migration, /create index promotions_shop_applies_once_idx/i);
  const body = tableBody(migration, 'promotions');
  assert.doesNotMatch(body, /^\s*customer_id\s+\w+/im);
  assert.doesNotMatch(body, /^\s*email\s+\w+/im);
  assert.doesNotMatch(body, /^\s*phone\s+\w+/im);
});

// ---------------------------------------------------------------------------
// Knowledge library
// ---------------------------------------------------------------------------

test('the content catalog indexes identity only, never page bodies', () => {
  assert.match(
    migration,
    /constraint shopify_content_sources_shop_source_unique unique \(shop_id, source_type, shopify_source_id\)/i
  );
  assert.match(
    migration,
    /constraint shopify_content_sources_source_type_check check \(source_type in \('shopify_page', 'shopify_policy'\)\)/i
  );
  const body = tableBody(migration, 'shopify_content_sources');
  assert.doesNotMatch(body, /^\s*body\s+\w+/im);
  assert.doesNotMatch(body, /^\s*content\s+\w+/im);
  assert.doesNotMatch(body, /^\s*sections\s+\w+/im);
});

test('the manual-edit lock is a source_type transition, not a flag', () => {
  // Editing an imported article sets source_type = 'manual', which is what stops
  // it resyncing. A boolean would be a second source of truth.
  assert.doesNotMatch(migration, /is_locally_modified/i);
});

test('approval_status covers the four agent workflow states', () => {
  assert.match(
    migration,
    /approval_status in \(\s*'draft', 'in_review', 'approved', 'needs_optimization'\s*\)/i
  );
});

test('core_topic is the six combined slots, not the older seven', () => {
  const constraint = migration.match(
    /constraint knowledge_documents_core_topic_check check \(([\s\S]*?)\n {2}\)/i
  )?.[1];
  assert.ok(constraint, 'expected a core_topic check constraint');
  for (const topic of [
    'order_policies',
    'brand',
    'confidentiality',
    'delivery_returns',
    'locations',
    'faqs'
  ]) {
    assert.ok(constraint.includes(`'${topic}'`), `core_topic is missing '${topic}'`);
  }
  // The older split values, before delivery and returns were combined. The app's
  // CoreTopic type only ever sends 'delivery_returns', so their return would
  // break saving an article into that slot.
  assert.doesNotMatch(constraint, /'returns_exchanges'/);
  assert.doesNotMatch(constraint, /'delivery'\s*,/);
});

test('one active article per core-topic slot per shop', () => {
  assert.match(
    migration,
    /create unique index knowledge_documents_shop_core_topic_unique\s+on public\.knowledge_documents \(shop_id, core_topic\)\s+where core_topic is not null/i
  );
});

test('the brand-voice column is structured, defaulted and documented', () => {
  assert.match(migration, /voice_profile jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /comment on column public\.knowledge_documents\.voice_profile is/i);
  assert.match(migration, /roleDescription: string, toneAndVoice: string/i);
});

test('chunk vectors are sized and carry their determinism metadata', () => {
  const body = tableBody(migration, 'knowledge_chunks');
  assert.match(body, /embedding vector\(1536\)/i);
  for (const col of ['embedding_model', 'embedding_dimensions', 'embedded_input_hash', 'embedded_at']) {
    assert.match(body, new RegExp(col, 'i'), col);
  }
  assert.match(migration, /embedding_dimensions is null or embedding_dimensions = 1536/i);
  assert.match(
    migration,
    /create index knowledge_chunks_embedding_hnsw_idx\s+on public\.knowledge_chunks\s+using hnsw \(embedding vector_cosine_ops\)/i
  );
});

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

test('the compliance metadata tables exist with idempotency keys', () => {
  assert.match(migration, /create table public\.privacy_requests/i);
  assert.match(migration, /create table public\.integration_events/i);
  assert.match(migration, /create table public\.data_access_events/i);
  assert.match(migration, /constraint integration_events_event_key_unique unique \(event_key\)/i);
  assert.match(migration, /constraint privacy_requests_request_key_unique unique \(request_key\)/i);
  assert.match(migration, /create index privacy_requests_status_idx/i);
  assert.match(migration, /create index data_access_events_resource_idx/i);
});

// ---------------------------------------------------------------------------
// Ticketing
// ---------------------------------------------------------------------------

test('a ticket is a conversation: one per Graph conversationId per shop', () => {
  assert.match(migration, /create table public\.tickets/i);
  assert.match(migration, /create table public\.ticket_messages/i);
  assert.match(migration, /graph_conversation_id text not null/i);
  assert.match(
    migration,
    /constraint tickets_shop_conversation_unique unique \(shop_id, graph_conversation_id\)/i
  );
});

test('messages ingest idempotently on shop_id + graph_message_id', () => {
  assert.match(migration, /graph_message_id text not null/i);
  assert.match(
    migration,
    /constraint ticket_messages_shop_message_unique unique \(shop_id, graph_message_id\)/i
  );
});

test('message direction is restricted to inbound/outbound', () => {
  assert.match(
    migration,
    /constraint ticket_messages_direction_check check \(\s*direction in \('inbound', 'outbound'\)\s*\)/i
  );
});

test('ticket level and priority are bounded', () => {
  assert.match(
    migration,
    /constraint tickets_level_check check \(level is null or level between 1 and 4\)/i
  );
  assert.match(migration, /priority smallint not null default 3/i);
  assert.match(migration, /constraint tickets_priority_check check \(priority between 1 and 5\)/i);
});

test('responsible_team is the four teams plus contact', () => {
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
    assert.match(migration, new RegExp(`'${status}'`), status);
  }
});

test('the ticket row minimises personal data; raw addresses live on messages', () => {
  const tickets = tableBody(migration, 'tickets');
  assert.match(tickets, /requester_email_hash text/i);
  // The raw requester email must not live on the ticket row — it belongs on
  // ticket_messages, where it is required to send the reply.
  assert.doesNotMatch(tickets, /^\s*requester_email\s+text/im);

  const messages = tableBody(migration, 'ticket_messages');
  assert.match(messages, /from_email text/i);
  assert.match(messages, /to_emails text\[\] not null default '\{\}'/i);
});

test('the order-context bundle stays a bundle, not columns on the ticket', () => {
  assert.match(migration, /resolved_context jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /context_resolved_at timestamptz/i);
  assert.match(migration, /constraint tickets_resolved_context_object_check/i);
  // The individual resolved fields must not become first-class ticket columns.
  const tickets = tableBody(migration, 'tickets');
  for (const col of ['tracking_number', 'billing_address', 'order_name', 'rfm_group']) {
    assert.doesNotMatch(tickets, new RegExp(`^\\s*${col}\\s+\\w+`, 'im'), col);
  }
});

test('the archival and retention lifecycle is present and indexed', () => {
  for (const col of ['resolved_at', 'closed_at', 'archived_at', 'retention_delete_after']) {
    assert.match(migration, new RegExp(`${col} timestamptz`, 'i'), col);
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

test('message bodies embed on the knowledge_chunks vector pattern', () => {
  const body = tableBody(migration, 'ticket_messages');
  assert.match(body, /embedding vector\(1536\)/i);
  for (const col of ['embedding_model', 'embedding_dimensions', 'embedded_input_hash', 'embedded_at']) {
    assert.match(body, new RegExp(col, 'i'), col);
  }
  assert.match(
    migration,
    /create index ticket_messages_embedding_hnsw_idx on public\.ticket_messages using hnsw \(embedding vector_cosine_ops\)/i
  );
});

test('tickets link to shops and customers with the established FK behaviour', () => {
  assert.match(migration, /shop_id uuid not null references public\.shops\(id\) on delete cascade/i);
  assert.match(migration, /customer_id uuid references public\.customers\(id\) on delete set null/i);
  assert.match(migration, /ticket_id uuid not null references public\.tickets\(id\) on delete cascade/i);
});

test('the taxonomy columns are created here but left to 03 to define', () => {
  // 03 owns their vocabulary, constraints and comments. If this file started
  // constraining them the two would drift.
  const tickets = tableBody(migration, 'tickets');
  assert.match(tickets, /^\s*category text/im);
  assert.match(tickets, /^\s*secondary_category text/im);
  assert.doesNotMatch(migration, /constraint tickets_category_check/i);
  assert.doesNotMatch(migration, /constraint knowledge_documents_category_check/i);
  // The kind axis is 03's entirely — not even declared here. (Checked as a
  // column declaration: the table comment names the field in prose, which is
  // documentation of what the categoriser fills, not a column.)
  assert.doesNotMatch(tickets, /^\s*request_kind\s/im);
  assert.doesNotMatch(tickets, /^\s*needs_categorisation\s/im);
  assert.doesNotMatch(tickets, /^\s*happiness\s/im);
});

/** Lines that reach the database, without the `--` rationale around them. */
function statements(sql) {
  return sql.split('\n').filter((line) => !line.trim().startsWith('--'));
}

function createdTables(sql) {
  return [...sql.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]);
}
