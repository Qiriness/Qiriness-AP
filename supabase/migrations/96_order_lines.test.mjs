import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('96_order_lines'));
const READERS = [
  'insights_collection_sales', 'insights_country_product_sales', 'insights_inventory_exceptions',
  'insights_product_customer_mix', 'insights_product_orders_per_customer', 'insights_product_pairs',
  'insights_product_sales', 'insights_promotions', 'insights_sales_overview', 'open_orders', 'orders_list'
];
const KEYS = ['product_id', 'variant_id', 'title', 'variant_title', 'sku', 'quantity', 'current_quantity', 'original_total', 'discounted_total'];
const fn = (name) => {
  const start = CODE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} is redefined`);
  return CODE.slice(start, CODE.indexOf('$function$;', start));
};

test('scalar columns are text, so each holds exactly what line_items ->> key returned', () => {
  const table = CODE.slice(CODE.indexOf('create table if not exists public.order_lines'), CODE.indexOf('primary key (order_id, line_index)'));
  for (const key of KEYS) assert.match(table, new RegExp(`\\n\\s+${key} text,`), key);
  assert.match(table, /discounts jsonb,/);
  assert.match(table, /order_id uuid not null references public\.orders\(id\) on delete cascade/);
});

test('the trigger and the backfill derive lines the same way: every element, in order, guarded', () => {
  const derive = /jsonb_array_elements\(\s*case when jsonb_typeof\((new|o)\.line_items\) = 'array' then \1\.line_items else '\[\]'::jsonb end\s*\) with ordinality as e\(value, ordinality\)/g;
  assert.equal((CODE.match(derive) || []).length, 2);
  for (const key of KEYS) assert.equal((CODE.match(new RegExp(`e\\.value ->> '${key}'`, 'g')) || []).length, 2, key);
  assert.equal((CODE.match(/e\.value -> 'discounts'/g) || []).length, 2);
});

test('the update trigger fires only when line_items changed', () => {
  assert.match(CODE, /after update of line_items on public\.orders\s+for each row\s+when \(old\.line_items is distinct from new\.line_items\)/);
  assert.match(CODE, /after insert on public\.orders\s+for each row\s+execute function public\.order_lines_refresh\(\);/);
});

test('the eleven readers join order_lines and no longer unnest line_items', () => {
  const redefined = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(redefined, [...READERS].sort());
  for (const name of READERS) {
    const body = fn(name);
    assert.match(body, /public\.order_lines li (on|where) li\.order_id = \w+\.(id|order_id)/, name);
    assert.doesNotMatch(body, /jsonb_typeof\(\w+\.line_items\)|\bli\.value\b/, name);
  }
});

test('chat.order_lines keeps its columns, now read from the table', () => {
  const view = CODE.slice(CODE.indexOf('create or replace view chat.order_lines'));
  for (const column of ['order_id', 'line_index', 'processed_at', 'channel', 'cancelled_at', 'product_title', 'variant_title', 'sku',
    'shopify_product_id', 'quantity', 'current_quantity', 'original_total', 'discounted_total']) {
    assert.match(view, new RegExp(`as ${column},?\\n`), column);
  }
  assert.match(view, /join public\.order_lines l on l\.order_id = o\.id/);
});
