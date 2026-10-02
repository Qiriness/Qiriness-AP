import assert from 'node:assert/strict';
import test from 'node:test';

import { OVERRIDE_FIELDS } from '../../scripts/lib/ticket-overrides.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('48_ticket_overrides');
const SUPPORT = read('04_support');
const CASES = read('61_cases');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const selectList = (sql) => squash(codeOnly(sql).match(/view public\.ticket_queue[\s\S]*?where t\.deleted_at is null;/)?.[0]);

test('48 creates the same audit table the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'ticket_overrides'), columnsIn(SUPPORT, 'ticket_overrides'));
  for (const name of ['ticket_overrides_field_check', 'ticket_overrides_action_check', 'ticket_overrides_value_check']) {
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the fields the database accepts are the fields the code overrides', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_overrides_field_check')).sort(), [...OVERRIDE_FIELDS].sort());
});

test('the baseline declares the column 48 adds, and the view carries it last', () => {
  assert.ok(columnsIn(SUPPORT, 'tickets').includes('overrides'));
  assert.match(SQL, /add column if not exists overrides jsonb not null default '\{\}'::jsonb/);
  assert.match(selectList(SQL), /t\.overrides as overrides from public\.tickets t/);
  // 61 (cases) has since appended its columns after this one: 61 is the step
  // that must match the baseline now, and 48 stays the historical step it was.
  assert.match(selectList(SUPPORT), /t.overrides as overrides, t.case_id as case_id/);
  assert.equal(selectList(CASES).replace(/^create or replace/, 'create'), selectList(SUPPORT).replace(/^create or replace/, 'create'));
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.ticket_overrides/);
  assert.match(code, /create index if not exists ticket_overrides_ticket_idx/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
