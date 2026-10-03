import assert from 'node:assert/strict';
import test from 'node:test';

import { USAGE_PASSES } from '../../agent/src/llm/usage-sink.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('64_casework_usage_pass');
const ANALYTICS = read('06_analytics');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql) => sql.match(/comment on column public\.llm_usage\.pass is\s*'((?:[^']|'')*)';/)?.[1];

test('64 sets the same pass list as the baseline, and it is the one the sink emits', () => {
  assert.equal(squash(checkClause(SQL, 'llm_usage_pass_check')), squash(checkClause(ANALYTICS, 'llm_usage_pass_check')));
  assert.deepEqual(literalsIn(checkClause(SQL, 'llm_usage_pass_check')), [...USAGE_PASSES].sort());
  for (const pass of ['casework', 'closure']) assert.ok(USAGE_PASSES.includes(pass), pass);
});

test('64 copies the baseline comment on the pass column', () => {
  assert.ok(commentOf(ANALYTICS));
  assert.equal(commentOf(SQL), commentOf(ANALYTICS));
});

test('64 writes no data: old rows recorded as other stay as they are', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
