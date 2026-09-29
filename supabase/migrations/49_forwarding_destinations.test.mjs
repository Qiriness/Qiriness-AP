import assert from 'node:assert/strict';
import test from 'node:test';

import { FORWARD_TIMINGS } from '../../scripts/lib/forwarding-destinations.mjs';
import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../scripts/lib/support-taxonomy.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('49_forwarding_destinations');
const SUPPORT = read('04_support');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CHECKS = [
  'forwarding_destinations_categories_check',
  'forwarding_destinations_request_kinds_check',
  'forwarding_destinations_timing_check',
  'forwarding_destinations_acknowledge_check'
];

test('49 creates the same two tables the baseline does, column for column', () => {
  // Columns a later migration added to the baseline are not 49's to create.
  const LATER = new Set(['forward_since', 'active_since']);
  for (const table of ['forwarding_destinations', 'forwarding_settings']) {
    assert.deepEqual(columnsIn(SQL, table), columnsIn(SUPPORT, table).filter((c) => !LATER.has(c)), table);
  }
  for (const name of CHECKS) {
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the vocabularies the database accepts are the ones the code writes', () => {
  // Sliced at the `<@`: the categories clause also carries a cardinality check.
  const categories = checkClause(SQL, 'forwarding_destinations_categories_check').split('<@')[1];
  assert.deepEqual(literalsIn(categories).sort(), [...TICKET_SUBJECTS].sort());
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'forwarding_destinations_request_kinds_check')).sort(),
    [...REQUEST_KINDS].sort()
  );
  assert.deepEqual(literalsIn(checkClause(SQL, 'forwarding_destinations_timing_check')).sort(), [...FORWARD_TIMINGS].sort());
});

test('the acknowledgement is off until a person turns it on', () => {
  assert.match(codeOnly(SQL), /ack_enabled boolean not null default false/);
});

test('a null address is the off switch, with no separate enabled flag', () => {
  const body = SQL.split('create table if not exists public.forwarding_destinations')[1].split('\n);')[0];
  assert.match(body, /forward_email text check \(forward_email is null or/);
  assert.doesNotMatch(codeOnly(body), /\benabled\b/);
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.forwarding_destinations/);
  assert.match(code, /create table if not exists public\.forwarding_settings/);
  assert.match(code, /drop trigger if exists forwarding_destinations_set_updated_at/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
