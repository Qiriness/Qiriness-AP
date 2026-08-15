import assert from 'node:assert/strict';
import test from 'node:test';

import { attemptsSoFar, createTicketRecord, PASSES } from './ticket-record.mjs';
import { COLUMNS, T, V } from './tables.mjs';

/**
 * These assertions are about the PATCH BODIES, which is the whole reason the
 * ticket rules were pulled behind one interface. Before this module the same
 * claims could only be made by reading nine call sites and trusting they still
 * agreed with the comments above them.
 */

const SHOP = 'shop-1';

/** Records every call and answers reads from a queue of canned rows. */
function recordingTransport(answers = {}) {
  const calls = [];
  const answer = (kind, table) => {
    const key = `${kind}:${table}`;
    const queued = answers[key];
    if (Array.isArray(queued)) return queued;
    return [];
  };
  return {
    calls,
    select(_client, table, filters, columns, options) {
      calls.push({ kind: 'select', table, filters, columns, options });
      return Promise.resolve(answer('select', table));
    },
    selectAll(_client, table, filters, columns, options) {
      calls.push({ kind: 'selectAll', table, filters, columns, options });
      return Promise.resolve(answer('select', table));
    },
    insert(_client, table, rows) {
      calls.push({ kind: 'insert', table, rows });
      return Promise.resolve(rows.map((row, i) => ({ id: `new-${i}`, ...row })));
    },
    update(_client, table, filters, columns, options) {
      calls.push({ kind: 'update', table, filters, columns, options });
      return Promise.resolve([{ id: filters.id ?? 'updated' }]);
    },
    updateById(_client, table, id, columns) {
      calls.push({ kind: 'updateById', table, id, columns });
      return Promise.resolve({ id, ...columns });
    }
  };
}

const build = (answers) => {
  const transport = recordingTransport(answers);
  return { transport, record: createTicketRecord({}, { shopId: SHOP, transport }) };
};

const lastPatch = (transport) => [...transport.calls].reverse().find((c) => c.kind === 'updateById').columns;

test('a record cannot be built without a shop', () => {
  // Tenant scoping is bound once, here, rather than remembered at 60 call sites.
  assert.throws(() => createTicketRecord({}, { shopId: null }), /requires a shopId/);
});

test('an unknown pass name fails loudly instead of writing a column called undefined', async () => {
  // Rejects rather than throws: the protocol methods are async, so the guard
  // surfaces as a rejected promise. Either way it fails before the patch is
  // built — `{ undefined: false }` would be accepted by PostgREST as a no-op.
  const { transport, record } = build();
  await assert.rejects(() => record.skip('drafting', 't1'), /Unknown ticket pass: drafting/);
  await assert.rejects(() => record.claim('drafting'), /Unknown ticket pass: drafting/);
  assert.equal(transport.calls.length, 0);
});

test('claim selects on the flag, excluding deleted and archived tickets', async () => {
  const { transport, record } = build();
  await record.claim('investigation', { limit: 25 });

  const call = transport.calls.at(-1);
  assert.equal(call.table, T.TICKETS);
  assert.deepEqual(call.filters.shop_id, SHOP);
  assert.deepEqual(call.filters.needs_investigation, { operator: 'is', value: 'true' });
  // The pass's own precondition, carried by the descriptor rather than retyped.
  assert.deepEqual(call.filters.needs_categorisation, { operator: 'is', value: 'false' });
  assert.deepEqual(call.filters.deleted_at, { operator: 'is', value: 'null' });
  assert.deepEqual(call.filters.archived_at, { operator: 'is', value: 'null' });
  assert.equal(call.filters.status, 'open');
  assert.equal(call.columns, COLUMNS.ticketForInvestigation);
  // Oldest first: a support queue is served in arrival order.
  assert.equal(call.options.order, 'first_message_at.asc');
  assert.equal(call.options.limit, 25);
});

