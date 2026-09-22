import assert from 'node:assert/strict';
import test from 'node:test';

import { CASE_RELATIONSHIPS, createCaseStateRecord } from './case-state-record.mjs';

function harness({ rows = [] } = {}) {
  const upserts = [];
  const selects = [];
  const record = createCaseStateRecord({}, {
    shopId: 'shop-1',
    async select(_client, table, filters, columns, options) {
      selects.push({ table, filters, columns, options });
      return rows;
    },
    async upsert(_client, table, payload, onConflict) {
      upserts.push({ table, payload, onConflict });
      return payload;
    }
  });
  return { record, upserts, selects };
}

const READING = {
  ticketId: 'tk1',
  triggerMessageId: 'm3',
  caseRelationship: 'continuation',
  situationKey: 'D-36',
  resolvedInputs: ['shopify_order_number'],
  pendingCustomerInputs: ['photo'],
  newFacts: ['les voisins n’ont rien'],
  commitments: [{ what: 'ouvrir une enquête', status: 'pending' }],
  contradictions: [],
  evidenceReuse: { order_state: { tool: 'getOrderContext', status: 'valid' } },
  caseSummary: 'colis non reçu',
  model: 'gpt-4o-mini'
};

test('a shop must be bound at construction', () => {
  assert.throws(() => createCaseStateRecord({}, {}), /shopId/);
});

test('a reading is written against the message that produced it', async () => {
  const { record, upserts } = harness();
  await record.save(READING);

  const [row] = upserts[0].payload;
  assert.equal(row.shop_id, 'shop-1');
  assert.equal(row.trigger_message_id, 'm3');
  assert.equal(row.situation_key, 'D-36');
  assert.deepEqual(row.resolved_inputs, ['shopify_order_number']);
  // The same idempotency key ticket_investigations and ticket_drafts use: one
  // reading per message, so a re-run rewrites its own row.
  assert.equal(upserts[0].onConflict, 'shop_id,trigger_message_id');
});

test('an unknown relationship is refused, never defaulted', async () => {
  // Storing `unclear` quietly would hide a caller bug behind behaviour that
  // looks deliberate.
  const { record, upserts } = harness();
  await assert.rejects(() => record.save({ ...READING, caseRelationship: 'invented' }), /case_relationship/);
  assert.equal(upserts.length, 0);
});

test('every declared relationship is accepted', async () => {
  const { record } = harness();
  for (const caseRelationship of CASE_RELATIONSHIPS) {
    await record.save({ ...READING, caseRelationship });
  }
});

test('the empty shapes are the DDL defaults, not nulls', async () => {
  const { record, upserts } = harness();
  await record.save({ ticketId: 'tk1', triggerMessageId: 'm3', caseRelationship: 'unclear' });

  const [row] = upserts[0].payload;
  assert.deepEqual(row.resolved_inputs, []);
  assert.deepEqual(row.commitments, []);
  assert.deepEqual(row.evidence_reuse, {});
  assert.equal(row.situation_key, null);
});

test('the latest reading is the newest one, and a thread never read has none', async () => {
  const { record, selects } = harness({ rows: [{ id: 'cs1', situation_key: 'D-36' }] });
  const latest = await record.latest('tk1');
  assert.equal(latest.situation_key, 'D-36');
  assert.equal(selects[0].options.order, 'read_at.desc');
  assert.equal(selects[0].options.limit, 1);

  const empty = harness({ rows: [] });
  assert.equal(await empty.record.latest('tk1'), null);
});

test('the queue is derived: which messages are DONE, not which are due', async () => {
  const { record, selects } = harness({ rows: [{ trigger_message_id: 'm3' }] });
  const done = await record.withCaseState(['m3', 'm4']);

  assert.ok(done.has('m3'));
  assert.ok(!done.has('m4'));
  assert.equal(selects[0].filters.shop_id, 'shop-1');
});

test('an empty batch asks the database nothing', async () => {
  const { record, selects } = harness();
  assert.equal((await record.withCaseState([])).size, 0);
  assert.deepEqual(await record.forTickets([]), []);
  assert.equal(selects.length, 0);
});

test('a batch read is shop-scoped and newest first', async () => {
  const { record, selects } = harness({ rows: [{ ticket_id: 'tk1' }] });
  await record.forTickets(['tk1', 'tk2']);
  assert.equal(selects[0].filters.shop_id, 'shop-1');
  assert.equal(selects[0].options.order, 'read_at.desc');
});
