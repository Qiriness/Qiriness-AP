import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('51_destination_switch');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('the baseline declares the switch 51 adds, with the same constraint', () => {
  assert.ok(columnsIn(SUPPORT, 'forwarding_destinations').includes('active_since'));
  assert.match(SQL, /alter table public\.forwarding_destinations\s+add column if not exists active_since timestamptz;/);
  const name = 'forwarding_destinations_active_needs_address_check';
  assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)));
});

test('only destinations that were on under the old rule are switched on, once', () => {
  const code = codeOnly(SQL);
  assert.match(code, /set active_since = now\(\)\s+where active_since is null and forward_email is not null;/);
  // Guarded by the constraint's existence, so a re-run writes nothing.
  assert.match(code, /if not exists \(\s*select 1 from pg_constraint where conname = 'forwarding_destinations_active_needs_address_check'/);
  const writes = code.split('\n').filter((line) => /^\s*(insert|update|delete)\s+/i.test(line));
  assert.equal(writes.length, 1);
});
