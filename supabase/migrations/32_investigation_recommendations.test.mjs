import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('32_investigation_recommendations');
const SUPPORT = read('04_support');

test('the baseline declares the column, so a fresh install needs no delta', () => {
  // 01-09 state the end shape; this file exists only to carry a populated
  // database to it. The two must agree or a new install and an old one differ.
  assert.match(codeOnly(SUPPORT), /recommendations jsonb not null default '\[\]'::jsonb/);
});

test('it adds one column and nothing else', () => {
  const code = codeOnly(SQL);
  assert.match(code, /add column if not exists recommendations jsonb not null default '\[\]'::jsonb/);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /drop (column|table|constraint)/i);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

test('it is idempotent, because a populated database may already have it', () => {
  assert.match(codeOnly(SQL), /if not exists/i);
});

test('the default is empty, so every stored investigation still reads', () => {
  // A row written before this column simply has no product block — the drafting
  // projection renders nothing rather than an empty section.
  assert.match(codeOnly(SQL), /default '\[\]'::jsonb/);
});
