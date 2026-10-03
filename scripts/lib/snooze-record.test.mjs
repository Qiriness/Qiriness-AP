import assert from 'node:assert/strict';
import test from 'node:test';

import { toParameterMap } from './parameters.mjs';
import { createSnoozeRecord, fallbackWakeAt, snoozeRow, wakeReasonForActor } from './snooze-record.mjs';
import { T } from './tables.mjs';
import { addWorkingDays } from './working-days.mjs';

const NOW = new Date('2026-09-30T10:00:00Z'); // a Wednesday

test('working days skip the weekend and keep the time of day', () => {
  assert.equal(addWorkingDays('2026-10-02T15:00:00Z', 1).toISOString(), '2026-10-05T15:00:00.000Z'); // Fri → Mon
  assert.equal(addWorkingDays('2026-10-03T09:00:00Z', 2).toISOString(), '2026-10-06T09:00:00.000Z'); // Sat → Tue
  assert.equal(addWorkingDays(NOW, 0).toISOString(), NOW.toISOString());
  assert.equal(addWorkingDays('nonsense', 2), null);
  assert.equal(addWorkingDays(NOW, 1.5), null);
});

test('the deadline comes from the shop, and an unset delay means no automatic snooze', () => {
  const parameters = toParameterMap([
    { parameter_key: 'customer_reply_wait_days', value: '5' },
    { parameter_key: 'partner_check_overdue_days', value: '3' }
  ]);
  assert.equal(fallbackWakeAt({ waitingFor: 'customer', from: NOW, parameters }).toISOString(), '2026-10-07T10:00:00.000Z');
  assert.equal(fallbackWakeAt({ waitingFor: 'partner', from: NOW, parameters }).toISOString(), '2026-10-05T10:00:00.000Z');
  assert.equal(fallbackWakeAt({ waitingFor: 'colleague', from: NOW, parameters }), null);
  assert.equal(fallbackWakeAt({ waitingFor: 'date', from: NOW, parameters }), null);
  const zero = toParameterMap([{ parameter_key: 'customer_reply_wait_days', value: '0' }]);
  assert.equal(fallbackWakeAt({ waitingFor: 'customer', from: NOW, parameters: zero }), null);
});

test('a snooze row carries its deadline, and says why when it cannot be written', () => {
  const { row } = snoozeRow({
    ticketId: 't1',
    source: 'manual',
    waitingFor: 'partner',
    wakeAt: '2026-10-02T09:00:00Z',
    reason: '  Waiting for Deret investigation  ',
    snoozedBy: 'user-1',
    now: NOW
  });
  assert.deepEqual(row, {
    ticket_id: 't1',
    source: 'manual',
    waiting_for: 'partner',
    reason: 'Waiting for Deret investigation',
    wake_at: '2026-10-02T09:00:00.000Z',
    trigger_message_id: null,
    case_version: null,
    snoozed_by: 'user-1'
  });
  const base = { ticketId: 't1', source: 'manual', waitingFor: 'date', wakeAt: '2026-10-01T09:00:00Z', now: NOW };
  assert.equal(snoozeRow({ ...base, wakeAt: null }).error, 'no_wake_at');
  assert.equal(snoozeRow({ ...base, wakeAt: '2026-09-29T09:00:00Z' }).error, 'wake_in_past');
  assert.equal(snoozeRow({ ...base, wakeAt: '2027-01-30T09:00:00Z' }).error, 'too_far');
  assert.equal(snoozeRow({ ...base, waitingFor: 'deret' }).error, 'bad_waiting_for');
  assert.equal(snoozeRow({ ...base, source: 'model' }).error, 'bad_source');
  assert.equal(snoozeRow({ ...base, source: 'auto' }).error, 'no_trigger');
});

test('only a message from someone else wakes a ticket', () => {
  assert.equal(wakeReasonForActor('customer'), 'customer_message');
  assert.equal(wakeReasonForActor('partner'), 'partner_message');
  assert.equal(wakeReasonForActor('colleague'), 'colleague_message');
  assert.equal(wakeReasonForActor('support'), null);
});

