import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('26_product_order_frequency');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_product_orders_per_customer';
const MIX = 'insights_product_customer_mix';

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

test('26 carries the product order-frequency function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('26 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('it drops nothing, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /drop function/i);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it is granted like every other analytics function', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('it takes the card\'s filters, on the same signature as the split', () => {
  // The two cards' figures are read side by side, so a filter that applied to
  // one and not the other would print two answers about different people.
  const statement = statementOf(SQL, FUNCTION);
  for (const argument of [
    'p_product_id text',
    'p_country text default null',
    'p_vip_only boolean default false',
    'p_min_spend numeric default null',
    'p_min_orders integer default null',
    'p_window_months integer default null',
    'p_vip_not_channels text\\[\\] default null',
    'p_channels text\\[\\] default null',
    'p_not_channels text\\[\\] default null'
  ]) {
    assert.match(statement, new RegExp(argument), argument);
  }
});

test('the filters narrow the orders, exactly as the split narrows them', () => {
  const ranged = cteOf(codeOnly(statementOf(SQL, FUNCTION)), 'ranged_orders');
  const split = cteOf(codeOnly(statementOf(ANALYTICS, MIX)), 'ranged_orders');
  assert.ok(ranged && split, 'ranged_orders not found');
  assert.match(ranged, /p_country is null or coalesce\(o\.shipping_destination ->> 'country_code', '\?\?'\) = p_country/);
  assert.match(ranged, /o\.shopify_customer_id in \(select vk\.customer_key from vip_keys vk\)/);
  // Same predicates, whatever each selects: only the order id is extra here.
  const wheres = (cte) => cte.slice(cte.indexOf('where o.shop_id')).replace(/\s+/g, ' ');
  assert.equal(wheres(ranged), wheres(split));
});

test('VIP comes from vip_customers(), never compared here', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(
    statement,
    /public\.vip_customers\(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels\)/
  );
  assert.doesNotMatch(statement, /p_min_(spend|orders)\s*[<>]/);
});

test('a free line is not an order of the product', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  const filter = "coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0";
  assert.equal(statement.split(filter).length - 1, 1);
  assert.match(statement, /li\.value ->> 'product_id' = p_product_id/);
});

test('it counts orders carrying the product, not units of it', () => {
  // `select distinct customer_key, order_id` is the whole rule: two jars in one
  // order is one order, which is what "orders" means on the Customers panel.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /select distinct\s+ro\.customer_key,\s+ro\.order_id/);
  assert.match(statement, /select pc\.n::integer, count\(\*\)/);
});

test('the columns are its buyers, so nobody sits in a zero', () => {
  // per_customer reads product_orders, which only holds orders of the product;
  // a customer who never bought it has no row at all.
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /from product_orders po/);
  assert.doesNotMatch(statement, /left join/i);
});

test('it returns one row per order count, as the Customers chart\'s function does', () => {
  const statement = statementOf(SQL, FUNCTION);
  const reference = statementOf(ANALYTICS, 'insights_orders_per_customer');
  const shape = /returns table \(\s+order_count integer,\s+customers bigint\s+\)/;
  assert.match(statement, shape);
  assert.match(reference, shape, 'insights_orders_per_customer changed its shape');
});
