import assert from 'node:assert/strict';
import test from 'node:test';

import { runWakeDue } from './snooze-wake.mjs';
import { shouldAutoClose } from './auto-close.mjs';

const NOW = new Date('2026-09-30T10:00:00Z');

function fakeSnoozes(due, { wakes = true, failOn = null } = {}) {
  const woken = [];
  return {
    woken,
    async due() { return due; },
    async wake(ticketId, reason, options) {
      if (ticketId === failOn) throw new Error('timeout');
      woken.push({ ticketId, reason, ...options });
      return wakes ? { id: 's' } : null;
    }
  };
}

test('every snooze past its deadline is woken with « deadline », by the agent', async () => {
  const snoozes = fakeSnoozes([{ ticket_id: 't1' }, { ticket_id: 't2' }]);
  const totals = await runWakeDue({ snoozes, shopId: 's', now: NOW });
  assert.deepEqual(totals, { due: 2, woken: 2, failed: 0 });
  assert.deepEqual(snoozes.woken[0], { ticketId: 't1', reason: 'deadline', wokenBy: 'agent', at: NOW });
});

test('a snooze a message woke meanwhile is not counted twice, and one failure does not stop the rest', async () => {
  assert.deepEqual(await runWakeDue({ snoozes: fakeSnoozes([{ ticket_id: 't1' }], { wakes: false }), shopId: 's', now: NOW }), { due: 1, woken: 0, failed: 0 });
  const snoozes = fakeSnoozes([{ ticket_id: 'bad' }, { ticket_id: 't2' }], { failOn: 'bad' });
  assert.deepEqual(await runWakeDue({ snoozes, shopId: 's', now: NOW }), { due: 2, woken: 1, failed: 1 });
});

test('a snoozed ticket is not closed for silence', () => {
  const stale = { id: 't1', status: 'awaiting_customer', level: 2, last_message_at: '2026-08-01T00:00:00Z' };
  assert.equal(shouldAutoClose(stale, { now: NOW }), true);
  assert.equal(shouldAutoClose(stale, { now: NOW, snoozed: true }), false);
});