test('complete clears this pass\'s flag and raises the next one in the SAME patch', async () => {
  // The crash-safety rule, asserted rather than commented: if these two columns
  // could land in separate writes, a failure between them would either lose the
  // ticket or double-process it.
  const { transport, record } = build();
  await record.complete('categorisation', { id: 't1', metadata: {} }, {
    columns: { category: 'delivery', level: 2 },
    trail: { model: 'gpt', reason: 'because' }
  });

  const columns = lastPatch(transport);
  assert.equal(columns.needs_categorisation, false);
  assert.equal(columns.needs_investigation, true);
  assert.equal(columns.category, 'delivery');
  assert.ok(columns.categorised_at, 'the stamp is written by the protocol, not the caller');
});

test('complete resets the failure counters — a success starts the next cycle clean', async () => {
  const { transport, record } = build();
  await record.complete('investigation', {
    id: 't1',
    metadata: { investigation: { attempts: 2, last_error: 'boom', failed: true } }
  }, { trail: { verdict: 'answerable' } });

  const { metadata } = lastPatch(transport);
  assert.equal(metadata.investigation.attempts, 0);
  assert.equal(metadata.investigation.last_error, null);
  assert.equal(metadata.investigation.failed, null);
  assert.equal(metadata.investigation.verdict, 'answerable');
});

test('the investigation raises nothing — it is the last flagged pass', async () => {
  const { transport, record } = build();
  await record.complete('investigation', { id: 't1', metadata: {} }, {});

  const columns = lastPatch(transport);
  assert.equal(columns.needs_investigation, false);
  assert.ok(!('needs_categorisation' in columns), 'the investigation must not re-queue the categoriser');
});

test('the trail is merged, never replaced — one jsonb column has three writers', async () => {
  const { transport, record } = build();
  await record.retry('categorisation', {
    id: 't1',
    metadata: {
      customer_resolution: { status: 'matched' },
      investigation: { verdict: 'needs_human' },
      closed_reason: 'inactivity'
    }
  }, { attempts: 1, error: new Error('rate limited') });

  const { metadata } = lastPatch(transport);
  assert.equal(metadata.customer_resolution.status, 'matched');
  assert.equal(metadata.investigation.verdict, 'needs_human');
  assert.equal(metadata.closed_reason, 'inactivity');
  assert.equal(metadata.categorisation.attempts, 1);
  assert.equal(metadata.categorisation.last_error, 'rate limited');
});

test('retry leaves the flag up, so the ticket stays in the queue', async () => {
  const { transport, record } = build();
  await record.retry('investigation', { id: 't1', metadata: {} }, { attempts: 1, error: new Error('x') });

  const columns = lastPatch(transport);
  assert.ok(!('needs_investigation' in columns));
  assert.deepEqual(Object.keys(columns), ['metadata']);
});

test('abandon clears the flag but never raises the next one', async () => {
  // Investigating a guess would spend tool and model calls on a subject nobody
  // chose — both failure branches land the ticket in front of a human instead.
  const { transport, record } = build();
  await record.abandon('categorisation', { id: 't1', metadata: {} }, {
    columns: { categorisation_confidence: 'low', category: 'other' },
    attempts: 3,
    error: new Error('gave up')
  });

  const columns = lastPatch(transport);
  assert.equal(columns.needs_categorisation, false);
  assert.ok(!('needs_investigation' in columns), 'a failed categorisation must not queue an investigation');
  assert.equal(columns.categorisation_confidence, 'low');
  assert.equal(columns.metadata.categorisation.failed, true);
  assert.equal(columns.metadata.categorisation.attempts, 3);
});

test('skip clears the flag and writes nothing else', async () => {
  // No stamp and no trail: nothing happened to record, and the flag comes back
  // by itself the moment ingestion adds an inbound message.
  const { transport, record } = build();
  await record.skip('categorisation', 't1');

  assert.deepEqual(lastPatch(transport), { needs_categorisation: false });
});

test('attemptsSoFar reads the right trail per pass', () => {
  const metadata = { categorisation: { attempts: 2 }, investigation: { attempts: 5 } };
  assert.equal(attemptsSoFar(metadata, 'categorisation'), 2);
  assert.equal(attemptsSoFar(metadata, 'investigation'), 5);
  assert.equal(attemptsSoFar({}, 'categorisation'), 0);
  assert.equal(attemptsSoFar(undefined, 'investigation'), 0);
  assert.equal(attemptsSoFar({ categorisation: { attempts: 'two' } }, 'categorisation'), 0);
});

