import assert from 'node:assert/strict';
import test from 'node:test';

import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';

import { createMemoryTransport } from './memory-transport.mjs';

const SHOP = 'shop-1';

const ticket = (overrides = {}) => ({
  id: 't1',
  shop_id: SHOP,
  subject: 'Ma commande',
  status: 'open',
  needs_categorisation: true,
  needs_investigation: false,
  category: null,
  request_kind: null,
  level: null,
  happiness: null,
  customer_id: null,
  requester_email_hash: 'hash-1',
  shopify_order_number: null,
  resolved_context: null,
  context_resolved_at: null,
  duplicate_of_ticket_id: null,
  first_message_at: '2026-08-01T00:00:00.000Z',
  archived_at: null,
  deleted_at: null,
  metadata: {},
  ...overrides
});

// --- the filter vocabulary ----------------------------------------------------

test('it matches the operators the passes actually use', async () => {
  const transport = createMemoryTransport({
    [T.TICKETS]: [
      ticket({ id: 'a', level: 1 }),
      ticket({ id: 'b', level: 4, status: 'closed', needs_categorisation: false }),
      ticket({ id: 'c', level: null, deleted_at: '2026-08-01T00:00:00.000Z' })
    ]
  });

  const open = await transport.select(null, T.TICKETS, {
    shop_id: SHOP,
    status: 'open',
    deleted_at: { operator: 'is', value: 'null' },
    needs_categorisation: { operator: 'is', value: 'true' }
  }, 'id');
  assert.deepEqual(open, [{ id: 'a' }]);

  const withLevel = await transport.select(null, T.TICKETS, {
    level: { operator: 'not.is', value: 'null' }
  }, 'id');
  assert.deepEqual(withLevel.map((row) => row.id), ['a', 'b']);

  const inList = await transport.select(null, T.TICKETS, {
    id: { operator: 'in', value: '(a,c)' }
  }, 'id');
  assert.deepEqual(inList.map((row) => row.id), ['a', 'c']);
});

test('a null column satisfies is.false, as PostgREST does not', async () => {
  // Deliberate, and the reason it is written down: `needs_investigation` is
  // `not null default false` in the DDL, so a real row is never null here. A
  // synthetic ticket that forgot the key would otherwise silently drop out of
  // every queue, which is the failure this transport exists to make impossible.
  const transport = createMemoryTransport({ [T.TICKETS]: [{ id: 'a', needs_investigation: null }] });
  const rows = await transport.select(null, T.TICKETS, {
    needs_investigation: { operator: 'is', value: 'false' }
  }, 'id');
  assert.deepEqual(rows, [{ id: 'a' }]);
});

test('an operator it does not implement is a loud failure, never an empty queue', async () => {
  // The whole point. A silent "no rows" for an unknown filter looks exactly like
  // a pass with nothing to do — in a tool whose only job is showing what the
  // passes did.
  const transport = createMemoryTransport({ [T.TICKETS]: [ticket()] });
  await assert.rejects(
    () => transport.select(null, T.TICKETS, { level: { operator: 'like', value: '%1%' } }, 'id'),
    /operator "like" is not implemented/
  );
});

test('it honours the projection instead of returning the whole row', async () => {
  // A pass that reads a column its projection does not select works here and
  // fails against PostgREST, which is precisely backwards.
  const transport = createMemoryTransport({ [T.TICKETS]: [ticket()] });
  const [row] = await transport.select(null, T.TICKETS, { id: 't1' }, 'id,subject');
  assert.deepEqual(row, { id: 't1', subject: 'Ma commande' });
});

test('it refuses an embedded select rather than inventing a join', async () => {
  const transport = createMemoryTransport({ [T.TICKETS]: [ticket()] });
  await assert.rejects(
    () => transport.select(null, T.TICKETS, {}, 'id,customers(display_name)'),
    /embedded selects are not implemented/
  );
});

test('ordering and limits behave as the queue expects', async () => {
  const transport = createMemoryTransport({
    [T.TICKETS]: [
      ticket({ id: 'new', first_message_at: '2026-08-10T00:00:00.000Z' }),
      ticket({ id: 'old', first_message_at: '2026-08-01T00:00:00.000Z' })
    ]
  });
  const rows = await transport.select(null, T.TICKETS, {}, 'id', {
    order: 'first_message_at.asc',
    limit: 1
  });
  assert.deepEqual(rows, [{ id: 'old' }]);
});

