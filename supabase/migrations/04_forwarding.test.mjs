import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SUBJECTS } from '../../scripts/lib/support-taxonomy.mjs';

const migration = readFileSync(new URL('./04_forwarding.sql', import.meta.url), 'utf8');

test('the category list matches the shared taxonomy exactly', () => {
  // The same drift guard 03 uses: a check constraint cannot import a JS module,
  // so the vocabulary exists twice and this is what keeps the copies honest.
  const body = migration.match(/category in \(([\s\S]*?)\)\n {2}\)/)?.[1];
  assert.ok(body, 'category check constraint not found');

  // [a-z0-9_] not [a-z_]: `b2b` carries a digit and would otherwise be silently
  // dropped from the comparison, making the guard pass while missing a value.
  const inSql = [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inSql, [...SUBJECTS].sort());
});

test('the knowledge-only shapes are not routable', () => {
  // Nobody emails support "an FAQ", so faq/brand_story can never be a ticket
  // category and must not appear as a forwarding target.
  const body = migration.match(/category in \(([\s\S]*?)\)\n {2}\)/)?.[1];
  assert.doesNotMatch(body, /'faq'/);
  assert.doesNotMatch(body, /'brand_story'/);
});

test('it creates exactly the two tables it documents', () => {
  assert.deepEqual([...migration.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]), [
    'category_forwarding',
    'ticket_forwards'
  ]);
});

test('the baseline creates schema, never migrates data', () => {
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('one address per shop and category', () => {
  assert.match(migration, /unique \(shop_id, category\)/);
});

test('idempotency is keyed on the message, not the ticket', () => {
  // Per ticket would mean a candidate's follow-up never reaches the recipient,
  // because the first forward would "cover" the thread forever.
  assert.match(migration, /ticket_message_id uuid not null unique/);
});

test('a forward records where it went and whether it worked', () => {
  assert.match(migration, /status text not null default 'sent' check \(status in \('sent', 'failed'\)\)/);
  assert.match(migration, /forward_email text not null/);
});

test('both tables are shop-scoped, cascade with the shop, and have RLS', () => {
  for (const table of ['category_forwarding', 'ticket_forwards']) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`),
      table
    );
  }
  const cascades = [...migration.matchAll(/references public\.shops\(id\) on delete cascade/g)];
  assert.equal(cascades.length, 2);
});

test('the address book has an updated_at trigger', () => {
  assert.match(migration, /create trigger category_forwarding_set_updated_at/);
});

test('a forward row survives an address-book edit', () => {
  // ticket_forwards.category/forward_email are plain columns, deliberately not
  // FKs into category_forwarding: history must not be rewritten by re-routing.
  const forwardsTable = migration.slice(migration.indexOf('create table public.ticket_forwards'));
  assert.doesNotMatch(forwardsTable, /references public\.category_forwarding/);
});
