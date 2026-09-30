import assert from 'node:assert/strict';
import test from 'node:test';

import { OUTBOUND_MODES } from '../../scripts/lib/outbound-record.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('52_manual_replies');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, table, column) =>
  sql.match(new RegExp(`comment on column public\\.${table}\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('the baseline declares the columns 52 adds', () => {
  assert.ok(columnsIn(DRAFTING, 'ticket_drafts').includes('approved_body_html'));
  assert.match(SQL, /add column if not exists approved_body_html text;/);
  for (const column of ['client_key', 'body_html']) {
    assert.ok(columnsIn(DRAFTING, 'outbound_actions').includes(column), column);
    assert.match(SQL, new RegExp(`add column if not exists ${column} `));
  }
});

test('52 carries the baseline checks, not retyped ones', () => {
  for (const name of [
    'outbound_actions_action_type_check',
    'outbound_actions_mode_check',
    'outbound_actions_manual_shape_check'
  ]) {
    assert.ok(checkClause(SQL, name), `${name} is missing from 52`);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(DRAFTING, name)), name);
  }
  assert.deepEqual(literalsIn(checkClause(DRAFTING, 'outbound_actions_mode_check')), [...OUTBOUND_MODES].sort());
});

test('a manual reply has no draft, and only a manual reply', () => {
  assert.match(DRAFTING, /-- Null exactly for a manual reply[^\n]*\n\s*draft_id uuid references public\.ticket_drafts/);
  assert.match(SQL, /alter column draft_id drop not null/);
});

test('the version key leaves manual replies out; client_key keys them', () => {
  const narrowed = /on public\.outbound_actions \(shop_id, ticket_id, case_version, action_type\)\s+where state not in \('cancelled', 'failed'\) and action_type = 'reply';/;
  assert.match(DRAFTING, narrowed);
  assert.match(SQL, narrowed);
  assert.match(SQL, /drop index if exists public\.outbound_actions_idempotency_key;/);
  const clientKey = /outbound_actions_client_key on public\.outbound_actions \(shop_id, client_key\);/;
  assert.match(DRAFTING, clientKey);
  assert.match(SQL, clientKey);
});

test('52 carries the baseline comments', () => {
  assert.equal(commentOf(SQL, 'ticket_drafts', 'approved_body_html'), commentOf(DRAFTING, 'ticket_drafts', 'approved_body_html'));
  for (const column of ['mode', 'client_key', 'body_html']) {
    assert.ok(commentOf(DRAFTING, 'outbound_actions', column), column);
    assert.equal(commentOf(SQL, 'outbound_actions', column), commentOf(DRAFTING, 'outbound_actions', column), column);
  }
});

test('52 writes no data', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
