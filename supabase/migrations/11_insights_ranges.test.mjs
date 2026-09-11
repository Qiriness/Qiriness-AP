import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { codeOnly, functionsIn, read } from './_shared.test.mjs';

const SQL = read('11_insights_ranges');
const ANALYTICS = read('06_analytics');
const FOUNDATION = read('01_foundation');

const ranged = (sql) => functionsIn(sql).filter((name) => name.startsWith('insights_'));

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('every ranged function in the baseline is brought forward by 11', () => {
  assert.deepEqual(ranged(SQL).sort(), ranged(ANALYTICS).sort());
  assert.ok(ranged(SQL).length > 0);
});

test('11 copies each function from 06 rather than retyping it', () => {
  // The forward step is the definition, not a second version of it -- the rule
  // DECISIONS.md § Migrations set on the first departure. Byte-for-byte, so a
  // fix made in one file and not the other fails here.
  for (const name of ranged(ANALYTICS)) {
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), `${name} differs between 06 and 11`);
  }
});

test('every ranged function is named in the schema contract', () => {
  const contracted = new Set(Object.values(RPC));
  for (const name of ranged(ANALYTICS)) {
    assert.ok(contracted.has(name), `${name} is created but RPC does not name it`);
  }
});

test('every ranged function is revoked from the anon roles and granted to the service role', () => {
  for (const name of ranged(ANALYTICS)) {
    assert.match(ANALYTICS, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(ANALYTICS, new RegExp(`grant execute on function public\\.${name} to service_role`));
    assert.match(ANALYTICS, new RegExp(`comment on function public\\.${name} is`), `${name} has no comment`);
  }
});

test('every ranged function pins its search_path', () => {
  for (const name of ranged(ANALYTICS)) {
    assert.match(statementOf(ANALYTICS, name), /set search_path = public/, `${name} does not pin search_path`);
  }
});

test('every ranged read takes the range as wall-clock timestamps plus a timezone', () => {
  // The convention the TypeScript side is written against: timestamps WITHOUT a
  // zone, converted here, so a DST day is 23 or 25 hours without the caller
  // knowing. A `timestamptz` parameter would silently move the day boundary.
  for (const name of ranged(ANALYTICS).filter((n) => n !== 'insights_freshness')) {
    const statement = statementOf(ANALYTICS, name);
    assert.match(statement, /p_from timestamp,/, `${name}: p_from`);
    assert.match(statement, /p_to timestamp,/, `${name}: p_to`);
    assert.match(statement, /p_tz text/, `${name}: p_tz`);
    assert.doesNotMatch(statement, /p_(from|to) timestamptz/, `${name} takes an instant`);
  }
});

test('series bucket in the shop timezone, never in the database one', () => {
  for (const name of ranged(ANALYTICS).filter((n) => n.endsWith('_series'))) {
    assert.match(statementOf(ANALYTICS, name), /date_trunc\(p_grain, \w+\.\w+ at time zone p_tz\)/, name);
  }
});

test('11 is idempotent', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create function/i, 'use create or replace');
  assert.doesNotMatch(code, /add column (?!if not exists)/i, 'use add column if not exists');
  assert.doesNotMatch(code, /^\s*(update|insert|delete)\s+/im, 'a forward step for new objects moves no data');
});

test('the timezone column is declared by the baseline and brought forward by 11', () => {
  assert.match(FOUNDATION, /^\s*iana_timezone text,/m);
  assert.match(SQL, /add column if not exists iana_timezone text/);
});
