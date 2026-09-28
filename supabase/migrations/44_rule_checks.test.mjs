import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('44_rule_checks');
const EXEMPLARS = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql) =>
  sql.match(/comment on column public\.support_answers\.checks is\s*'((?:[^']|'')*)';/)?.[1];

test('the baseline declares the column 44 adds', () => {
  assert.ok(columnsIn(EXEMPLARS, 'support_answers').includes('checks'));
  assert.match(SQL, /add column if not exists checks jsonb not null default '\[\]'::jsonb/);
});

test('44 carries the baseline check and comment, not retyped ones', () => {
  const clause = checkClause(SQL, 'support_answers_checks_array_check');
  assert.ok(clause);
  assert.equal(squash(clause), squash(checkClause(EXEMPLARS, 'support_answers_checks_array_check')));
  assert.ok(commentOf(SQL));
  assert.equal(commentOf(SQL), commentOf(EXEMPLARS));
});

test('44 is safe to re-apply and changes no data', () => {
  assert.match(SQL, /drop constraint if exists support_answers_checks_array_check/);
  assert.doesNotMatch(codeOnly(SQL), /^\s*(update|insert|delete)\s+/im);
});
