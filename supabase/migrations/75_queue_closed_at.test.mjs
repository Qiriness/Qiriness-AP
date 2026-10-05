import assert from 'node:assert/strict';
import test from 'node:test';

import { COLUMNS } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('75_queue_closed_at');
const SUPPORT = read('04_support');
const CASES = read('61_cases');

function viewOf(sql, name) {
  const match = sql.match(new RegExp(`create (?:or replace )?view public\\.${name}\\n[\\s\\S]*?;\\n`));
  return match?.[0].replace(/^create or replace view/, 'create view');
}

test('the queue is copied from 04, byte for byte', () => {
  assert.ok(viewOf(SUPPORT, 'ticket_queue'));
  assert.equal(viewOf(SQL, 'ticket_queue'), viewOf(SUPPORT, 'ticket_queue'));
});

test('only appends to the view 61 created, so it can be replaced in place', () => {
  const before = viewOf(CASES, 'ticket_queue').split('\n  from public.tickets t')[0];
  const after = viewOf(SQL, 'ticket_queue');
  assert.ok(after.startsWith(before.replace(/cf\.status as case_status$/, 'cf.status as case_status,')));
  assert.match(after, /t\.resolved_at as resolved_at,\n {4}t\.closed_at as closed_at\n {2}from public\.tickets t/);
});

test('the dashboard reads both columns', () => {
  for (const column of ['resolved_at', 'closed_at']) assert.ok(COLUMNS.ticketQueue.split(',').includes(column), column);
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
