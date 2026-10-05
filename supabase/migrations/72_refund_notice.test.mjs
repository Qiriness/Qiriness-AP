import assert from 'node:assert/strict';
import test from 'node:test';

import { DRAFT_PURPOSES, NOTICE_EVENTS } from '../../agent/src/casework/change-router.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('72_refund_notice');
const EXEMPLARS = read('05_exemplars');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const comment = (sql, table, column) =>
  squash(sql.match(new RegExp(`comment on column public\\.${table}\\.${column} is\\s+'[\\s\\S]*?';`))?.[0]);

test('the baselines declare both columns, with the same checks and comments', () => {
  assert.ok(columnsIn(EXEMPLARS, 'support_answers').includes('notify_on'));
  assert.ok(columnsIn(DRAFTING, 'ticket_drafts').includes('purpose'));
  assert.equal(squash(checkClause(SQL, 'support_answers_notify_on_check')), squash(checkClause(EXEMPLARS, 'support_answers_notify_on_check')));
  assert.equal(squash(checkClause(SQL, 'ticket_drafts_purpose_check')), squash(checkClause(DRAFTING, 'ticket_drafts_purpose_check')));
  assert.ok(comment(SQL, 'support_answers', 'notify_on'));
  assert.equal(comment(SQL, 'support_answers', 'notify_on'), comment(EXEMPLARS, 'support_answers', 'notify_on'));
  assert.equal(comment(SQL, 'ticket_drafts', 'purpose'), comment(DRAFTING, 'ticket_drafts', 'purpose'));
});

test('the values the database accepts are the ones the code knows', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'support_answers_notify_on_check')), [...NOTICE_EVENTS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_drafts_purpose_check')), [...DRAFT_PURPOSES].sort());
});

test('no rule is marked and every draft stays a reply: nothing changes when it is applied', () => {
  assert.match(SQL, /add column if not exists notify_on text;/);
  assert.match(SQL, /add column if not exists purpose text not null default 'reply';/);
  const code = codeOnly(SQL);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});

test('the editor and the router read one list of notice events', async () => {
  const shared = await import('../../scripts/lib/notice-events.mjs');
  assert.equal(NOTICE_EVENTS, shared.NOTICE_EVENTS);
});
