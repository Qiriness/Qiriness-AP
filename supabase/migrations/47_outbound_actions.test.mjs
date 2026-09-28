import assert from 'node:assert/strict';
import test from 'node:test';

import { CANCEL_REASONS, OUTBOUND_MODES, OUTBOUND_STATES } from '../../scripts/lib/outbound-record.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('47_outbound_actions');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, table, column) =>
  sql.match(new RegExp(`comment on column public\\.${table}\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('47 creates the same table the baseline does, column for column', () => {
  assert.ok(columnsIn(DRAFTING, 'outbound_actions').length > 0);
  assert.deepEqual(columnsIn(SQL, 'outbound_actions'), columnsIn(DRAFTING, 'outbound_actions'));
});

test('47 carries the baseline checks, not retyped ones', () => {
  for (const name of [
    'outbound_actions_action_type_check',
    'outbound_actions_mode_check',
    'outbound_actions_state_check',
    'outbound_actions_cancel_reason_check',
    'outbound_actions_case_version_check',
    'outbound_actions_body_check',
    'outbound_actions_provider_check'
  ]) {
    assert.ok(checkClause(SQL, name), `${name} is missing from 47`);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(DRAFTING, name)), name);
  }
});

test('the states and modes are the ones the record module knows', () => {
  assert.deepEqual(literalsIn(checkClause(DRAFTING, 'outbound_actions_state_check')), [...OUTBOUND_STATES].sort());
  assert.deepEqual(literalsIn(checkClause(DRAFTING, 'outbound_actions_mode_check')), [...OUTBOUND_MODES].sort());
});

test('every cancel reason the worker can write is documented on the column', () => {
  const comment = commentOf(DRAFTING, 'outbound_actions', 'cancel_reason');
  for (const reason of CANCEL_REASONS) {
    assert.ok(comment.includes(reason), reason);
  }
});

test('one live or sent reply per case version is the key', () => {
  // Cancelled and failed rows step aside, so an edit can be approved again.
  const key = (guard) =>
    new RegExp(
      `create unique index ${guard}outbound_actions_idempotency_key\\s+on public\\.outbound_actions \\(shop_id, ticket_id, case_version, action_type\\)\\s+where state not in \\('cancelled', 'failed'\\);`
    );
  assert.match(DRAFTING, key(''));
  assert.match(SQL, key('if not exists '));
});

test('no recipient is stored', () => {
  for (const column of columnsIn(DRAFTING, 'outbound_actions')) {
    assert.doesNotMatch(column, /email|recipient|address|^to_/, column);
  }
});

test('47 carries the new ticket_drafts.status comment', () => {
  assert.equal(commentOf(SQL, 'ticket_drafts', 'status'), commentOf(DRAFTING, 'ticket_drafts', 'status'));
  assert.match(commentOf(DRAFTING, 'ticket_drafts', 'status'), /sent_confirmed/);
});

test('47 is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.outbound_actions/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
