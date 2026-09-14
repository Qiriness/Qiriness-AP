import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('20_best_products_vip');
const ANALYTICS = read('06_analytics');
const FUNCTIONS = ['insights_product_sales', 'insights_country_product_sales'];

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('20 carries the two Best products functions and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, FUNCTIONS);
});

test('20 copies both functions from 06 rather than retyping them', () => {
  for (const name of FUNCTIONS) {
    assert.ok(statementOf(SQL, name), `${name} is missing`);
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), `${name} drifted from 06`);
  }
});

test('the old signatures are dropped before the new ones are created', () => {
  const code = codeOnly(SQL);
  for (const [name, signature] of [
    ['insights_product_sales', '(uuid, timestamp, timestamp, text, text[], text[])'],
    ['insights_country_product_sales', '(uuid, timestamp, timestamp, text, text, integer, text[], text[])']
  ]) {
    const drop = code.indexOf(`drop function if exists public.${name}${signature};`);
    assert.ok(drop >= 0, `${name}'s old signature is not dropped`);
    assert.ok(drop < code.indexOf(`create or replace function public.${name}(`));
  }
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('grants are re-issued and each function stays stable, pinned and commented', () => {
  for (const name of FUNCTIONS) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(SQL, new RegExp(`grant execute on function public\\.${name} to service_role`));
    assert.match(SQL, new RegExp(`comment on function public\\.${name} is`));
    const statement = statementOf(SQL, name);
    assert.match(statement, /set search_path = public/);
    assert.match(statement, /\nstable\n/);
    assert.match(statement, /p_tz text/);
  }
});

test('VIP only is off by default, so callers that do not ask are unchanged', () => {
  for (const name of FUNCTIONS) {
    const statement = statementOf(SQL, name);
    assert.match(statement, /p_vip_only boolean default false/);
    assert.match(codeOnly(statement), /not coalesce\(p_vip_only, false\)\s+or o\.shopify_customer_id in \(select vk\.customer_key from vip_keys vk\)/);
  }
});

test('VIP comes from vip_customers(), never compared here', () => {
  for (const name of FUNCTIONS) {
    const statement = codeOnly(statementOf(SQL, name));
    assert.match(
      statement,
      /public\.vip_customers\(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels\)/,
      name
    );
    assert.doesNotMatch(statement, /p_min_(spend|orders)\s*[<>]/, name);
  }
});

test('free lines are still not sales', () => {
  for (const name of FUNCTIONS) {
    assert.ok(
      codeOnly(statementOf(SQL, name)).includes("coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0"),
      `${name} lost its free-line filter`
    );
  }
});

test('every function that calls vip_customers() is created after it in 06', () => {
  // A SQL function's body is checked at create time, so one created above
  // vip_customers() breaks a fresh install. This failed once already, and only
  // the live baseline test noticed; this makes the ordering a unit test.
  const created = ANALYTICS.indexOf('create or replace function public.vip_customers(');
  assert.ok(created >= 0);
  const callers = [...ANALYTICS.matchAll(/create or replace function public\.(\w+)\(/g)]
    .map((m) => ({ name: m[1], at: m.index }))
    .filter(({ name, at }) => name !== 'vip_customers' && (statementOf(ANALYTICS.slice(at), name) ?? '').includes('public.vip_customers('));
  assert.ok(callers.length >= 3, `expected several callers, found ${callers.map((c) => c.name)}`);
  for (const { name, at } of callers) {
    assert.ok(at > created, `${name} calls vip_customers() but is created before it`);
  }
});
