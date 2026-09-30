import assert from 'node:assert/strict';
import test from 'node:test';

import { SNOOZE_SOURCES, WAITING_FOR, WAKE_REASONS } from '../../scripts/lib/snooze-record.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('54_ticket_snoozes');
const SUPPORT = read('04_support');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, column) =>
  sql.match(new RegExp(`comment on column public\\.ticket_snoozes\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('54 creates the same table the baseline does, column for column', () => {
  assert.ok(columnsIn(SUPPORT, 'ticket_snoozes').length > 0);
  assert.deepEqual(columnsIn(SQL, 'ticket_snoozes'), columnsIn(SUPPORT, 'ticket_snoozes'));
  for (const name of [
    'ticket_snoozes_source_check',
    'ticket_snoozes_waiting_for_check',
    'ticket_snoozes_wake_reason_check',
    'ticket_snoozes_woke_check'
  ]) {
    assert.ok(checkClause(SQL, name), name);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the values the database accepts are the values the code writes', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_snoozes_source_check')), [...SNOOZE_SOURCES].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_snoozes_waiting_for_check')), [...WAITING_FOR].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_snoozes_wake_reason_check')), [...WAKE_REASONS].sort());
});

test('one open snooze per ticket, one automatic snooze per message of ours', () => {
  for (const sql of [SQL, SUPPORT]) {
    assert.match(sql, /ticket_snoozes_open_key\s+on public\.ticket_snoozes \(ticket_id\) where woke_at is null;/);
    assert.match(sql, /ticket_snoozes_auto_trigger_key\s+on public\.ticket_snoozes \(ticket_id, trigger_message_id\) where source = 'auto';/);
    assert.match(sql, /ticket_snoozes_due_idx\s+on public\.ticket_snoozes \(shop_id, wake_at\) where woke_at is null;/);
  }
});

test('every snooze has a deadline', () => {
  assert.match(SUPPORT, /\n\s+wake_at timestamptz not null,/);
});

test('54 carries the baseline comments', () => {
  for (const column of ['waiting_for', 'wake_at', 'wake_reason']) {
    assert.ok(commentOf(SUPPORT, column), column);
    assert.equal(commentOf(SQL, column), commentOf(SUPPORT, column), column);
  }
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.ticket_snoozes/);
  assert.doesNotMatch(code, /create (unique )?index ticket_snoozes/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