function recorder({ insertError = null, selectRows = [], updated = [{ id: 's1' }] } = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      async insert(_c, table, rows) {
        calls.push({ kind: 'insert', table, rows });
        if (insertError) throw insertError;
        return rows.map((r) => ({ id: 's1', ...r }));
      },
      async select(_c, table, filters) {
        calls.push({ kind: 'select', table, filters });
        return selectRows;
      },
      async update(_c, table, filters, patch) {
        calls.push({ kind: 'update', table, filters, patch });
        return updated;
      }
    }
  };
}

test('a ticket already snoozed collides with the index and gets the open snooze back', async () => {
  const rec = recorder({
    insertError: new Error('duplicate key value violates unique constraint "ticket_snoozes_open_key"'),
    selectRows: [{ id: 's-open' }]
  });
  const record = createSnoozeRecord({}, { shopId: 'shop-1', transport: rec.transport });
  const result = await record.snooze(snoozeRow({ ticketId: 't1', source: 'manual', waitingFor: 'date', wakeAt: '2026-10-01T09:00:00Z', now: NOW }).row);
  assert.deepEqual(result, { created: false, snooze: { id: 's-open' } });
});

test('any other insert error is not swallowed', async () => {
  const rec = recorder({ insertError: new Error('HTTP 500') });
  const record = createSnoozeRecord({}, { shopId: 'shop-1', transport: rec.transport });
  await assert.rejects(record.snooze({ ticket_id: 't1' }), /HTTP 500/);
});

test('a wake is conditional on the snooze being open, and names why', async () => {
  const rec = recorder();
  const record = createSnoozeRecord({}, { shopId: 'shop-1', transport: rec.transport });
  assert.deepEqual(await record.wake('t1', 'customer_message', { at: NOW }), { id: 's1' });
  const [call] = rec.calls;
  assert.equal(call.table, T.TICKET_SNOOZES);
  assert.deepEqual(call.filters, { shop_id: 'shop-1', ticket_id: 't1', woke_at: { operator: 'is', value: 'null' } });
  assert.deepEqual(call.patch, { woke_at: NOW.toISOString(), wake_reason: 'customer_message', woken_by: null });
  await assert.rejects(record.wake('t1', 'felt_like_it'), /customer_message/);
});

test('a retarget rewrites only an open automatic snooze, in place, and refuses a bad party or deadline', async () => {
  const rec = recorder({ updated: [{ id: 's1', waiting_for: 'partner' }] });
  const record = createSnoozeRecord({}, { shopId: 'shop-1', transport: rec.transport });
  const result = await record.retarget('s1', { waitingFor: 'partner', wakeAt: '2026-10-05T10:00:00Z', caseVersion: 4, now: NOW });
  assert.deepEqual(result, { id: 's1', waiting_for: 'partner' });
  const [call] = rec.calls;
  assert.equal(call.kind, 'update');
  assert.deepEqual(call.filters, { shop_id: 'shop-1', id: 's1', source: 'auto', woke_at: { operator: 'is', value: 'null' } });
  assert.deepEqual(call.patch, { waiting_for: 'partner', wake_at: '2026-10-05T10:00:00.000Z', case_version: 4 });

  await assert.rejects(record.retarget('s1', { waitingFor: 'date', wakeAt: '2026-10-05T10:00:00Z', now: NOW }), /customer, colleague or partner/);
  await assert.rejects(record.retarget('s1', { waitingFor: 'partner', wakeAt: '2026-09-29T10:00:00Z', now: NOW }), /after now/);
  await assert.rejects(record.retarget('s1', { waitingFor: 'partner', wakeAt: '2027-01-30T10:00:00Z', now: NOW }), /60 days/);
  // Woken or made manual meanwhile: nothing matched, nothing changed.
  const gone = createSnoozeRecord({}, { shopId: 'shop-1', transport: recorder({ updated: [] }).transport });
  assert.equal(await gone.retarget('s1', { waitingFor: 'partner', wakeAt: '2026-10-05T10:00:00Z', now: NOW }), null);
});

test('waking a ticket that is not snoozed is a no-op, not an error', async () => {
  const record = createSnoozeRecord({}, { shopId: 'shop-1', transport: recorder({ updated: [] }).transport });
  assert.equal(await record.wake('t1', 'deadline'), null);
});
