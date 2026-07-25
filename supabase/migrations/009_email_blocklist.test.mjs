import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./009_email_blocklist.sql', import.meta.url), 'utf8');

test('creates the email_blocklist table scoped to a shop', () => {
  assert.match(migration, /create table public\.email_blocklist/i);
  assert.match(
    migration,
    /shop_id uuid not null references public\.shops\(id\) on delete cascade/i
  );
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
  const table = migration.match(/create table public\.email_blocklist \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.match(table, /hit_count integer not null default 0/i);
  assert.match(table, /last_hit_at timestamptz/i);
  assert.match(migration, /constraint email_blocklist_hit_count_check check \(hit_count >= 0\)/i);
});

test('enables the lookup index, RLS, and updated_at trigger', () => {
  assert.match(
    migration,
    /create index email_blocklist_shop_pattern_idx on public\.email_blocklist \(shop_id, pattern_type, pattern\)/i
  );
  assert.match(migration, /alter table public\.email_blocklist enable row level security/i);
  assert.match(
    migration,
    /create trigger email_blocklist_set_updated_at\s+before update on public\.email_blocklist/i
  );
});
