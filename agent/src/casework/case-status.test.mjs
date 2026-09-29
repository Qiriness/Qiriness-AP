import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_STATUS_BY_NEXT_ACTOR, caseStatusRecord, parseCaseStatusMap, statusFromCase } from './case-status.mjs';

const ticket = (status, extra = {}) => ({ id: 't1', status, resolved_at: null, level: 2, metadata: {}, ...extra });
const next = (actor) => ({ next_actor: actor, version: 3 });

test('each next actor moves an open ticket to its status', () => {
  assert.equal(statusFromCase(ticket('open'), next('customer')).status, 'awaiting_customer');
  assert.equal(statusFromCase(ticket('open'), next('colleague')).status, 'awaiting_human');
  assert.equal(statusFromCase(ticket('open'), next('partner')).status, 'awaiting_human');
  assert.equal(statusFromCase(ticket('open'), next('nobody')).status, 'resolved');
  assert.equal(statusFromCase(ticket('awaiting_customer'), next('support')).status, 'open');
});

test('our turn keeps awaiting_human: a person was asked to act, and auto-close exempts it', () => {
  // 15 live tickets on 2026-09-27: folding them to open would let silence close them.
  assert.deepEqual(statusFromCase(ticket('awaiting_human'), next('support')), { status: null, reason: 'unchanged' });
  assert.deepEqual(statusFromCase(ticket('open'), next('support')), { status: null, reason: 'unchanged' });
});

test('a status a person, auto-close, forwarding or the spam filter set is never touched', () => {
  for (const status of ['closed', 'forwarded', 'spam']) {
    assert.equal(statusFromCase(ticket(status), next('customer')).reason, 'not_ours');
  }
  // Resolved by a person: no case_status record.
  const byPerson = ticket('resolved', { resolved_at: '2026-09-20T10:00:00Z' });
  assert.equal(statusFromCase(byPerson, next('support')).reason, 'not_ours');
  // A record from an older fold does not match a later resolve by a person.
  const later = ticket('resolved', {
    resolved_at: '2026-09-21T10:00:00Z',
    metadata: { case_status: { status: 'resolved', resolved_at: '2026-09-20T10:00:00Z' } }
  });
  assert.equal(statusFromCase(later, next('support')).reason, 'not_ours');
});

test('a resolve the fold made is undone when the case needs someone again', () => {
  // As Postgres returns it, against the ISO string the fold recorded.
  const own = ticket('resolved', {
    resolved_at: '2026-09-20T10:00:00+00:00',
    metadata: { case_status: { status: 'resolved', resolved_at: '2026-09-20T10:00:00.000Z' } }
  });
  assert.equal(statusFromCase(own, next('partner')).status, 'awaiting_human');
  assert.equal(statusFromCase(own, next('nobody')).reason, 'unchanged');
});

test('a ticket still owed a categorisation or investigation stays open', () => {
  // Both passes claim only status = open; leaving it would strand the ticket.
  assert.equal(statusFromCase(ticket('open', { needs_investigation: true }), next('nobody')).reason, 'pass_pending');
  assert.equal(statusFromCase(ticket('open', { needs_categorisation: true }), next('customer')).reason, 'pass_pending');
  // Moving INTO open is always allowed.
  assert.equal(statusFromCase(ticket('awaiting_customer', { needs_categorisation: true }), next('support')).status, 'open');
});

test('a level the fold never resolves stays with a person', () => {
  const severe = ticket('open', { level: 4 });
  assert.equal(statusFromCase(severe, next('nobody')).status, 'resolved');
  assert.equal(statusFromCase(ticket('awaiting_customer', { level: 4 }), next('nobody'), { keepOpenLevels: [4] }).status, 'open');
  assert.equal(statusFromCase(severe, next('nobody'), { keepOpenLevels: [4] }).reason, 'unchanged');
});

test('archived, deleted or unfolded tickets do not move', () => {
  assert.equal(statusFromCase(ticket('open', { archived_at: '2026-09-01' }), next('nobody')).reason, 'archived');
  assert.equal(statusFromCase(ticket('open', { deleted_at: '2026-09-01' }), next('nobody')).reason, 'archived');
  assert.equal(statusFromCase(ticket('open'), null).reason, 'no_case');
});

test('the map is per brand: off, or overridden actor by actor', () => {
  assert.equal(parseCaseStatusMap('off'), null);
  assert.deepEqual(parseCaseStatusMap(''), { ...DEFAULT_STATUS_BY_NEXT_ACTOR });
  const map = parseCaseStatusMap('nobody:open, support:open|awaiting_human');
  assert.deepEqual(map.nobody, ['open']);
  assert.deepEqual(map.customer, ['awaiting_customer']);
  // A brand that keeps finished cases in the queue for a person to close.
  assert.equal(statusFromCase(ticket('awaiting_customer'), next('nobody'), { map }).status, 'open');
  assert.throws(() => parseCaseStatusMap('warehouse:open'), /not a next actor/);
  assert.throws(() => parseCaseStatusMap('nobody:closed'), /not a status the fold may set/);
});

test('the record says what the fold set, from what, and when it resolved', () => {
  const record = caseStatusRecord({ status: 'resolved', state: next('nobody'), from: 'open', at: '2026-09-27T10:00:00Z' });
  assert.deepEqual(record, { status: 'resolved', from: 'open', next_actor: 'nobody', version: 3, at: '2026-09-27T10:00:00Z', resolved_at: '2026-09-27T10:00:00Z' });
  assert.equal(caseStatusRecord({ status: 'open', state: next('support'), from: 'awaiting_customer', at: 'x' }).resolved_at, null);
});

test('a status a person set holds until the customer writes again', () => {
  const held = ticket('open', { overrides: { status: { value: 'open', set_at: '2026-09-29T10:00:00Z' } } });
  assert.deepEqual(statusFromCase(held, next('customer'), { lastCustomerAt: '2026-09-29T09:00:00Z' }), { status: null, reason: 'held_by_person' });
  assert.equal(statusFromCase(held, next('customer'), { lastCustomerAt: '2026-09-29T11:00:00Z' }).status, 'awaiting_customer');
});
