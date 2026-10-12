import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('92_skip_unchanged_sync_writes'));
const FRESHNESS = CODE.slice(CODE.indexOf('create or replace function public.insights_freshness'));

test('92 guards exactly the two nightly-synced tables, before update', () => {
  const triggers = [...CODE.matchAll(/create trigger (\w+)\s+before update on public\.(\w+)\s+for each row\s+execute function public\.skip_unchanged_sync_write\(([^)]*)\);/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(triggers, [
    ['customers_skip_unchanged_sync_write', 'customers', "'on_email_marketing_list'"],
    ['orders_skip_unchanged_sync_write', 'orders', '']
  ]);
});

test('the guard ignores only the sync stamps and the named columns', () => {
  // Ignoring more would drop real changes: everything else must still be compared.
  assert.match(CODE, /ignored text\[\] := array\['synced_at', 'updated_at'\] \|\| coalesce\(tg_argv::text\[\], '\{\}'\);/);
  assert.match(CODE, /if \(to_jsonb\(new\) - ignored\) = \(to_jsonb\(old\) - ignored\) then\s+return null;/);
});

test('92 is idempotent', () => {
  for (const name of ['customers_skip_unchanged_sync_write', 'orders_skip_unchanged_sync_write']) {
    assert.match(CODE, new RegExp(`drop trigger if exists ${name} on public\\.\\w+;`));
  }
  assert.match(CODE, /create or replace function public\.skip_unchanged_sync_write\(\)/);
});

test('freshness reads "synced" from the last completed nightly as well as from row changes', () => {
  // Without this, a quiet night (nothing changed, so no updated_at moved) would
  // show orders and customers as stale after 30 h.
  assert.match(FRESHNESS, /ie\.event_type = 'nightly_sync'\s+and ie\.status = 'completed'/);
  assert.equal((FRESHNESS.match(/greatest\(/g) || []).length, 2);
  assert.match(FRESHNESS, /max\(o\.updated_at\)[\s\S]*?lc\.finished_at/);
  assert.match(FRESHNESS, /max\(c\.updated_at\)[\s\S]*?lc\.finished_at/);
});

test('92 writes no data', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
