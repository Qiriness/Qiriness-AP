import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./08_spam_audit_body.sql', import.meta.url), 'utf8');
const base = readFileSync(new URL('./02_spam_filter.sql', import.meta.url), 'utf8');

test('the baseline creates schema, never migrates data', () => {
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('adds the three body columns to spam_audit', () => {
  assert.match(migration, /alter table public\.spam_audit/i);
  assert.match(migration, /add column if not exists body_text text/i);
  assert.match(migration, /add column if not exists body_captured_at timestamptz/i);
  assert.match(migration, /add column if not exists body_expires_at timestamptz/i);
});

test('is re-runnable over a database that already has the columns', () => {
  // Unlike 01-07 this one lands on a populated table in dev as well as on a
  // fresh database, so every statement is guarded.
  const statements = migration.match(/^(alter table|create index)[\s\S]*?;/gim) || [];
  assert.ok(statements.length >= 2);
  for (const statement of statements) {
    assert.match(statement, /if not exists/i, statement);
  }
});

test('indexes the purge query and only while there is a body to purge', () => {
  assert.match(
    migration,
    /create index if not exists spam_audit_body_expiry_idx\s+on public\.spam_audit \(shop_id, body_expires_at\)\s+where body_text is not null/i
  );
});

test('the body has an expiry separate from the row, which does not', () => {
  // The point of the split: the decision is audit metadata and is kept, the
  // message text is personal data and is not. A single retention column would
  // force one life on both.
  assert.doesNotMatch(base, /spam_audit[\s\S]*retention_delete_after/i);
  assert.match(migration, /body_expires_at/i);
});

test('02 no longer claims the body is never stored', () => {
  // 02 and 08 are read in order against a fresh database, so 08 must overwrite
  // the table comment 02 wrote — otherwise the schema documents the opposite of
  // what it does.
  assert.match(base, /never the body/i);
  assert.match(migration, /comment on table public\.spam_audit is/i);
  const updated = migration.match(/comment on table public\.spam_audit is\s+'([\s\S]*?)';/i)?.[1] || '';
  assert.doesNotMatch(updated, /never the body/i);
  assert.match(updated, /body/i);
});

test('every new column is documented', () => {
  for (const column of ['body_text', 'body_captured_at', 'body_expires_at']) {
    assert.match(
      migration,
      new RegExp(`comment on column public\\.spam_audit\\.${column} is`, 'i'),
      column
    );
  }
});

test('the body comment names the retention control by its env var', () => {
  // The column is only proportionate because something purges it; the comment
  // has to say what, or the next reader assumes it lives for ever.
  assert.match(migration, /SPAM_AUDIT_BODY_RETENTION_DAYS/);
});
