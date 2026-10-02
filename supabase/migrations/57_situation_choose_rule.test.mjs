import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('57_situation_choose_rule');
const EXEMPLARS = read('05_exemplars');
const commentOf = (sql) =>
  sql.match(/comment on column public\.support_exemplars\.choose_rule is\s*'((?:[^']|'')*)';/)?.[1];

test('the baseline declares the column 57 adds, and both carry the same comment', () => {
  assert.ok(columnsIn(EXEMPLARS, 'support_exemplars').includes('choose_rule'));
  assert.match(SQL, /add column if not exists choose_rule text;/);
  assert.ok(commentOf(EXEMPLARS));
  assert.equal(commentOf(SQL), commentOf(EXEMPLARS));
});

test('57 writes no data', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
