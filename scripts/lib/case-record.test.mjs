import assert from 'node:assert/strict';
import test from 'node:test';

import { CASE_LINK_METHODS, createCaseRecord, issueFamiliesFrom } from './case-record.mjs';

/** Rows by table; filters are matched on plain equality and `in.(...)`. */
function fakeTransport(tables) {
  const calls = [];
  const matches = (row, filters) =>
    Object.entries(filters).every(([key, value]) => {
      if (value && typeof value === 'object') {
        if (value.operator === 'is') return row[key] === null || row[key] === undefined;
        if (value.operator === 'in') return value.value.slice(1, -1).split(',').map((v) => v.replaceAll('"', '')).includes(String(row[key]));
        return true;
      }
      return row[key] === value;
    });
  const select = async (_c, table, filters) => (tables[table] ?? []).filter((row) => matches(row, filters));
  return {
    calls,
    transport: {
      select,
      selectAll: select,
      insert: async (_c, table, rows) => {
        calls.push(['insert', table, rows]);
        const stored = rows.map((row, i) => ({ id: `${table}-${(tables[table]?.length ?? 0) + i + 1}`, ...row }));
        tables[table] = [...(tables[table] ?? []), ...stored];
        return stored;
      },
      updateById: async (_c, table, id, row) => {
        calls.push(['update', table, id, row]);
        for (const existing of tables[table] ?? []) if (existing.id === id) Object.assign(existing, row);
      },
      remove: async (_c, table, filters) => {
        calls.push(['delete', table, filters]);
        tables[table] = (tables[table] ?? []).filter((row) => !matches(row, filters));
      }
    }
  };
}

test('a link moves the thread, records the decision, and deletes the case it left', async () => {
  const tables = {
    tickets: [{ id: 'B', shop_id: 's', case_id: 'k-new', deleted_at: null }],
    cases: [{ id: 'k-new', shop_id: 's' }, { id: 'k-old', shop_id: 's' }]
  };
  const { transport, calls } = fakeTransport(tables);
  const moved = [];
  const tickets = {
    setCase: async (id, change) => {
      moved.push([id, change]);
      tables.tickets.find((t) => t.id === id).case_id = change.caseId;
    }
  };
  const record = createCaseRecord(null, { shopId: 's', tickets, transport });
  const result = await record.applyDecision({ ticketId: 'B', fromCaseId: 'k-new', toCaseId: 'k-old', method: 'order_family' });

  assert.deepEqual(result, { decision: 'link', caseId: 'k-old' });
  assert.deepEqual(moved, [['B', { caseId: 'k-old', state: 'decided', columns: {} }]]);
  const insert = calls.find(([kind, table]) => kind === 'insert' && table === 'case_links');
  assert.equal(insert[2][0].decision, 'link');
  assert.deepEqual(tables.cases.map((c) => c.id), ['k-old'], 'the emptied case is gone');
});

test('a new case keeps the thread where it is and deletes nothing', async () => {
  const tables = { tickets: [{ id: 'A', shop_id: 's', case_id: 'k1' }], cases: [{ id: 'k1', shop_id: 's' }] };
  const { transport } = fakeTransport(tables);
  const record = createCaseRecord(null, { shopId: 's', tickets: { setCase: async () => {} }, transport });
  const result = await record.applyDecision({ ticketId: 'A', fromCaseId: 'k1', toCaseId: 'k1', method: 'first_contact' });
  assert.deepEqual(result, { decision: 'new_case', caseId: 'k1' });
  assert.equal(tables.cases.length, 1);
  assert.equal(tables.case_links[0].decision, 'new_case');
});

test('an unknown method is refused before anything is written', async () => {
  const { transport, calls } = fakeTransport({});
  const record = createCaseRecord(null, { shopId: 's', tickets: { setCase: async () => {} }, transport });
  await assert.rejects(record.applyDecision({ ticketId: 'A', fromCaseId: 'k1', toCaseId: 'k1', method: 'vibes' }));
  assert.equal(calls.length, 0);
  assert.ok(CASE_LINK_METHODS.includes('model_off'));
});

test('the reply target is computed across threads and stored on the case', async () => {
  const tables = {
    tickets: [
      { id: 'A', shop_id: 's', case_id: 'k', deleted_at: null },
      { id: 'B', shop_id: 's', case_id: 'k', deleted_at: null }
    ],
    ticket_messages: [
      { id: 'a1', ticket_id: 'A', shop_id: 's', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T09:00:00Z', deleted_at: null },
      { id: 'a2', ticket_id: 'A', shop_id: 's', direction: 'outbound', actor: 'support', received_at: '2026-09-02T09:00:00Z', deleted_at: null },
      { id: 'b1', ticket_id: 'B', shop_id: 's', direction: 'inbound', actor: 'customer', received_at: '2026-09-10T09:00:00Z', deleted_at: null }
    ],
    cases: [{ id: 'k', shop_id: 's' }]
  };
  const { transport } = fakeTransport(tables);
  const record = createCaseRecord(null, { shopId: 's', transport });
  const target = await record.refreshTarget('k', { at: '2026-09-10T10:00:00Z' });
  assert.equal(target.messageId, 'b1');
  assert.equal(tables.cases[0].latest_actionable_inbound_message_id, 'b1');
  assert.equal(tables.cases[0].reply_thread_id, 'B');

  const conversation = await record.conversation('k');
  assert.deepEqual(conversation.map((m) => m.id), ['a1', 'a2', 'b1']);
});

test('the family tables become the shape the rules read', () => {
  assert.deepEqual(
    issueFamiliesFrom(
      [
        { member_kind: 'subject', member_key: 'delivery', family_key: 'DELIVERY' },
        { member_kind: 'situation', member_key: 'D-01', family_key: 'DELIVERY' }
      ],
      [{ from_family: 'DELIVERY', to_family: 'REFUND_RETURN' }]
    ),
    { subjects: { delivery: 'DELIVERY' }, situations: { 'D-01': 'DELIVERY' }, transitions: [['DELIVERY', 'REFUND_RETURN']] }
  );
});

test('a thread flagged as a duplicate never holds the target: the original is answered', async () => {
  const tables = {
    tickets: [
      { id: 'A', shop_id: 's', case_id: 'k', deleted_at: null, duplicate_of_ticket_id: null },
      { id: 'B', shop_id: 's', case_id: 'k', deleted_at: null, duplicate_of_ticket_id: 'A' }
    ],
    ticket_messages: [
      { id: 'a1', ticket_id: 'A', shop_id: 's', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T09:00:00Z', deleted_at: null },
      { id: 'b1', ticket_id: 'B', shop_id: 's', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T09:00:01Z', deleted_at: null }
    ],
    cases: [{ id: 'k', shop_id: 's' }]
  };
  const { transport } = fakeTransport(tables);
  const target = await createCaseRecord(null, { shopId: 's', transport }).refreshTarget('k');
  assert.equal(target.messageId, 'a1');
  assert.equal(tables.cases[0].reply_thread_id, 'A');
});
