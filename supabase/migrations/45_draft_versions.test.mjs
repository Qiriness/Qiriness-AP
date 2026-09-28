import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('45_draft_versions');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, column) =>
  sql.match(new RegExp(`comment on column public\\.ticket_drafts\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('the baseline declares the columns 45 adds', () => {
  const columns = columnsIn(DRAFTING, 'ticket_drafts');
  for (const column of ['case_version', 'trigger_event_id', 'stale_reason']) {
    assert.ok(columns.includes(column), column);
    assert.match(SQL, new RegExp(`add column if not exists ${column} `));
  }
});

test('45 carries the baseline checks, not retyped ones', () => {
  for (const name of [
    'ticket_drafts_status_check',
    'ticket_drafts_stale_reason_check',
    'ticket_drafts_stale_has_reason_check',
    'ticket_drafts_case_version_check'
  ]) {
    const clause = checkClause(SQL, name);
    assert.ok(clause, `${name} is missing from 45`);
    assert.equal(squash(clause), squash(checkClause(DRAFTING, name)), `${name} differs from the baseline`);
  }
  assert.ok(literalsIn(checkClause(SQL, 'ticket_drafts_status_check')).includes('stale'));
});

test('the key moves from the message to the case version', () => {
  assert.match(DRAFTING, /constraint ticket_drafts_shop_ticket_version_key unique \(shop_id, ticket_id, case_version\)/);
  assert.doesNotMatch(DRAFTING, /unique \(shop_id, trigger_message_id\)/);
  assert.match(SQL, /drop constraint if exists ticket_drafts_shop_id_trigger_message_id_key/);
  assert.match(SQL, /add constraint ticket_drafts_shop_ticket_version_key unique \(shop_id, ticket_id, case_version\)/);
  assert.match(SQL, /create index if not exists ticket_drafts_trigger_idx on public\.ticket_drafts \(shop_id, trigger_message_id\)/);
});

test('45 carries the baseline column comments', () => {
  for (const column of ['case_version', 'trigger_event_id', 'stale_reason', 'status', 'trigger_message_id']) {
    assert.ok(commentOf(SQL, column), `${column} comment is missing from 45`);
    assert.equal(commentOf(SQL, column), commentOf(DRAFTING, column), column);
  }
});

test('45 is safe to re-apply and changes no data', () => {
  assert.doesNotMatch(codeOnly(SQL), /^\s*(update|insert|delete)\s+/im);
});
