import assert from 'node:assert/strict';
import test from 'node:test';

import { CAMPAIGN_RPC, CAMPAIGN_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('71_ad_campaigns'));

function statementOf(name) {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  return CODE.slice(start, CODE.indexOf('\n$$;', start) + 4);
}

test('71 creates exactly the campaign tables and read, named as tables.mjs names them', () => {
  assert.deepEqual([...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]), Object.values(CAMPAIGN_T));
  assert.deepEqual([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]), Object.values(CAMPAIGN_RPC));
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(CAMPAIGN_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`), table);
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`), table);
  }
});

test('the read is security invoker, service role only, skips disabled accounts, and takes wall-clock timestamps', () => {
  const statement = statementOf(CAMPAIGN_RPC.CAMPAIGNS);
  assert.match(statement, /security invoker/);
  assert.match(statement, /a\.enabled/);
  assert.doesNotMatch(statement.slice(0, statement.indexOf(')\nreturns')), /timestamptz/);
  assert.match(CODE, /revoke all on function public\.insights_paid_campaigns\([^)]*\) from public, anon, authenticated;/);
  assert.match(CODE, /grant execute on function public\.insights_paid_campaigns\([^)]*\) to service_role;/);
});

test('no rate is stored, and no data is written', () => {
  for (const column of ['ctr', 'cpc', 'cpa', 'roas']) assert.doesNotMatch(CODE, new RegExp(`\\b${column}\\b`), column);
  const outside = CODE.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
  assert.doesNotMatch(outside, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
