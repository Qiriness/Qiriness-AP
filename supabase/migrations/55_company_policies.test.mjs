import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, read } from './_shared.test.mjs';

const SQL = read('55_company_policies');
const EXEMPLARS = read('05_exemplars');
const SUPPORT = read('04_support');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const TABLES = ['company_policies', 'company_policy_versions', 'company_policy_links'];

test('55 creates the same three tables the baseline does, column for column', () => {
  for (const table of TABLES) {
    assert.ok(columnsIn(EXEMPLARS, table).length > 0, table);
    assert.deepEqual(columnsIn(SQL, table), columnsIn(EXEMPLARS, table), table);
  }
  for (const name of ['company_policies_key_shape_check', 'company_policies_version_check', 'company_policy_links_one_target_check']) {
    assert.ok(checkClause(SQL, name), name);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(EXEMPLARS, name)), name);
  }
});

test('a policy is linked once per situation and once per rule', () => {
  for (const sql of [SQL, EXEMPLARS]) {
    assert.match(sql, /company_policy_links_situation_unique\s+on public\.company_policy_links \(policy_id, situation_key\) where situation_key is not null;/);
    assert.match(sql, /company_policy_links_answer_unique\s+on public\.company_policy_links \(policy_id, answer_id\) where answer_id is not null;/);
    assert.match(sql, /company_policies_shop_key_unique\s+on public\.company_policies \(shop_id, policy_key\);/);
  }
});

test('the case file records the policies it read', () => {
  assert.ok(columnsIn(SUPPORT, 'ticket_investigations').includes('company_policies'));
  assert.match(SQL, /add column if not exists company_policies jsonb not null default '\[\]'::jsonb;/);
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  for (const table of TABLES) assert.match(code, new RegExp(`create table if not exists public\\.${table}`));
  assert.doesNotMatch(code, /create (unique )?index company_/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