test('raiseFor only re-queues tickets both passes have finished with', async () => {
  const { transport, record } = build({ 'select:tickets': [{ id: 't1' }, { id: 't2' }] });
  const count = await record.raiseFor('investigation', { where: { category: { operator: 'in', value: '(delivery)' } } });

  assert.equal(count, 2);
  const write = transport.calls.find((c) => c.kind === 'update');
  assert.deepEqual(write.columns, { needs_investigation: true });
  assert.deepEqual(write.filters.needs_categorisation, { operator: 'is', value: 'false' });
  assert.deepEqual(write.filters.needs_investigation, { operator: 'is', value: 'false' });
  assert.equal(write.filters.shop_id, SHOP);
});

test('raiseFor writes nothing on a dry run', async () => {
  const { transport, record } = build({ 'select:tickets': [{ id: 't1' }] });
  const count = await record.raiseFor('investigation', { dryRun: true });

  assert.equal(count, 1);
  assert.ok(!transport.calls.some((c) => c.kind === 'update'), 'a dry run must not write');
});

test('every read excludes soft-deleted tickets', async () => {
  // A compliance delete must not reach any caller, including one added later
  // that forgot to filter.
  const { transport, record } = build();
  await record.findUnlinkedCustomers();
  await record.findAwaitingOrderNumber();
  await record.findAwaitingContext();
  await record.findInactive(new Date('2026-01-01T00:00:00Z'));
  await record.findForDetail('t1');
  await record.findSubject('t1');

  const ticketReads = transport.calls.filter((c) => c.table === T.TICKETS && c.kind !== 'updateById');
  assert.equal(ticketReads.length, 6);
  for (const call of ticketReads) {
    assert.deepEqual(call.filters.deleted_at, { operator: 'is', value: 'null' }, JSON.stringify(call.columns));
    assert.equal(call.filters.shop_id, SHOP);
  }
});

test('findAwaitingContext widens to every ordered ticket when refreshing', async () => {
  const { transport, record } = build();
  await record.findAwaitingContext();
  assert.deepEqual(transport.calls.at(-1).filters.context_resolved_at, { operator: 'is', value: 'null' });

  await record.findAwaitingContext({ refresh: true });
  assert.ok(!('context_resolved_at' in transport.calls.at(-1).filters));
});

test('findInactive narrows status and date in the query, never level', async () => {
  // PostgREST's not.eq on a nullable column drops the NULL rows too, which would
  // silently spare every uncategorised ticket. The level exemption is policy and
  // stays in shouldAutoClose.
  const { transport, record } = build();
  await record.findInactive(new Date('2026-08-01T00:00:00Z'));

  const { filters, columns } = transport.calls.at(-1);
  assert.deepEqual(filters.status, { operator: 'not.in', value: '(resolved,closed)' });
  assert.deepEqual(filters.last_message_at, { operator: 'lt', value: '2026-08-01T00:00:00.000Z' });
  assert.ok(!('level' in filters));
  assert.match(columns, /needs_categorisation/);
});

test('close stamps the reason at the top level, not inside a pass trail', async () => {
  const { transport, record } = build();
  await record.close({ id: 't1', metadata: { categorisation: { model: 'gpt' } } }, new Date('2026-08-15T10:00:00Z'));

  const columns = lastPatch(transport);
  assert.equal(columns.status, 'closed');
  assert.equal(columns.closed_at, '2026-08-15T10:00:00.000Z');
  assert.equal(columns.metadata.closed_reason, 'inactivity');
  assert.equal(columns.metadata.categorisation.model, 'gpt', 'closing must not drop another writer\'s key');
});

test('reopening clears both lifecycle timestamps', async () => {
  // Or a reopened ticket still reads as finished to anything looking at
  // closed_at rather than at status.
  const { transport, record } = build({ 'select:ticket_queue': [{ id: 't1' }] });
  await record.setStatus('t1', 'open');

  const write = transport.calls.find((c) => c.kind === 'update');
  assert.equal(write.columns.status, 'open');
  assert.equal(write.columns.closed_at, null);
  assert.equal(write.columns.resolved_at, null);
});

