import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('28_order_discounts');
const SHOPIFY = read('02_shopify');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, column) =>
  sql.match(new RegExp(`comment on column public\\.orders\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('the baseline declares the columns 28 adds', () => {
  const orders = columnsIn(SHOPIFY, 'orders');
  assert.ok(orders.includes('discount_applications'));
  assert.ok(orders.includes('discount_codes'));
  assert.match(SQL, /add column if not exists discount_applications jsonb not null default '\[\]'::jsonb/);
  assert.match(SQL, /add column if not exists discount_codes text\[\] not null default '\{\}'/);
});

test('28 carries the baseline check, not a retyped one', () => {
  const clause = checkClause(SQL, 'orders_discount_applications_array_check');
  assert.ok(clause, 'the check is missing from 28');
  assert.equal(squash(clause), squash(checkClause(SHOPIFY, 'orders_discount_applications_array_check')));
});

test('the column comments match the baseline word for word', () => {
  for (const column of ['discount_applications', 'discount_codes']) {
    assert.ok(commentOf(SQL, column), `${column} has no comment in 28`);
    assert.equal(squash(commentOf(SQL, column)), squash(commentOf(SHOPIFY, column)), column);
  }
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

test('it is idempotent: every add is guarded and the constraint is dropped first', () => {
  const code = codeOnly(SQL);
  const adds = [...code.matchAll(/add column(?! if not exists)/g)];
  assert.equal(adds.length, 0, 'an unguarded add column would fail on a re-run');
  assert.match(code, /drop constraint if exists orders_discount_applications_array_check/);
});
