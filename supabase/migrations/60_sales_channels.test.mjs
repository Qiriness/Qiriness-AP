import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('60_sales_channels');
const CODE = codeOnly(SQL);
const SHOPIFY = read('02_shopify');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('60 creates the same table the baseline does, column for column', () => {
  assert.ok(columnsIn(SHOPIFY, 'sales_channels').length > 0);
  assert.deepEqual(columnsIn(SQL, 'sales_channels'), columnsIn(SHOPIFY, 'sales_channels'));
  const name = 'sales_channels_key_shape_check';
  assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SHOPIFY, name)));
  for (const sql of [SQL, SHOPIFY]) {
    assert.match(sql, /sales_channels_shop_key_unique\s+on public\.sales_channels \(shop_id, platform_key\);/);
    assert.match(sql, /alter table public\.sales_channels enable row level security;/);
  }
});

test('the reserved platform ids cannot be marketplace keys', () => {
  assert.match(checkClause(SQL, 'sales_channels_key_shape_check'), /not in \('all', 'shopify'\)/);
});

test('the chat VIP rule reads the handles from the table, with no shop’s literal', () => {
  const start = CODE.indexOf('create or replace function chat.vip_customer_rows()');
  const body = CODE.slice(start, CODE.indexOf('$$;', start));
  assert.match(body, /from public\.sales_channels c cross join lateral unnest\(c\.handles\) h where c\.shop_id = s\.id/);
  assert.doesNotMatch(body, /array\[/);
  assert.match(body, /\nsecurity definer\n/);
  assert.match(body, /\nset search_path = public, pg_temp\n/);
  assert.match(CODE, /grant execute on function chat\.vip_customer_rows\(\) to mgmt_chat_ro;/);
});

test('no comment the chat model reads names a marketplace, and no data is written', () => {
  assert.doesNotMatch(CODE, /Amazon|Yves Rocher|connect-dev-1/);
  assert.doesNotMatch(CODE, /^\s*(insert|update|delete)\s/im);
  assert.match(CODE, /create table if not exists public\.sales_channels/);
});
