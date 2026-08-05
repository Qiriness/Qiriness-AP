import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { VERDICTS } from '../../agent/src/investigation/case-file.mjs';

const migration = readFileSync(new URL('./07_investigation.sql', import.meta.url), 'utf8');

test('the verdict vocabulary matches the case-file module exactly', () => {
  // The same drift guard 03 and 04 use: a check constraint cannot import a JS
  // module, so the vocabulary exists twice and this keeps the copies honest.
  const body = migration.match(/verdict in \(([\s\S]*?)\)/)?.[1];
  assert.ok(body, 'verdict check constraint not found');

  const inSql = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inSql, [...VERDICTS].sort());
});

test('it creates exactly the one table it documents', () => {
  assert.deepEqual([...migration.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]), [
    'ticket_investigations'
  ]);
});

test('the baseline creates schema, never migrates data', () => {
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('idempotency is keyed on the message that triggered the run', () => {
  // Per ticket would overwrite the reading of an earlier message every time the
  // customer replied, losing the trajectory the table exists to keep.
  assert.match(migration, /unique \(shop_id, trigger_message_id\)/);
});

test('the four evidence sections are separate columns', () => {
  // One blob would make the distinction between a fact and a doubt a convention
  // rather than a schema, and that distinction is the safety property.
  for (const column of ['established', 'unverified', 'missing', 'do_not_claim']) {
    assert.match(migration, new RegExp(`${column} jsonb not null default '\\[\\]'::jsonb`), column);
    assert.match(
      migration,
      new RegExp(`ticket_investigations_${column}_array_check`),
      `${column} needs an array check`
    );
  }
});

test('the pending flag defaults to false, unlike needs_categorisation', () => {
  // A ticket with no category has no subject from which to choose tools, so it
  // must not enter this queue on insert.
  assert.match(migration, /add column needs_investigation boolean not null default false/);
});

test('the queue index is partial, matching 03 needs_categorisation', () => {
  assert.match(migration, /create index tickets_needs_investigation_idx[\s\S]*?where needs_investigation;/);
});

test('the memory seam is indexed', () => {
  // Phase 7 reads prior case files per customer; without the index that is a scan.
  assert.match(migration, /ticket_investigations_customer_idx[\s\S]*?\(customer_id, investigated_at desc\)/);
});

test('a deleted customer nulls the link rather than deleting the case file', () => {
  // A compliance delete must not destroy the record that an investigation happened.
  assert.match(migration, /customer_id uuid references public\.customers\(id\) on delete set null/);
});

test('the row is shop-scoped, cascades with the shop, and has RLS', () => {
  assert.match(migration, /shop_id uuid not null references public\.shops\(id\) on delete cascade/);
  assert.match(migration, /alter table public\.ticket_investigations enable row level security/);
});

test('no column stores the reply intent or a confidence score', () => {
  // Both are deliberate absences: the first is derived from the verdict, the
  // second was measured on this mailbox and found constant. Checked against the
  // SQL only — the header comment explains both absences by name.
  const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(sql, /reply_intent/);
  assert.doesNotMatch(sql, /confidence/);
});

test('proposed_level is bounded like every other level column', () => {
  assert.match(migration, /proposed_level between 1 and 4/);
});
