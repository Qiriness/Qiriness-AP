import assert from 'node:assert/strict';
import test from 'node:test';

import { CANCEL_REASONS } from '../../scripts/lib/outbound-record.mjs';
import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('69_fact_drift');
const SUPPORT = read('04_support');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CHECK = 'tickets_fact_drift_object_check';
const comment = (sql) => squash(sql.match(/comment on column public\.tickets\.fact_drift is\s+'[\s\S]*?';/)?.[0]);

test('the baseline declares the column 69 adds, with the same check and comment', () => {
  assert.ok(columnsIn(SUPPORT, 'tickets').includes('fact_drift'));
  assert.match(SQL, /add column if not exists fact_drift jsonb;/);
  assert.equal(squash(checkClause(SQL, CHECK)), squash(checkClause(SUPPORT, CHECK)));
  assert.ok(comment(SQL));
  assert.equal(comment(SQL), comment(SUPPORT));
});

test('nullable, so no existing ticket changes version when it is applied', () => {
  assert.doesNotMatch(SQL, /fact_drift jsonb not null/);
  assert.doesNotMatch(SQL, /default/i);
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /if not exists \(\s*select 1 from pg_constraint where conname = 'tickets_fact_drift_object_check'/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

test('the cancel-reason comment matches the baseline and lists every reason the worker writes', () => {
  const reasons = (sql) => squash(sql.match(/comment on column public\.outbound_actions\.cancel_reason is\s+'[\s\S]*?';/)?.[0]);
  assert.equal(reasons(SQL), reasons(DRAFTING));
  for (const reason of CANCEL_REASONS) assert.ok(reasons(SQL).includes(reason), reason);
});
