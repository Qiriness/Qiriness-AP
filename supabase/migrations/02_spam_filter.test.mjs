import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./02_spam_filter.sql', import.meta.url), 'utf8');
const blocklist = migration.match(/create table public\.email_blocklist \(([\s\S]*?)\n\);/i)?.[1] || '';
const audit = migration.match(/create table public\.spam_audit \(([\s\S]*?)\n\);/i)?.[1] || '';

test('the baseline creates schema, never migrates data', () => {
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

// --- pass 1: the deterministic blocklist ------------------------------------

test('creates the email_blocklist table scoped to a shop', () => {
  assert.match(migration, /create table public\.email_blocklist/i);
  assert.match(blocklist, /shop_id uuid not null references public\.shops\(id\) on delete cascade/i);
});

test('restricts pattern_type to email or domain', () => {
  assert.match(
    migration,
    /constraint email_blocklist_pattern_type_check check \(pattern_type in \('email', 'domain'\)\)/i
  );
});

test('rules are unique per shop + type + pattern', () => {
  assert.match(
    migration,
    /constraint email_blocklist_shop_pattern_unique unique \(shop_id, pattern_type, pattern\)/i
  );
});

test('tracks hit stats with a non-negative counter', () => {
  assert.match(blocklist, /hit_count integer not null default 0/i);
  assert.match(blocklist, /last_hit_at timestamptz/i);
  assert.match(migration, /constraint email_blocklist_hit_count_check check \(hit_count >= 0\)/i);
});

// --- the audit trail --------------------------------------------------------

test('creates the spam_audit table scoped to a shop', () => {
  assert.match(migration, /create table public\.spam_audit/i);
  assert.match(audit, /shop_id uuid not null references public\.shops\(id\) on delete cascade/i);
});

test('records the decision, who made it, and a mandatory reason', () => {
  assert.match(audit, /outcome text not null/i);
  assert.match(audit, /decided_by text not null/i);
  // reason is NOT NULL so a row can never exist without stating why.
  assert.match(audit, /reason text not null/i);
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
  assert.match(audit, /graph_message_id text not null/i);
  assert.match(
    migration,
    /constraint spam_audit_shop_message_unique unique \(shop_id, graph_message_id\)/i
  );
});

test('keeps decision provenance: model, matched rule, and fail-open flag', () => {
  assert.match(audit, /model text/i);
  assert.match(
    audit,
    /blocklist_rule_id uuid references public\.email_blocklist\(id\) on delete set null/i
  );
  assert.match(audit, /failed_open boolean not null default false/i);
});

test('stores sender and subject for review but never the message body', () => {
  // The narrow, deliberate exception to "blocked spam is not stored": enough to
  // review a decision, not enough to be retained mail.
  assert.match(audit, /from_email text/i);
  assert.match(audit, /subject text/i);
  assert.doesNotMatch(audit, /body_text|body_preview|raw_graph_payload/i);
});

test('the blocklist is created before the audit table that references it', () => {
  // Same reason 02 runs after 01: a foreign key cannot point at a table that
  // does not exist yet.
  assert.ok(
    migration.indexOf('create table public.email_blocklist') <
      migration.indexOf('create table public.spam_audit'),
    'spam_audit references email_blocklist, so the blocklist must come first'
  );
});

test('enables the lookup/review indexes, RLS, and the updated_at triggers', () => {
  assert.match(
    migration,
    /create index email_blocklist_shop_pattern_idx on public\.email_blocklist \(shop_id, pattern_type, pattern\)/i
  );
  assert.match(
    migration,
    /create index spam_audit_shop_decided_at_idx on public\.spam_audit \(shop_id, decided_at desc\)/i
  );
  assert.match(migration, /create index spam_audit_shop_outcome_idx on public\.spam_audit/i);
  for (const table of ['email_blocklist', 'spam_audit']) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, 'i'),
      `${table} is missing RLS`
    );
    assert.match(
      migration,
      new RegExp(`create trigger ${table}_set_updated_at\\s+before update on public\\.${table}`, 'i'),
      `${table} is missing its updated_at trigger`
    );
  }
});
