import assert from 'node:assert/strict';
import test from 'node:test';

import { toParameterMap } from '../../../scripts/lib/parameters.mjs';

import { snoozeDecision } from './snooze-rule.mjs';

const NOW = new Date('2026-09-30T10:00:00Z');
const PARAMETERS = toParameterMap([
  { parameter_key: 'customer_reply_wait_days', value: '5' },
  { parameter_key: 'colleague_check_overdue_days', value: '2' },
  { parameter_key: 'partner_check_overdue_days', value: '3' }
]);
const TICKET = {
  status: 'awaiting_customer',
  level: 2,
  deleted_at: null,
  archived_at: null,
  needs_categorisation: false,
  needs_investigation: false,
  overrides: {}
};
// Our reply to the customer went out at 09:55 and the fold just read it.
const SENT = {
  last_actor: 'support',
  as_of_message_id: 'm-ours',
  as_of_at: '2026-09-30T09:55:00Z',
  next_actor: 'customer',
  obligations: []
};
const BEFORE = { as_of_message_id: 'm-customer', next_actor: 'support' };

const decide = (over = {}) =>
  snoozeDecision({ ticket: TICKET, state: SENT, previous: BEFORE, parameters: PARAMETERS, keepOpenLevels: [4], now: NOW, ...over });

test('our sent reply that leaves the next step to the customer snoozes the ticket until the deadline', () => {
  assert.deepEqual(decide(), {
    action: 'snooze',
    waitingFor: 'customer',
    wakeAt: new Date('2026-10-07T09:55:00Z'),
    triggerMessageId: 'm-ours'
  });
});

test('nothing snoozes before a message of ours is in the thread: an approved or Outlook-held draft is not one', () => {
  // The fold sees no new message while the reply sits in Drafts.
  const unsent = { ...SENT, last_actor: 'customer', as_of_message_id: 'm-customer', next_actor: 'support' };
  assert.equal(decide({ state: unsent }).reason, 'no_new_message_of_ours');
  // Nor on a fold that read the same message of ours again.
  assert.equal(decide({ previous: { ...BEFORE, as_of_message_id: 'm-ours' } }).reason, 'no_new_message_of_ours');
  // Nor on a first fold, which has nothing to compare with.
  assert.equal(decide({ previous: null }).reason, 'no_new_message_of_ours');
});

test('a message of ours already snoozed on once is not snoozed on again, so a deadline wake does not bounce', () => {
  assert.equal(decide({ alreadySnoozedOn: true }).reason, 'already_snoozed_on_message');
});

test('a partner asked in the thread snoozes on the partner delay; a partner check a rule opened does not', () => {
  const asked = { ...SENT, next_actor: 'partner', obligations: [{ id: 'o-m-ours-0', owner: 'partner', status: 'pending', opened_by: 'm-ours' }] };
  const decision = decide({ state: asked });
  assert.equal(decision.action, 'snooze');
  assert.equal(decision.waitingFor, 'partner');
  assert.equal(decision.wakeAt.toISOString(), '2026-10-05T09:55:00.000Z');

  const ruleOnly = { ...asked, obligations: [{ id: 'r-1', owner: 'partner', status: 'pending', opened_by: 'rule' }] };
  assert.equal(decide({ state: ruleOnly }).reason, 'request_not_sent');
});

test('a check we owe keeps the case in the queue, whoever else we wait on', () => {
  const ours = { ...SENT, obligations: [{ id: 'o-1', owner: 'support', status: 'pending', opened_by: 'm-1' }] };
  assert.equal(decide({ state: ours }).reason, 'support_owes_a_check');
  // A settled one does not.
  const settled = { ...SENT, obligations: [{ id: 'o-1', owner: 'support', status: 'fulfilled', opened_by: 'm-1' }] };
  assert.equal(decide({ state: settled }).action, 'snooze');
});

test("our turn, or nobody's, is not waiting", () => {
  assert.equal(decide({ state: { ...SENT, next_actor: 'support' } }).reason, 'not_waiting');
  assert.equal(decide({ state: { ...SENT, next_actor: 'nobody' } }).reason, 'not_waiting');
});

test('a person, level 4, a pending pass, or a status the fold does not own keep the ticket where it is', () => {
  const held = { ...TICKET, overrides: { status: { value: 'open', set_at: '2026-09-30T08:00:00Z' } } };
  assert.equal(decide({ ticket: held, lastCustomerAt: '2026-09-29T08:00:00Z' }).reason, 'held_by_person');
  assert.equal(decide({ ticket: { ...TICKET, level: 4 } }).reason, 'level_kept_open');
  assert.equal(decide({ ticket: { ...TICKET, needs_investigation: true } }).reason, 'pass_pending');
  assert.equal(decide({ ticket: { ...TICKET, status: 'forwarded' } }).reason, 'not_ours');
  assert.equal(decide({ ticket: { ...TICKET, archived_at: '2026-09-01T00:00:00Z' } }).reason, 'archived');
});

test('no delay set, or a deadline already past, means no automatic snooze', () => {
  assert.equal(decide({ parameters: new Map() }).reason, 'no_deadline');
  assert.equal(decide({ now: new Date('2026-10-20T00:00:00Z') }).reason, 'deadline_passed');
});

test('a snoozed case wakes when it comes back to us or ends, and only on that change', () => {
  const open = { id: 's1', source: 'manual', waiting_for: 'date' };
  const ours = { ...SENT, next_actor: 'support' };
  assert.deepEqual(decide({ openSnooze: open, previous: { ...BEFORE, next_actor: 'partner' }, state: ours }), { action: 'wake', reason: 'case_changed' });
  assert.deepEqual(decide({ openSnooze: open, previous: { ...BEFORE, next_actor: 'customer' }, state: { ...SENT, next_actor: 'nobody' } }), {
    action: 'wake',
    reason: 'resolved'
  });
  // « Follow up Friday » on a case that was already ours stays snoozed.
  assert.equal(decide({ openSnooze: open, previous: { ...BEFORE, next_actor: 'support' }, state: ours }).reason, 'already_snoozed');
});
