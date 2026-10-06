import assert from 'node:assert/strict';
import test from 'node:test';

import { T, V } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('78_dropped_mail_list');
const SUPPORT = read('04_support');

function block(sql, start) {
  const from = sql.indexOf(start);
  assert.ok(from >= 0, start);
  return sql.slice(from, sql.indexOf(';\n', from) + 2);
}

test('78 creates the table and the view the baseline does', () => {
  assert.equal(
    block(SQL, 'create table if not exists public.dropped_mail_clears').replace(' if not exists', ''),
    block(SUPPORT, 'create table public.dropped_mail_clears')
  );
  assert.equal(
    block(SQL, 'create or replace view public.dropped_mail_list').replace(' or replace', ''),
    block(SUPPORT, 'create view public.dropped_mail_list')
  );
});

test('the list leaves out cleared and promoted mail, and never carries the text', () => {
  const view = block(SQL, 'create or replace view public.dropped_mail_list');
  assert.match(view, /a\.outcome = 'blocked'/);
  assert.match(view, /not exists \(\s*select 1 from public\.dropped_mail_clears c/);
  assert.match(view, /not exists \(\s*select 1 from public\.ticket_messages m/);
  assert.doesNotMatch(view, /a\.body_text as/);
  assert.match(view, /\(a\.body_text is not null\) as has_body/);
});

test('the code names them', () => {
  assert.equal(T.DROPPED_MAIL_CLEARS, 'dropped_mail_clears');
  assert.equal(V.DROPPED_MAIL_LIST, 'dropped_mail_list');
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
