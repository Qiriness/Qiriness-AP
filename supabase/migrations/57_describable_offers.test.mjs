import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('57_describable_offers');
const SHOPIFY = read('02_shopify');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql) =>
  sql.match(/comment on column public\.promotions\.describable_in_replies is\s*'((?:[^']|'')*)';/)?.[1];

test('the baseline declares the column 57 adds, with the same default', () => {
  assert.ok(columnsIn(SHOPIFY, 'promotions').includes('describable_in_replies'));
  assert.match(SHOPIFY, /describable_in_replies boolean not null default true,/);
  assert.match(SQL, /add column if not exists describable_in_replies boolean not null default true;/);
});

test('the column comment matches the baseline word for word', () => {
  assert.ok(commentOf(SQL), 'no comment in 57');
  assert.equal(squash(commentOf(SQL)), squash(commentOf(SHOPIFY)));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