test('upsert merges on the conflict key rather than accumulating rows', async () => {
  // The case-file store's idempotency key. Getting this wrong would let a
  // rehearsal produce two investigations for one message, which live it cannot.
  const transport = createMemoryTransport();
  await transport.upsert(null, T.TICKET_INVESTIGATIONS, [
    { shop_id: SHOP, trigger_message_id: 'm1', verdict: 'needs_human' }
  ], 'shop_id,trigger_message_id');
  const [second] = await transport.upsert(null, T.TICKET_INVESTIGATIONS, [
    { shop_id: SHOP, trigger_message_id: 'm1', verdict: 'answerable' }
  ], 'shop_id,trigger_message_id');

  assert.equal(transport.rows(T.TICKET_INVESTIGATIONS).length, 1);
  assert.equal(transport.rows(T.TICKET_INVESTIGATIONS)[0].verdict, 'answerable');
  // An id is issued on insert and kept on merge, because the draft references it.
  assert.ok(second.id);
});

// --- the substitution this module exists for ----------------------------------

test('the REAL ticket record drives a whole pass cycle over it', async () => {
  // THIS IS THE ASSERTION THE FEATURE RESTS ON. The rehearsal does not
  // reimplement the pass protocol — it swaps the database under
  // `ticket-record.mjs` and runs the worker's own code. If that substitution
  // works, every flag transition, filter and metadata trail in a rehearsal is
  // the worker's; if it does not, this fails here rather than in a transcript
  // that quietly skipped a pass.
  const transport = createMemoryTransport({ [T.TICKETS]: [ticket()] });
  const record = createTicketRecord(null, { shopId: SHOP, transport });

  // 1. The categoriser's queue sees it.
  const claimed = await record.claim('categorisation', { limit: 25 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, 't1');
  // The projection is honoured, so a pass cannot read what it did not select.
  assert.deepEqual(Object.keys(claimed[0]).sort(), COLUMNS.ticketForCategorisation.split(',').sort());

  // 2. The investigation's queue does NOT, because the labels are still pending.
  assert.deepEqual(await record.claim('investigation', { limit: 25 }), []);

  // 3. Completing categorisation clears one flag and raises the next, in one write.
  await record.complete('categorisation', claimed[0], {
    columns: { category: 'delivery', request_kind: 'problem', level: 2 },
    trail: { model: 'test', runs: 1 }
  });
  const after = transport.rows(T.TICKETS)[0];
  assert.equal(after.needs_categorisation, false);
  assert.equal(after.needs_investigation, true);
  assert.ok(after.categorised_at);
  assert.equal(after.metadata.categorisation.model, 'test');
  assert.equal(after.metadata.categorisation.attempts, 0);

  // 4. Which is exactly what puts it in the investigation's queue.
  const investigable = await record.claim('investigation', { limit: 25 });
  assert.equal(investigable.length, 1);
  assert.equal(investigable[0].category, 'delivery');

  // 5. And the passes that run off ticket state, not flags, see it too.
  assert.equal((await record.findUnlinkedCustomers()).length, 1);
  assert.equal((await record.findAwaitingOrderNumber()).length, 1);
  assert.equal((await record.findAwaitingContext()).length, 0, 'no order number yet');

  await record.linkOrder('t1', { shopify_order_number: '#1006' });
  assert.equal((await record.findAwaitingContext()).length, 1);
});

test('a retry leaves the ticket in the queue and an abandon takes it out', async () => {
  const transport = createMemoryTransport({ [T.TICKETS]: [ticket()] });
  const record = createTicketRecord(null, { shopId: SHOP, transport });
  const [claimed] = await record.claim('categorisation', { limit: 1 });

  await record.retry('categorisation', claimed, { attempts: 1, error: new Error('boom') });
  assert.equal(transport.rows(T.TICKETS)[0].needs_categorisation, true, 'still queued');
  assert.equal(transport.rows(T.TICKETS)[0].metadata.categorisation.attempts, 1);

  await record.abandon('categorisation', claimed, {
    columns: { categorisation_confidence: 'low' },
    attempts: 3,
    error: new Error('boom')
  });
  const after = transport.rows(T.TICKETS)[0];
  assert.equal(after.needs_categorisation, false);
  // Never raises the next flag: investigating a guess spends calls on a subject
  // nobody chose.
  assert.equal(after.needs_investigation, false);
  assert.equal(after.metadata.categorisation.failed, true);
});
