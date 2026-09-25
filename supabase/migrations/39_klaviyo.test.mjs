import assert from 'node:assert/strict';
import test from 'node:test';

import { KLAVIYO_RPC, KLAVIYO_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('39_klaviyo');
const CODE = codeOnly(SQL);

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(name) {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  return CODE.slice(start, CODE.indexOf('\n$$;', start) + 4);
}

test('39 creates exactly the Klaviyo tables and functions, named as tables.mjs names them', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, Object.values(KLAVIYO_T));
  const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(functions, Object.values(KLAVIYO_RPC));
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(KLAVIYO_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`));
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`));
  }
});

test('the key is never a column: the connection stores a Vault id and a hint', () => {
  const connection = CODE.slice(CODE.indexOf('create table if not exists public.klaviyo_connections'));
  const columns = connection.slice(0, connection.indexOf(');'));
  assert.match(columns, /secret_id uuid not null/);
  assert.match(columns, /key_hint text not null/);
  assert.doesNotMatch(columns, /\b(api_key|private_key|secret|key)\s+text\b/);
  assert.match(columns, /char_length\(key_hint\) <= 8/);
});

test('the key functions are security definer, pinned, and callable by the service role only', () => {
  for (const name of [KLAVIYO_RPC.SAVE_KEY, KLAVIYO_RPC.READ_KEY, KLAVIYO_RPC.CLEAR_KEY]) {
    const statement = statementOf(name);
    assert.ok(statement, name);
    assert.match(statement, /security definer/, name);
    assert.match(statement, /set search_path = ''/, name);
    assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(CODE, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
  }
});

test('the read is security invoker and stores no rate', () => {
  assert.match(statementOf(KLAVIYO_RPC.MESSAGES), /security invoker/);
  for (const column of ['click_rate', 'conversion_rate', 'open_rate', 'revenue_per_recipient']) {
    assert.doesNotMatch(CODE, new RegExp(`\\b${column}\\b`), column);
  }
});

test('the read takes the Insights range convention: wall clock, half-open, in p_tz', () => {
  const statement = statementOf(KLAVIYO_RPC.MESSAGES);
  assert.match(statement, /p_from timestamp,\s+p_to timestamp,\s+p_tz text/);
  assert.match(statement, /c\.send_time >= \(p_from at time zone p_tz\)/);
  assert.match(statement, /c\.send_time < \(p_to at time zone p_tz\)/);
});

test('it writes no data', () => {
  // The key functions write when CALLED; the migration itself inserts nothing.
  const outside = CODE.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
  assert.doesNotMatch(outside, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
