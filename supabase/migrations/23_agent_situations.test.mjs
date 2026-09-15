import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('23_agent_situations');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_agent_situations';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('23 carries the situations function and the contract names it', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
  assert.equal(RPC.INSIGHTS_AGENT_SITUATIONS, FUNCTION);
});

test('23 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('revoked from the anon roles, granted to the service role, commented, stable and pinned', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('each ticket counts once, on its latest run in the range', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /distinct on \(i\.ticket_id\)/);
  assert.match(statement, /order by i\.ticket_id, i\.created_at desc/);
});

test('a model-chosen situation is told apart from a mechanical match', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /m->>'chosen_by' = 'model'/);
  assert.match(statement, /m->'chooser'->>'choice' = 'none'/);
});
