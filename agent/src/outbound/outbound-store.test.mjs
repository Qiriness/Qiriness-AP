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

test('orderMoved compares the bundle’s material signature with the order’s, and refuses only on evidence', async () => {
  const { orderSignatureHash } = await import('../../../scripts/lib/order-signature.mjs');
  const unfulfilled = { name: '#7093', fulfillment_status: 'UNFULFILLED', financial_status: 'PAID', tracking_numbers: [], fulfillments: [] };
  const fulfilled = { ...unfulfilled, fulfillment_status: 'FULFILLED', tracking_numbers: ['TEST'] };
  const storeFor = (ticket, order) =>
    createOutboundStore(null, { shopId: 's', select: async (_c, table) => (table === 'tickets' ? [ticket] : order ? [order] : []) });

  const built = { shopify_order_number: '#7093', signature: orderSignatureHash(unfulfilled) };
  assert.equal(await storeFor(built, fulfilled).orderMoved('t1'), true);
  assert.equal(await storeFor(built, unfulfilled).orderMoved('t1'), false);
  // A bundle from before the signature, no order, or an order no longer stored: not moved.
  assert.equal(await storeFor({ ...built, signature: null }, fulfilled).orderMoved('t1'), false);
  assert.equal(await storeFor({ shopify_order_number: null, signature: null }, fulfilled).orderMoved('t1'), false);
  assert.equal(await storeFor(built, null).orderMoved('t1'), false);
});
