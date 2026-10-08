import assert from 'node:assert/strict';
import test from 'node:test';

import { ADVISOR_RPC, ADVISOR_T } from '../../scripts/lib/tables.mjs';
import { ADVISOR_T as CORE_T, MAP_SECTIONS, SINGLE_SECTIONS } from '../../scripts/lib/advisory/advisory-repository.mjs';
import { CHANNELS, EVENT_TYPES } from '../../scripts/lib/advisory/events.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('80_advisor');
const CODE = codeOnly(SQL);

test('80 creates exactly the advisor tables and function, named as tables.mjs names them', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, Object.values(ADVISOR_T));
  const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(functions, Object.values(ADVISOR_RPC));
});

test('the advisory core names the same tables as tables.mjs', () => {
  assert.deepEqual(CORE_T, ADVISOR_T);
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(ADVISOR_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`), table);
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`), table);
  }
});

test('the purge is pinned and callable by the service role only', () => {
  for (const name of Object.values(ADVISOR_RPC)) {
    const start = CODE.indexOf(`create or replace function public.${name}(`);
    const statement = CODE.slice(start, CODE.indexOf('\n$$;', start));
    assert.match(statement, /set search_path = ''/, name);
    assert.doesNotMatch(statement, /security definer/, name);
    assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(CODE, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
  }
});

test('mapping kinds in the check are exactly the sections the repository writes', () => {
  const check = CODE.match(/advisor_mappings_kind_check check \(kind in \(([\s\S]*?)\)\)/)[1];
  const kinds = [...check.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(kinds.sort(), [...MAP_SECTIONS, ...SINGLE_SECTIONS].sort());
});

test('event channels and types in the checks are exactly the event schema', () => {
  const channels = [...CODE.match(/advisory_events_channel_check check \(channel in \(([^)]*)\)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(channels, CHANNELS);
  const types = [...CODE.match(/advisory_events_type_check check \(event_type in \(([\s\S]*?)\)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(types, EVENT_TYPES);
});

test('every updated_at is maintained by the shared trigger', () => {
  for (const table of ['advisor_playbooks', 'advisor_mappings', 'advisor_merchandising']) {
    assert.match(CODE, new RegExp(`create trigger ${table}_set_updated_at[\\s\\S]*?on public\\.${table}`), table);
  }
});

test('events hold no customer identity and no free text column', () => {
  const events = CODE.slice(CODE.indexOf('create table if not exists public.advisory_events'), CODE.indexOf('create index if not exists advisory_events_shop_idx'));
  const columns = [...events.matchAll(/^\s+(\w+) (uuid|text|jsonb|timestamptz|integer)/gm)].map((m) => m[1]);
  assert.deepEqual(columns, ['id', 'shop_domain', 'channel', 'conversation_ref', 'event_type', 'playbook_key', 'product_ids', 'payload', 'created_at']);
});

test('nothing is written when it is applied, and no existing table is altered', () => {
  const outsideFunctions = CODE.replace(/as \$\$[\s\S]*?\$\$;/g, '');
  for (const line of outsideFunctions.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
  const altered = [...CODE.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
  for (const table of altered) assert.ok(Object.values(ADVISOR_T).includes(table), `alters ${table}`);
});
