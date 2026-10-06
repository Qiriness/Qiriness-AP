import assert from 'node:assert/strict';
import test from 'node:test';

import { STOREFRONT_CHAT_RPC, STOREFRONT_CHAT_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('76_storefront_chat');
const CODE = codeOnly(SQL);

test('76 creates exactly the storefront chat tables and functions, named as tables.mjs names them', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, Object.values(STOREFRONT_CHAT_T));
  const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(functions, Object.values(STOREFRONT_CHAT_RPC));
});

test('never touches the management chat tables', () => {
  assert.doesNotMatch(CODE, /public\.chat_/);
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(STOREFRONT_CHAT_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`), table);
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`), table);
  }
});

test('every function is pinned and callable by the service role only', () => {
  for (const name of Object.values(STOREFRONT_CHAT_RPC)) {
    const start = CODE.indexOf(`create or replace function public.${name}(`);
    const statement = CODE.slice(start, CODE.indexOf('\n$$;', start));
    assert.match(statement, /set search_path = ''/, name);
    assert.doesNotMatch(statement, /security definer/, name);
    assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(CODE, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
  }
});

test('holds no customer or order identity', () => {
  assert.doesNotMatch(CODE, /\b(customer_id|order_id|email|phone)\b/);
});

test('messages go with their session', () => {
  assert.match(CODE, /references public\.storefront_chat_sessions\(id\) on delete cascade/);
});

test('nothing is written when it is applied', () => {
  const outsideFunctions = CODE.replace(/as \$\$[\s\S]*?\$\$;/g, '');
  for (const line of outsideFunctions.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
