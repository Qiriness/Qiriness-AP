import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BY_PERSON,
  describeOrderMatch,
  manualOrderColumns,
  parseOrderNumber,
  reinvestigationColumns,
  sameOrder
} from './order-link.mjs';

const ORDER = { id: 'o1', name: '#6669', order_number: 6669, customer_id: 'c1' };
const INVESTIGATED = '2026-09-13T23:54:13Z';
const NOW = new Date('2026-09-17T15:00:00Z');

test('a typed order number is read with or without its #, and nothing else is guessed at', () => {
  assert.equal(parseOrderNumber('6669'), 6669);
  assert.equal(parseOrderNumber('#6669'), 6669);
  assert.equal(parseOrderNumber('  # 6669 '), 6669);
  for (const bad of ['', '   ', 'abc', 'Q0026204303', 'commande 6669', '6669b', '0', '-5', null, undefined]) {
    assert.equal(parseOrderNumber(bad), null, String(bad));
  }
});

test('#6669 and 6669 are the same order; null only equals null', () => {
  assert.equal(sameOrder('#6669', 6669), true);
  assert.equal(sameOrder('#6669', '#6670'), false);
  assert.equal(sameOrder(null, null), true);
  assert.equal(sameOrder(null, '#6669'), false);
});

test('the match line says how the order relates to the sender, and never refuses', () => {
  assert.equal(describeOrderMatch({ orderEmailHash: 'a', ticketEmailHash: 'a' }), 'sender_email');
  assert.equal(describeOrderMatch({ orderEmailHash: 'a', ticketEmailHash: 'b' }), 'different_email');
  assert.equal(describeOrderMatch({ orderEmailHash: null, ticketEmailHash: 'b' }), 'unknown');
  assert.equal(
    describeOrderMatch({ orderEmailHash: 'a', ticketEmailHash: 'b', anonymous: true }),
    'anonymous_marketplace',
    'an anonymous buyer is named as such rather than as a different email'
  );
});

test('the worker requeues only a ticket that was investigated; a person requeues any open one', () => {
  assert.deepEqual(reinvestigationColumns({ status: 'open', investigated_at: null }), {});
  assert.deepEqual(
    reinvestigationColumns({ status: 'open', investigated_at: null }, { evenIfNeverInvestigated: true }),
    { needs_investigation: true }
  );
  assert.deepEqual(
    reinvestigationColumns({ status: 'awaiting_customer', investigated_at: INVESTIGATED }),
    { needs_investigation: true, status: 'open' }
  );
  for (const status of ['resolved', 'closed', 'forwarded', 'spam']) {
    assert.deepEqual(
      reinvestigationColumns({ status, investigated_at: INVESTIGATED }, { evenIfNeverInvestigated: true }),
      {},
      status
    );
  }
});

test('a person adding an order writes the number, the bundle, the trail and the requeue', () => {
  const ticket = {
    status: 'awaiting_human',
    shopify_order_number: null,
    customer_id: null,
    metadata: { categorisation: { runs: 1 } }
  };
  const columns = manualOrderColumns({
    ticket,
    order: ORDER,
    context: { order: { name: '#6669' } },
    source: 'add',
    actorId: 'user-1',
    now: NOW
  });

  assert.equal(columns.shopify_order_number, '#6669');
  assert.deepEqual(columns.resolved_context, { order: { name: '#6669' } });
  assert.equal(columns.context_resolved_at, NOW.toISOString());
  assert.equal(columns.customer_id, 'c1', 'filled where the ticket knew no customer');
  assert.deepEqual(columns.metadata.categorisation, { runs: 1 }, 'other trails are kept');
  assert.equal(columns.metadata.order_resolution.verified_by, BY_PERSON);
  assert.equal(columns.metadata.order_resolution.matched_by, 'add');
  assert.equal(columns.metadata.order_resolution.set_by, 'user-1');
  assert.equal(columns.metadata.order_resolution.previous_order, null);
  assert.equal(columns.needs_investigation, true);
  assert.equal(columns.status, 'open');
});

test('changing an order records what it replaced and keeps the ticket customer', () => {
  const columns = manualOrderColumns({
    ticket: { status: 'open', shopify_order_number: '#6059', customer_id: 'c9', metadata: {} },
    order: ORDER,
    context: {},
    source: 'edit',
    anonymous: true,
    now: NOW
  });
  assert.equal(columns.metadata.order_resolution.previous_order, '#6059');
  assert.equal(columns.metadata.order_resolution.buyer_anonymous, true);
  assert.equal('customer_id' in columns, false, 'the customer is who wrote in, not who owns the order');
  assert.equal('status' in columns, false, 'an open ticket is not re-set');
  assert.equal(columns.needs_investigation, true);
});

test('a closed ticket gets its order but no investigation', () => {
  const columns = manualOrderColumns({
    ticket: { status: 'closed', shopify_order_number: null, metadata: {} },
    order: ORDER,
    source: 'candidate',
    now: NOW
  });
  assert.equal(columns.shopify_order_number, '#6669');
  assert.equal('needs_investigation' in columns, false);
  assert.equal('status' in columns, false);
});

test('an unknown source or a missing order is refused', () => {
  assert.throws(() => manualOrderColumns({ order: ORDER, source: 'guess' }), /Unknown order link source/);
  assert.throws(() => manualOrderColumns({ order: null, source: 'add' }), /requires the order row/);
});
