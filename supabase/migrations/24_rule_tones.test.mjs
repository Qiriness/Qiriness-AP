import assert from 'node:assert/strict';
import test from 'node:test';

import { TONE_KEYS } from '../../scripts/lib/reply-tones.mjs';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('24_rule_tones');
const BASELINE = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql) =>
  sql.match(/comment on column public\.support_answers\.tones is\s*'((?:[^']|'')*)';/)?.[1];

test('24 adds the column exactly as the baseline declares it', () => {
  assert.match(SQL, /add column if not exists tones text\[\] not null default '\{\}'::text\[\];/);
  assert.match(BASELINE, /^\s*tones text\[\] not null default '\{\}'::text\[\],/m);
});

test('24 carries the baseline’s check, not a retyped one', () => {
  const clause = checkClause(SQL, 'support_answers_tones_check');
  assert.ok(clause, 'the constraint is missing from 24');
  assert.equal(squash(clause), squash(checkClause(BASELINE, 'support_answers_tones_check')));
  assert.deepEqual(literalsIn(clause), [...TONE_KEYS].sort());
});

test('24 carries the baseline’s column comment', () => {
  assert.ok(commentOf(SQL), 'the comment is missing from 24');
  assert.equal(commentOf(SQL), commentOf(BASELINE));
});

test('24 is safe to re-apply and changes no data', () => {
  assert.match(SQL, /drop constraint if exists support_answers_tones_check/);
  assert.doesNotMatch(codeOnly(SQL), /^\s*(update|insert|delete)\s+/im);
});
