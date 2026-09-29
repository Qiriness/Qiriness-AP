import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeSituationOverride,
  keepOverrides,
  overrideChange,
  statusHeld,
  validOverrideValue,
  versionMaterial
} from './ticket-overrides.mjs';

const AT = '2026-09-29T10:00:00.000Z';
const ticket = (extra = {}) => ({
  status: 'open',
  investigated_at: '2026-09-28T10:00:00.000Z',
  category: 'order',
  level: 2,
  responsible_team: 'contact',
  overrides: {},
  ...extra
});

test('a situation change queues one investigation and raises the version', () => {
  const out = overrideChange({ ticket: ticket(), changes: { situation: 'D-05', level: 3 }, actorId: 'u1', aiSituation: 'D-36', at: AT });
  assert.equal(out.requeued, true);
  assert.equal(out.versionChanged, true);
  assert.equal(out.columns.needs_investigation, true);
  assert.equal(out.columns.level, 3);
  assert.deepEqual(out.columns.overrides.situation, { value: 'D-05', ai_value: 'D-36', set_by: 'u1', set_at: AT, source: 'edit_case' });
  assert.equal(out.audit.length, 2);
});

test('workflow fields neither queue a run nor raise the version', () => {
  const out = overrideChange({ ticket: ticket(), changes: { responsible_team: 'logistics', priority: 'high' }, at: AT });
  assert.equal(out.requeued, false);
  assert.equal(out.versionChanged, false);
  assert.equal(out.columns.responsible_team, 'logistics');
  assert.equal(out.columns.needs_investigation, undefined);
  assert.equal(out.columns.overrides.priority.value, 'high');
});

test('a category change is only a label while the situation is pinned', () => {
  const pinned = ticket({ overrides: { situation: { value: 'D-05', ai_value: null, set_at: AT } } });
  assert.equal(overrideChange({ ticket: pinned, changes: { category: 'delivery' }, at: AT }).requeued, false);
  assert.equal(overrideChange({ ticket: ticket(), changes: { category: 'delivery' }, at: AT }).requeued, true);
});

test('a resolved ticket gets the correction and no investigation', () => {
  const out = overrideChange({ ticket: ticket({ status: 'resolved' }), changes: { situation: 'D-05' }, at: AT });
  assert.equal(out.requeued, false);
  assert.equal(out.versionChanged, true);
});

test('the status a person sets in the same Save wins over the reopen', () => {
  // Resolved by the person: the correction is recorded, nothing is investigated.
  const resolved = overrideChange({ ticket: ticket({ status: 'awaiting_customer' }), changes: { situation: 'D-05', status: 'resolved' }, at: AT });
  assert.equal(resolved.columns.status, 'resolved');
  assert.equal(resolved.requeued, false);
  // Parked by the agent: reopened so the investigation can claim it.
  const parked = overrideChange({ ticket: ticket({ status: 'awaiting_customer' }), changes: { situation: 'D-05' }, at: AT });
  assert.equal(parked.columns.status, 'open');
  assert.equal(parked.requeued, true);
});

test('reset returns the column to the model value and writes a cleared row', () => {
  const t = ticket({ level: 1, overrides: { level: { value: 1, ai_value: 3, set_at: AT } } });
  const out = overrideChange({ ticket: t, changes: { level: null }, at: AT });
  assert.equal(out.columns.level, 3);
  assert.deepEqual(out.columns.overrides, {});
  assert.equal(out.audit[0].action, 'cleared');
  assert.equal(out.versionChanged, true);
});

test('setting what the pipeline already says is no change', () => {
  const out = overrideChange({ ticket: ticket(), changes: { level: 2 }, at: AT });
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.columns, {});
});

test('an unknown value is refused, not stored', () => {
  assert.throws(() => overrideChange({ ticket: ticket(), changes: { level: 7 } }));
  assert.throws(() => overrideChange({ ticket: ticket(), changes: { assignee: 'x' } }));
  assert.equal(validOverrideValue('situation', 'D-05'), 'D-05');
  assert.equal(validOverrideValue('situation', 'drop table'), null);
  assert.equal(validOverrideValue('status', 'awaiting_human'), null);
});

test('no version field overridden reads null, so no existing hash moves', () => {
  assert.equal(versionMaterial({}), null);
  assert.equal(versionMaterial({ priority: { value: 'high' } }), null);
  assert.deepEqual(versionMaterial({ situation: { value: 'D-05' }, level: { value: 3 } }), { situation: 'D-05', level: 3 });
});

test('a person’s status holds until the customer writes again', () => {
  const overrides = { status: { value: 'open', set_at: AT } };
  assert.equal(statusHeld(overrides, '2026-09-29T09:00:00.000Z'), true);
  assert.equal(statusHeld(overrides, null), true);
  assert.equal(statusHeld(overrides, '2026-09-29T11:00:00.000Z'), false);
  assert.equal(statusHeld({}, null), false);
});

test('a later second request replaces the corrected situation', () => {
  const overrides = { situation: { value: 'D-05', set_at: AT } };
  assert.equal(activeSituationOverride(overrides, { newIssueAt: null }).value, 'D-05');
  assert.equal(activeSituationOverride(overrides, { newIssueAt: '2026-09-29T09:00:00.000Z' }).value, 'D-05');
  assert.equal(activeSituationOverride(overrides, { newIssueAt: '2026-09-29T11:00:00.000Z' }), null);
});

test('the categoriser keeps a person’s value and records its own as ai_value', () => {
  const t = ticket({ overrides: { category: { value: 'delivery', ai_value: 'order', set_at: AT } } });
  const out = keepOverrides(t, { category: 'returns', level: 3 });
  assert.equal(out.columns.category, 'delivery');
  assert.equal(out.columns.level, 3);
  assert.equal(out.overrides.category.ai_value, 'returns');
  assert.deepEqual(keepOverrides(ticket(), { category: 'returns' }), { columns: { category: 'returns' }, overrides: null });
});

test('a category the investigation does not take is never queued, and the draft still goes stale', () => {
  // Stand-in for investigation-rules.mjs: forwarded (`contact`) and disabled subjects are out.
  const isInvestigable = (t) => t.request_kind !== 'contact' && t.category !== 'careers';
  const out = overrideChange({ ticket: ticket({ request_kind: 'question' }), changes: { category: 'careers' }, isInvestigable, at: AT });
  assert.equal(out.requeued, false);
  assert.equal(out.notInvestigable, true);
  assert.equal(out.versionChanged, true);
  assert.equal(out.columns.needs_investigation, undefined);
  // Asked of the ticket as it will be, so moving back INTO scope queues it.
  const back = overrideChange({ ticket: ticket({ category: 'careers', request_kind: 'question' }), changes: { category: 'order' }, isInvestigable, at: AT });
  assert.equal(back.requeued, true);
});
