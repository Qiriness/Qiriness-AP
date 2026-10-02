import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutboundStore } from './outbound-store.mjs';

test('messages after the reply target are read across every thread of the case', async () => {
  const calls = [];
  const select = async (_client, table, filters) => {
    calls.push([table, filters]);
    if (table === 'tickets' && filters.id) return [{ id: 'B', case_id: 'k1' }];
    if (table === 'tickets' && filters.case_id) return [{ id: 'A' }, { id: 'B' }];
    return [{ id: 'a9', ticket_id: 'A', direction: 'inbound', actor: 'customer' }];
  };
  const store = createOutboundStore(null, { shopId: 's', select });
  const later = await store.messagesAfter('B', '2026-09-10T09:00:00Z');
  assert.deepEqual(later.map((m) => m.id), ['a9']);
  const messageRead = calls.find(([table]) => table === 'ticket_messages')[1];
  assert.deepEqual(messageRead.ticket_id, { operator: 'in', value: '(B,A)' });
});

test('a ticket with no case reads its own thread, as before', async () => {
  const select = async (_client, table, filters) => (table === 'tickets' ? [{ id: 'B', case_id: null }] : [filters]);
  const store = createOutboundStore(null, { shopId: 's', select });
  const [filters] = await store.messagesAfter('B', '2026-09-10T09:00:00Z');
  assert.equal(filters.ticket_id, 'B');
});
