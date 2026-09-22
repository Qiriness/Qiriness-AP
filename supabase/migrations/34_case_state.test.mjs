import assert from 'node:assert/strict';
import test from 'node:test';

import { T } from '../../scripts/lib/tables.mjs';
import { CASE_RELATIONSHIPS } from '../../scripts/lib/case-state-record.mjs';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('34_case_state');
const SUPPORT = read('04_support');
const TABLE = 'ticket_case_state';

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('34 creates the same table the baseline does, column for column', () => {
  // A fresh install applies 04; an existing database applies this. The two
  // drifting apart is the failure this pattern exists to make impossible, and
  // `advice_collections` set the precedent of stating it in both places.
  assert.deepEqual(columnsIn(SQL, TABLE), columnsIn(SUPPORT, TABLE));
});

test('every constraint is stated identically in both files', () => {
  const constraints = [
    'ticket_case_state_relationship_check',
    'ticket_case_state_resolved_inputs_array_check',
    'ticket_case_state_pending_inputs_array_check',
    'ticket_case_state_new_facts_array_check',
    'ticket_case_state_commitments_array_check',
    'ticket_case_state_contradictions_array_check',
    'ticket_case_state_evidence_reuse_object_check'
  ];
  for (const name of constraints) {
    const here = checkClause(SQL, name);
    assert.ok(here, `${name} is missing from 34`);
    assert.equal(squash(here), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the relationship vocabulary is the one the code owns', () => {
  // The same claim the needs check makes: a value can only be stored if BOTH
  // the DDL and the module that writes it agree, so neither can drift alone.
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'ticket_case_state_relationship_check')),
    [...CASE_RELATIONSHIPS].sort()
  );
});

test('the idempotency key is the one the other per-reading tables use', () => {
  // `ticket_investigations` and `ticket_drafts` are both keyed this way, and
  // for the same reason: one reading per triggering message, so a re-run
  // rewrites its own row and a reply adds a new one rather than overwriting.
  assert.match(codeOnly(SQL), /unique \(shop_id, trigger_message_id\)/);
  assert.match(codeOnly(SUPPORT), /unique \(shop_id, trigger_message_id\)/);
});

test('it is idempotent, so applying it to a fresh baseline is a no-op', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.ticket_case_state/);
  assert.match(code, /create index if not exists ticket_case_state_ticket_idx/);
});

test('it creates schema and migrates no data', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
  assert.doesNotMatch(codeOnly(SQL), /drop (column|table)/i);
});

test('RLS is on with no policies, so only the service role reaches it', () => {
  assert.match(codeOnly(SQL), /alter table public\.ticket_case_state enable row level security/);
  assert.doesNotMatch(codeOnly(SQL), /create policy/i);
});

test('the table and its load-bearing columns are documented', () => {
  assert.match(SQL, /comment on table public\.ticket_case_state is/);
  for (const column of ['case_relationship', 'situation_key', 'resolved_inputs', 'evidence_reuse']) {
    assert.match(SQL, new RegExp(`comment on column public\\.ticket_case_state\\.${column} is`), column);
  }
});

test('the schema contract names it', () => {
  assert.equal(T.TICKET_CASE_STATE, TABLE);
});
