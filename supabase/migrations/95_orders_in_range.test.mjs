import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('95_orders_in_range'));
const HELPER = CODE.slice(CODE.indexOf('create or replace function public.orders_in_range'), CODE.indexOf('$$;') + 3);
const REWRITTEN = [
  'insights_collection_sales', 'insights_country_product_sales', 'insights_orders_by_country',
  'insights_orders_per_customer', 'insights_product_customer_mix', 'insights_product_orders_per_customer',
  'insights_product_pairs', 'insights_product_sales', 'insights_promotions', 'insights_sales_overview'
];
const body = (name) => {
  const start = CODE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is redefined`);
  return CODE.slice(start, CODE.indexOf('$function$;', start));
};

test('the helper holds all seven conditions, once', () => {
  for (const condition of [
    /o\.shop_id = p_shop/, /o\.deleted_at is null/, /o\.cancelled_at is null/,
    /o\.processed_at >= \(p_from at time zone p_tz\)/, /o\.processed_at < \(p_to at time zone p_tz\)/,
    /\(p_channels is null or o\.sales_channel_handle = any\(p_channels\)\)/,
    /p_not_channels is null\s+or o\.sales_channel_handle is null\s+or not \(o\.sales_channel_handle = any\(p_not_channels\)\)/
  ]) assert.match(HELPER, condition);
});

test('the helper stays inlinable: sql, stable, one select, no SET, not security definer', () => {
  assert.match(HELPER, /returns setof public\.orders\s+language sql\s+stable\s+as \$\$/);
  assert.doesNotMatch(HELPER, /security definer|set search_path/i);
  assert.equal((HELPER.match(/\bselect\b/gi) || []).length, 1);
});

test('exactly the ten functions are rewritten, each through the helper and without the conditions', () => {
  const redefined = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(redefined, [...REWRITTEN].sort());
  for (const name of REWRITTEN) {
    const fn = body(name);
    assert.match(fn, /from public\.orders_in_range\(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels\) o/, name);
    assert.doesNotMatch(fn, /\bpublic\.orders\s+o\b/, name);
    assert.doesNotMatch(fn, /o\.processed_at >= \(p_from at time zone p_tz\)/, name);
    assert.doesNotMatch(fn, /o\.cancelled_at is null/, name);
  }
});

test('only service_role may call the helper', () => {
  assert.match(CODE, /revoke all on function public\.orders_in_range\([^)]*\) from public, anon, authenticated;/);
  assert.match(CODE, /grant execute on function public\.orders_in_range\([^)]*\) to service_role;/);
});
