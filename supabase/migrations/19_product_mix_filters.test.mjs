import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('19_product_mix_filters');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_product_customer_mix';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

/** The body of one CTE, from `name as (` to the `),` that closes it. */
function cteOf(statement, name) {
  const start = statement.indexOf(`${name} as (`);
  if (start < 0) return undefined;
  return statement.slice(start, statement.indexOf('\n  ),', start));
}

test('19 carries the product customer mix function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('19 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test("18's seven-argument signature is dropped before the new one is created", () => {
  const code = codeOnly(SQL);
  const drop = code.indexOf(
    `drop function if exists public.${FUNCTION}(uuid, timestamp, timestamp, text, text, text[], text[]);`
  );
  assert.ok(drop >= 0, "18's signature is not dropped");
  assert.ok(drop < code.indexOf(`create or replace function public.${FUNCTION}(`));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('the grants are re-issued, since a dropped function loses them', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('both filters are optional, so the unfiltered card is unchanged', () => {
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /p_country text default null/);
  assert.match(statement, /p_vip_only boolean default false/);
  assert.match(codeOnly(statement), /p_country is null or /);
  assert.match(codeOnly(statement), /not coalesce\(p_vip_only, false\)/);
});

test('the filters narrow the population, so the customer total and the buckets agree', () => {
  // In ranged_orders, which every later figure reads — including `customers`.
  // A filter applied only to the buyers would divide a group by everybody.
  const ranged = cteOf(codeOnly(statementOf(SQL, FUNCTION)), 'ranged_orders');
  assert.ok(ranged, 'ranged_orders not found');
  assert.match(ranged, /p_country is null or coalesce\(o\.shipping_destination ->> 'country_code', '\?\?'\) = p_country/);
  assert.match(ranged, /o\.shopify_customer_id in \(select vk\.customer_key from vip_keys vk\)/);
  assert.match(codeOnly(statementOf(SQL, FUNCTION)), /count\(distinct ro\.customer_key\) from ranged_orders ro\) as customers/);
});

test('a country means what it means on the rest of Insights', () => {
  const expression = "coalesce(o.shipping_destination ->> 'country_code', '??')";
  assert.ok(codeOnly(statementOf(SQL, FUNCTION)).includes(expression));
  assert.ok(codeOnly(statementOf(ANALYTICS, 'orders_list_facets')).includes(expression), 'orders_list_facets changed its country rule');
});

test('VIP comes from vip_customers(), never compared here', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(
    statement,
    /public\.vip_customers\(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels\)/
  );
  assert.doesNotMatch(statement, /p_min_(spend|orders)\s*[<>]/);
  assert.doesNotMatch(statement, /spend\s*>/);
});

test('free lines, one product per call and the top-7 cut are all still in place', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  const filter = "coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0";
  assert.equal(statement.split(filter).length - 1, 1);
  assert.match(statement, /where pl\.product_id = p_product_id/);
  assert.match(statement, /r\.other_rank <= 7/);
  assert.match(
    statement,
    /greatest\(s\.customers - s\.only_customers - s\.with_other_customers, 0\)::bigint as without_customers/
  );
});
