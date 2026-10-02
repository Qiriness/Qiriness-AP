import assert from 'node:assert/strict';
import test from 'node:test';

import { CASE_LINK_DECISIONS, CASE_LINK_METHODS, CASE_LINK_STATES } from '../../scripts/lib/case-record.mjs';
import { EDITABLE_AGENTS } from '../../scripts/lib/agent-models.mjs';
import { USAGE_PASSES } from '../../agent/src/llm/usage-sink.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('61_cases');
const SUPPORT = read('04_support');
const ANALYTICS = read('06_analytics');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** One `create [or replace] view ... ;` statement, normalised to `create view`. */
function viewOf(sql, name) {
  const match = sql.match(new RegExp(`create (?:or replace )?view public\\.${name}\\n[\\s\\S]*?;\\n`));
  return match?.[0].replace(/^create or replace view/, 'create view');
}

function functionOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4);
}

test('61 creates the same tables the baseline does, column for column', () => {
  for (const table of ['cases', 'issue_family_members', 'issue_family_transitions', 'case_links']) {
    assert.ok(columnsIn(SUPPORT, table).length > 0, table);
    assert.deepEqual(columnsIn(SQL, table), columnsIn(SUPPORT, table), table);
  }
  for (const name of [
    'issue_family_members_kind_check',
    'issue_family_transitions_not_self_check',
    'case_links_decision_check',
    'case_links_method_check',
    'case_links_candidates_array_check',
    'case_links_shape_check',
    'tickets_case_link_state_check',
    'agent_models_agent_check'
  ]) {
    assert.ok(checkClause(SQL, name), name);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
  assert.equal(squash(checkClause(SQL, 'llm_usage_pass_check')), squash(checkClause(ANALYTICS, 'llm_usage_pass_check')));
});

test('the values the database accepts are the values the code writes', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'case_links_method_check')), [...CASE_LINK_METHODS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'case_links_decision_check')), [...CASE_LINK_DECISIONS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'tickets_case_link_state_check')), [...CASE_LINK_STATES].sort());
  assert.ok(EDITABLE_AGENTS.includes('case_link'));
  assert.ok(USAGE_PASSES.includes('case_link'));
});

test('every ticket has a case in the baseline, and the column comes in nullable, is backfilled, then required', () => {
  assert.match(SUPPORT, /case_id uuid not null references public\.cases\(id\) on delete restrict/);
  assert.match(SQL, /add column if not exists case_id uuid references public\.cases\(id\) on delete restrict/);
  const code = codeOnly(SQL);
  const backfill = code.indexOf('insert into public.cases (id, shop_id, created_at)');
  const required = code.indexOf('alter column case_id set not null');
  assert.ok(backfill > 0 && required > backfill, 'the backfill runs before the column is required');
  assert.match(code, /update public\.tickets set case_link_state = 'decided' where case_link_state = 'pending'/);
  // A duplicate joins its original's case, and says so.
  assert.match(code, /'link', 'backfill'/);
});

test('the case views and the queue are copied from 04, byte for byte', () => {
  for (const view of ['case_message_counts', 'case_facts', 'ticket_queue']) {
    assert.ok(viewOf(SUPPORT, view), view);
    assert.equal(viewOf(SQL, view), viewOf(SUPPORT, view), view);
  }
  // case_facts before the queue that reads it.
  assert.ok(SQL.indexOf('view public.case_facts') < SQL.indexOf('view public.ticket_queue'));
});

test('the Insights support figures count cases, copied byte for byte from 06', () => {
  for (const name of ['insights_support_summary', 'insights_support_series', 'insights_support_categories']) {
    assert.equal(functionOf(SQL, name), functionOf(ANALYTICS, name), name);
    assert.match(functionOf(ANALYTICS, name), /from public\.case_facts t/, name);
  }
  assert.equal(viewOf(SQL, 'customer_ticket_facts'), viewOf(ANALYTICS, 'customer_ticket_facts'));
  assert.match(viewOf(ANALYTICS, 'customer_ticket_facts'), /from public\.case_facts t/);
});

test('the issue families are seeded as data, never assumed in code', () => {
  assert.match(SQL, /insert into public\.issue_family_members[\s\S]*on conflict \(shop_id, member_kind, member_key\) do nothing;/);
  assert.match(SQL, /\('subject', 'delivery', 'DELIVERY'\)/);
  assert.match(SQL, /\('DELIVERY', 'REFUND_RETURN'\)/);
});

test('it is idempotent', () => {
  const code = codeOnly(SQL);
  for (const table of ['cases', 'issue_family_members', 'issue_family_transitions', 'case_links']) {
    assert.match(code, new RegExp(`create table if not exists public\\.${table} `), table);
  }
  assert.doesNotMatch(code, /create (unique )?index (?!if not exists)/);
  assert.match(code, /drop trigger if exists cases_set_updated_at/);
});

test('a ticket inserted without a case opens one, the same way in the baseline and in 61', () => {
  const fn = (sql) => squash(sql.match(/create or replace function public\.tickets_open_case\(\)[\s\S]*?\n\$\$;/)?.[0]);
  assert.ok(fn(SUPPORT));
  assert.equal(fn(SQL), fn(SUPPORT));
  assert.match(SQL, /drop trigger if exists tickets_open_case on public\.tickets;\ncreate trigger tickets_open_case\nbefore insert on public\.tickets/);
  // After the backfill, so the backfill's own rows are not given a second case.
  assert.ok(SQL.indexOf('create trigger tickets_open_case') > SQL.indexOf('alter column case_id set not null'));
});
