import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('63_never_auto_send');
const EXEMPLARS = read('05_exemplars');
const DRAFTING = read('07_drafting');

const commentOf = (sql, table, column) =>
  sql.match(new RegExp(`comment on column public\\.${table}\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('the baseline declares both columns 63 adds, with the same comments', () => {
  assert.ok(columnsIn(EXEMPLARS, 'support_exemplars').includes('never_auto_send'));
  assert.ok(columnsIn(DRAFTING, 'ticket_drafts').includes('auto_send_blockers'));
  assert.match(SQL, /add column if not exists never_auto_send boolean not null default false;/);
  assert.match(SQL, /add column if not exists auto_send_blockers jsonb not null default '\[\]'::jsonb;/);
  assert.ok(commentOf(EXEMPLARS, 'support_exemplars', 'never_auto_send'));
  assert.equal(commentOf(SQL, 'support_exemplars', 'never_auto_send'), commentOf(EXEMPLARS, 'support_exemplars', 'never_auto_send'));
  assert.ok(commentOf(DRAFTING, 'ticket_drafts', 'auto_send_blockers'));
  assert.equal(commentOf(SQL, 'ticket_drafts', 'auto_send_blockers'), commentOf(DRAFTING, 'ticket_drafts', 'auto_send_blockers'));
});

test('63 writes no data: which situations are held is the business\'s choice', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
