import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./010_spam_audit.sql', import.meta.url), 'utf8');
const table = migration.match(/create table public\.spam_audit \(([\s\S]*?)\n\);/i)?.[1] || '';

test('creates the spam_audit table scoped to a shop', () => {
  assert.match(migration, /create table public\.spam_audit/i);
  assert.match(table, /shop_id uuid not null references public\.shops\(id\) on delete cascade/i);
});

test('records the decision, who made it, and a mandatory reason', () => {
  assert.match(table, /outcome text not null/i);
  assert.match(table, /decided_by text not null/i);
  // reason is NOT NULL so a row can never exist without stating why.
  assert.match(table, /reason text not null/i);
});

test('constrains outcome, decider, and label to the known values', () => {
  assert.match(
    migration,
    /constraint spam_audit_outcome_check check \(outcome in \('kept', 'blocked'\)\)/i
  );
  assert.match(
    migration,
    /constraint spam_audit_decided_by_check check \(decided_by in \('blocklist', 'llm'\)\)/i
  );
  assert.match(
    migration,
    /constraint spam_audit_label_check check \(label is null or label in \('keep', 'spam', 'irrelevant'\)\)/i
  );
});

test('is idempotent per Graph message so re-ingestion does not duplicate decisions', () => {
  assert.match(table, /graph_message_id text not null/i);
  assert.match(
    migration,
    /constraint spam_audit_shop_message_unique unique \(shop_id, graph_message_id\)/i
  );
});

test('keeps decision provenance: model, matched rule, and fail-open flag', () => {
  assert.match(table, /model text/i);
  assert.match(
    table,
    /blocklist_rule_id uuid references public\.email_blocklist\(id\) on delete set null/i
  );
  assert.match(table, /failed_open boolean not null default false/i);
});

test('stores sender and subject for review but never the message body', () => {
  assert.match(table, /from_email text/i);
  assert.match(table, /subject text/i);
  assert.doesNotMatch(table, /body_text|body_preview|raw_graph_payload/i);
});

test('enables review indexes, RLS, and the updated_at trigger', () => {
  assert.match(
    migration,
    /create index spam_audit_shop_decided_at_idx on public\.spam_audit \(shop_id, decided_at desc\)/i
  );
  assert.match(migration, /create index spam_audit_shop_outcome_idx on public\.spam_audit/i);
  assert.match(migration, /alter table public\.spam_audit enable row level security/i);
  assert.match(
    migration,
    /create trigger spam_audit_set_updated_at\s+before update on public\.spam_audit/i
  );
});
