import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('50_forwarding_routing');
const SUPPORT = read('04_support');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CHECKS = [
  'ticket_routing_outcome_check',
  'ticket_routing_method_check',
  'ticket_routing_destination_check',
  'ticket_routing_ack_state_check'
];

test('50 creates the same ticket_routing the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'ticket_routing'), columnsIn(SUPPORT, 'ticket_routing'));
  for (const name of CHECKS) {
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the baseline declares the columns 50 adds', () => {
  assert.ok(columnsIn(SUPPORT, 'forwarding_settings').includes('forward_since'));
  assert.ok(columnsIn(SUPPORT, 'ticket_forwards').includes('destination_label'));
  assert.match(SQL, /alter table public\.forwarding_settings\s+add column if not exists forward_since timestamptz;/);
  assert.match(SQL, /alter table public\.ticket_forwards\s+add column if not exists destination_label text;/);
});

test('one decision per ticket, and the acknowledgement states the runner writes', () => {
  assert.match(codeOnly(SQL), /ticket_id uuid not null unique references public\.tickets\(id\) on delete cascade/);
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_routing_outcome_check')).sort(), ['forward', 'keep']);
  assert.deepEqual(
    literalsIn(checkClause(SQL, 'ticket_routing_ack_state_check')).sort(),
    ['failed', 'requested', 'sent', 'skipped']
  );
});

test('forwarding is off until a start date is set', () => {
  // No default: an existing settings row must not start forwarding by migrating.
  assert.doesNotMatch(codeOnly(SQL), /forward_since timestamptz\s+(not null|default)/);
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.ticket_routing/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
