import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('25_rule_links');
const EXEMPLARS = read('05_exemplars');
const DRAFTING = read('07_drafting');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const commentOf = (sql, column) =>
  sql.match(new RegExp(`comment on column public\\.support_answers\\.${column} is\\s*'((?:[^']|'')*)';`))?.[1];

test('the baselines declare the columns 25 adds', () => {
  const answers = columnsIn(EXEMPLARS, 'support_answers');
  assert.ok(answers.includes('link_url'));
  assert.ok(answers.includes('link_label'));
  assert.ok(columnsIn(DRAFTING, 'ticket_drafts').includes('reply_link'));
  assert.match(SQL, /add column if not exists link_url text/);
  assert.match(SQL, /add column if not exists link_label text/);
  assert.match(SQL, /add column if not exists reply_link jsonb/);
});

test('25 carries the baselines’ checks, not retyped ones', () => {
  for (const [name, baseline] of [
    ['support_answers_link_url_check', EXEMPLARS],
    ['support_answers_link_pair_check', EXEMPLARS],
    ['ticket_drafts_reply_link_object_check', DRAFTING]
  ]) {
    const clause = checkClause(SQL, name);
    assert.ok(clause, `${name} is missing from 25`);
    assert.equal(squash(clause), squash(checkClause(baseline, name)), `${name} differs from the baseline`);
  }
});

test('a link is https only, and both halves or neither', () => {
  assert.match(checkClause(EXEMPLARS, 'support_answers_link_url_check'), /'\^https:\/\//);
  assert.match(checkClause(EXEMPLARS, 'support_answers_link_pair_check'), /\(link_url is null\) = \(link_label is null\)/);
});

test('25 carries the baseline’s column comments', () => {
  for (const column of ['link_url', 'link_label']) {
    assert.ok(commentOf(SQL, column), `${column} comment is missing from 25`);
    assert.equal(commentOf(SQL, column), commentOf(EXEMPLARS, column));
  }
});

test('25 is safe to re-apply and changes no data', () => {
  assert.match(SQL, /drop constraint if exists support_answers_link_url_check/);
  assert.match(SQL, /drop constraint if exists ticket_drafts_reply_link_object_check/);
  assert.doesNotMatch(codeOnly(SQL), /^\s*(update|insert|delete)\s+/im);
});
