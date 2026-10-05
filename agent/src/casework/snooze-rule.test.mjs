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

test('a person settling the check that kept our sent reply in the queue snoozes it, once per message of ours', () => {
  // b2789896: the fold had already read our reply; « Mark done » re-folds with
  // the same newest message, which alone is not a trigger.
  const sameMessage = { ...BEFORE, as_of_message_id: 'm-ours', next_actor: 'customer' };
  const settled = { ...SENT, obligations: [{ id: 'o-1', owner: 'support', status: 'fulfilled', opened_by: 'm-ours' }] };
  assert.equal(decide({ state: settled, previous: sameMessage }).reason, 'no_new_message_of_ours');
  assert.deepEqual(decide({ state: settled, previous: sameMessage, settledByPerson: true }), {
    action: 'snooze',
    waitingFor: 'customer',
    wakeAt: new Date('2026-10-07T09:55:00Z'),
    triggerMessageId: 'm-ours'
  });
  // Still one automatic snooze per message of ours: a woken or unsnoozed case stays.
  assert.equal(decide({ state: settled, previous: sameMessage, settledByPerson: true, alreadySnoozedOn: true }).reason, 'already_snoozed_on_message');
  // Another check of ours still open keeps it in the queue.
  const stillOwed = { ...settled, obligations: [...settled.obligations, { id: 'o-2', owner: 'support', status: 'pending', opened_by: 'm-ours' }] };
  assert.equal(decide({ state: stillOwed, previous: sameMessage, settledByPerson: true }).reason, 'support_owes_a_check');
  // The customer spoke last: settling a check is not waiting on them.
  const theirs = { ...settled, last_actor: 'customer', as_of_message_id: 'm-customer', next_actor: 'support' };
  assert.equal(decide({ state: theirs, previous: { ...BEFORE }, settledByPerson: true }).reason, 'no_new_message_of_ours');
  // Settled after the deadline would have passed: nothing.
  assert.equal(decide({ state: settled, previous: sameMessage, settledByPerson: true, now: new Date('2026-10-08T00:00:00Z') }).reason, 'deadline_passed');
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

// Snoozed on the customer after « we're asking the carrier »; then our message
// to Deret went out and the fold now says the partner acts next.
const ON_CUSTOMER = { id: 's1', source: 'auto', waiting_for: 'customer', trigger_message_id: 'm-ours' };
const WAS_CUSTOMER = { as_of_message_id: 'm-ours', next_actor: 'customer' };
const ASKED_DERET = {
  ...SENT,
  as_of_message_id: 'm-deret',
  as_of_at: '2026-09-30T09:58:00Z',
  next_actor: 'partner',
  obligations: [{ id: 'o-m-deret-0', owner: 'partner', status: 'pending', opened_by: 'm-deret' }]
};
const switchTo = (over = {}) => decide({ openSnooze: ON_CUSTOMER, previous: WAS_CUSTOMER, state: ASKED_DERET, ...over });

test('an automatic snooze follows the case to the party it now waits on, with that party\'s deadline', () => {
  assert.deepEqual(switchTo(), {
    action: 'retarget',
    snoozeId: 's1',
    waitingFor: 'partner',
    wakeAt: new Date('2026-10-05T09:58:00Z') // 3 working days, partner_check_overdue_days
  });
  // And back the other way: partner → customer takes the customer delay.
  const toCustomer = switchTo({
    openSnooze: { ...ON_CUSTOMER, waiting_for: 'partner' },
    previous: { as_of_message_id: 'm-deret', next_actor: 'partner' },
    state: { ...SENT, as_of_message_id: 'm-ours-2', next_actor: 'customer' }
  });
  assert.equal(toCustomer.action, 'retarget');
  assert.equal(toCustomer.waitingFor, 'customer');
  assert.deepEqual(toCustomer.wakeAt, new Date('2026-10-07T09:55:00Z'));
});

test('a party switch that turned the case into work wakes it rather than retargeting', () => {
  // A partner check a rule opened: nobody has written to Deret about it yet.
  const unsent = { ...ASKED_DERET, obligations: [{ id: 'o1', owner: 'partner', status: 'pending', opened_by: 'rule' }] };
  assert.deepEqual(switchTo({ state: unsent }), { action: 'wake', reason: 'case_changed', detail: 'request_not_sent' });
  // A check of ours.
  const ours = { ...ASKED_DERET, obligations: [{ id: 'o2', owner: 'support', status: 'pending', opened_by: 'm-deret' }] };
  assert.deepEqual(switchTo({ state: ours }), { action: 'wake', reason: 'case_changed', detail: 'support_owes_a_check' });
  // The shop never set a delay for the new party: it is not snoozed automatically.
  const noPartnerDelay = new Map([['customer_reply_wait_days', '5']]);
  assert.deepEqual(switchTo({ parameters: noPartnerDelay }), { action: 'wake', reason: 'case_changed', detail: 'no_deadline' });
  // The new party's deadline has already passed.
  assert.deepEqual(switchTo({ now: new Date('2026-10-06T10:00:00Z') }), { action: 'wake', reason: 'deadline' });
});

test('a person\'s snooze, or one already on the new party, is not retargeted', () => {
  assert.equal(switchTo({ openSnooze: { ...ON_CUSTOMER, source: 'manual' } }).reason, 'already_snoozed');
  assert.equal(switchTo({ openSnooze: { ...ON_CUSTOMER, waiting_for: 'partner' } }).reason, 'already_snoozed');
  // No change of party on this fold: nothing to follow.
  assert.equal(switchTo({ previous: { ...WAS_CUSTOMER, next_actor: 'partner' } }).reason, 'already_snoozed');
});