test('setStatus scopes by shop as well as id, and returns the queue row', async () => {
  const { transport, record } = build({ 'select:ticket_queue': [{ id: 't1', message_count: 3 }] });
  const row = await record.setStatus('t1', 'closed');

  const write = transport.calls.find((c) => c.kind === 'update');
  // An id alone would let one shop's request touch another's row.
  assert.equal(write.filters.shop_id, SHOP);
  assert.equal(write.columns.closed_at, write.columns.updated_at);

  // The row that replaces the one on screen comes back in the SHAPE the list
  // renders — read from the view, not assembled from the update.
  const read = transport.calls.at(-1);
  assert.equal(read.table, V.TICKET_QUEUE);
  assert.equal(read.columns, COLUMNS.ticketQueue);
  assert.equal(row.message_count, 3);
});

test('setStatus answers null for a ticket that is not this shop\'s', async () => {
  const transport = recordingTransport();
  transport.update = () => Promise.resolve([]);
  const record = createTicketRecord({}, { shopId: SHOP, transport });

  assert.equal(await record.setStatus('someone-elses', 'closed'), null);
});

test('an empty message-arrival patch is not sent at all', async () => {
  const { transport, record } = build();
  assert.equal(await record.recordMessageArrival('t1', {}), null);
  assert.equal(await record.recordMessageArrival('t1', undefined), null);
  assert.equal(transport.calls.length, 0);
});

test('linkCustomer records the attempt whether or not it matched', async () => {
  const { transport, record } = build();
  await record.linkCustomer({ id: 't1', metadata: {} }, {
    customerId: null,
    status: 'no_match',
    matchedBy: null,
    emailHash: 'abc',
    attemptedAt: '2026-08-15T10:00:00Z'
  });

  const columns = lastPatch(transport);
  assert.ok(!('customer_id' in columns), 'a miss must not write a null over an existing link');
  assert.equal(columns.metadata.customer_resolution.status, 'no_match');
  assert.equal(columns.metadata.customer_resolution.email_hash, 'abc');
});

test('setResolvedContext backfills customer_id only when the ticket has none', async () => {
  const { transport, record } = build();
  await record.setResolvedContext({ id: 't1', customer_id: 'existing' }, { order: {} }, 'from-order');
  assert.ok(!('customer_id' in lastPatch(transport)));

  await record.setResolvedContext({ id: 't2', customer_id: null }, { order: {} }, 'from-order');
  assert.equal(lastPatch(transport).customer_id, 'from-order');
});

test('firstInboundByTicket reads the view, one row per ticket', async () => {
  const { transport, record } = build({
    'select:ticket_first_inbound': [
      { ticket_id: 't1', subject: 'Commande', body_text: '#4854' },
      { ticket_id: 't2', subject: null, body_text: 'bonjour' }
    ]
  });
  const byTicket = await record.firstInboundByTicket();

  assert.equal(transport.calls.at(-1).table, V.TICKET_FIRST_INBOUND);
  assert.equal(byTicket.get('t1'), 'Commande\n#4854');
  // A missing subject must not produce the string "null" in front of the body.
  assert.equal(byTicket.get('t2'), '\nbonjour');
});

test('inboundMessages defaults to the categoriser\'s columns and never ships a vector by accident', async () => {
  const { transport, record } = build();
  await record.inboundMessages('t1', { limit: 5 });

  const call = transport.calls.at(-1);
  assert.equal(call.columns, COLUMNS.messageForCategorisation);
  assert.ok(!call.columns.includes('embedding'));
  assert.equal(call.filters.direction, 'inbound');
  assert.deepEqual(call.filters.deleted_at, { operator: 'is', value: 'null' });
  assert.equal(call.options.order, 'received_at.asc');
});

test('the pass descriptors name real columns', () => {
  // A typo here would silently never match a ticket, which reads as "the queue
  // is empty" rather than as a bug.
  for (const [name, pass] of Object.entries(PASSES)) {
    assert.match(pass.flag, /^needs_/, `${name}.flag`);
    assert.ok(pass.columns.split(',').includes('id'), `${name} must read the id it patches`);
    assert.ok(pass.columns.split(',').includes('metadata'), `${name} must read the trail it merges into`);
    if (pass.raises) assert.ok(PASSES[Object.keys(PASSES).find((k) => PASSES[k].flag === pass.raises)]);
  }
});
