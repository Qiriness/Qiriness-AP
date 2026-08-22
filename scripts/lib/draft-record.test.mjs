import assert from 'node:assert/strict';
import test from 'node:test';

import { DECISIONS, createDraftRecord } from './draft-record.mjs';
import { T } from './tables.mjs';

/**
 * A recording transport: every call is captured, and reads answer from a list
 * the test sets. The point is to assert the BODIES this module would write —
 * the rules it owns (the upsert key, "edited must carry a rewrite", what a
 * re-run does not touch) are only visible in the patch, not in a return value.
 */
function recorder({ rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    rows,
    transport: {
      async select(_client, table, filters, columns, options) {
        calls.push({ kind: 'select', table, filters, columns, options });
        return calls.at(-1).table === T.TICKET_DRAFTS ? rows : [];
      },
      async updateById(_client, table, id, patch) {
        calls.push({ kind: 'updateById', table, id, patch });
        return { id, ...patch };
      },
      async insert(_client, table, bodies) {
        calls.push({ kind: 'insert', table, bodies });
        return bodies;
      },
      async upsert(_client, table, bodies, onConflict) {
        calls.push({ kind: 'upsert', table, bodies, onConflict });
        return bodies;
      }
    }
  };
}

const SHOP = 'shop-1';

function record(options) {
  const rec = recorder(options);
  return { rec, draft: createDraftRecord({}, { shopId: SHOP, transport: rec.transport }) };
}

const SAVE = {
  ticketId: 'ticket-1',
  triggerMessageId: 'message-1',
  investigationId: 'investigation-1',
  sourceVerdict: 'answerable',
  bodyText: 'Bonjour, votre commande est en préparation.'
};

test('it refuses to be constructed without a shop', () => {
  assert.throws(() => createDraftRecord({}, {}), /shopId/);
});

// --- save --------------------------------------------------------------------

test('a draft is upserted on the message it answers, not on the ticket', async () => {
  const { rec, draft } = record();
  await draft.save(SAVE);

  const [call] = rec.calls;
  assert.equal(call.kind, 'upsert');
  assert.equal(call.table, T.TICKET_DRAFTS);
  assert.equal(call.onConflict, 'shop_id,trigger_message_id');
});

test('the shop is bound at construction, never passed per call', async () => {
  const { rec, draft } = record();
  await draft.save(SAVE);
  assert.equal(rec.calls[0].bodies[0].shop_id, SHOP);
});

test('an empty body is refused before it reaches the database', async () => {
  const { draft } = record();
  await assert.rejects(() => draft.save({ ...SAVE, bodyText: '   ' }), /empty draft/);
});

test('a re-run revises the agent text and leaves the human columns alone', async () => {
  // A pass that reset `status` would move a rejected draft back into the queue,
  // and one that cleared `approved_body_text` would discard an operator's
  // rewrite -- both while somebody is working through the review list.
  const { rec, draft } = record();
  await draft.save(SAVE);

  const [body] = rec.calls[0].bodies;
  assert.ok(!('status' in body));
  assert.ok(!('approved_body_text' in body));
});

test('a revised draft is un-stamped so the review copy is sent again', async () => {
  // Otherwise the reviewer holds an email describing text that no longer exists.
  const { rec, draft } = record();
  await draft.save(SAVE);
  assert.equal(rec.calls[0].bodies[0].review_sent_at, null);
});

test('no save path carries a recipient', async () => {
  // The property the whole review channel rests on: nothing here can address a
  // customer, because there is nowhere to put an address.
  const { rec, draft } = record();
  await draft.save({ ...SAVE, subject: 'Re: commande' });

  const [body] = rec.calls[0].bodies;
  for (const key of Object.keys(body)) {
    assert.doesNotMatch(key, /recipient|to_email|reply_to/);
  }
});

// --- the derived queue -------------------------------------------------------

test('it reports which trigger messages still have no draft', async () => {
  const { draft } = record({ rows: [{ trigger_message_id: 'b' }] });
  assert.deepEqual(await draft.withoutDrafts(['a', 'b', 'c']), ['a', 'c']);
});

test('it de-duplicates the candidate list and skips empty ids', async () => {
  const { rec, draft } = record();
  assert.deepEqual(await draft.withoutDrafts(['a', 'a', null, undefined, 'b']), ['a', 'b']);
  assert.equal(rec.calls[0].filters.trigger_message_id.value, '(a,b)');
});

test('an empty candidate list asks the database nothing', async () => {
  const { rec, draft } = record();
  assert.deepEqual(await draft.withoutDrafts([]), []);
  assert.equal(rec.calls.length, 0);
});

// --- the human decision ------------------------------------------------------

test('only a real decision is accepted', async () => {
  const { draft } = record();
  for (const status of ['pending', 'nonsense', '', null]) {
    await assert.rejects(() => draft.decide('draft-1', { status }), /decide\(\) takes one of/);
  }
});

test('sending is not a decision the dashboard can record', async () => {
  // In the column's check constraint so the lifecycle reads completely; absent
  // here because nothing in this codebase can send an email to a customer, and
  // accepting it would record a send that never happened.
  assert.ok(!DECISIONS.includes('sent'));
  const { draft } = record();
  await assert.rejects(() => draft.decide('draft-1', { status: 'sent' }), /decide\(\) takes one of/);
});

test('an edit has to carry the edit', async () => {
  const { draft } = record();
  await assert.rejects(
    () => draft.decide('draft-1', { status: 'edited' }),
    /requires the rewritten body/
  );
});

test('an approval may carry the reviewer text, and a rejection never does', async () => {
  const { rec, draft } = record();
  await draft.decide('draft-1', { status: 'approved', approvedBodyText: 'Bonjour…' });
  await draft.decide('draft-2', { status: 'rejected', approvedBodyText: 'ignored' });

  assert.equal(rec.calls[0].patch.approved_body_text, 'Bonjour…');
  assert.equal(rec.calls[1].patch.approved_body_text, null);
});

// --- review copies -----------------------------------------------------------

test('the review queue is what has never been mailed, oldest first', async () => {
  const { rec, draft } = record();
  await draft.pendingReview({ limit: 5 });

  const [call] = rec.calls;
  assert.deepEqual(call.filters.review_sent_at, { operator: 'is', value: 'null' });
  assert.equal(call.options.order, 'drafted_at.asc');
});

test('the dashboard reads the latest draft on a ticket, not the first', async () => {
  const { rec, draft } = record({ rows: [{ id: 'draft-9' }] });
  const row = await draft.forTicket('ticket-1');

  assert.equal(row.id, 'draft-9');
  assert.equal(rec.calls[0].options.order, 'drafted_at.desc');
  assert.equal(rec.calls[0].options.limit, 1);
});

test('a ticket with no draft reads as null rather than undefined', async () => {
  const { draft } = record({ rows: [] });
  assert.equal(await draft.forTicket('ticket-1'), null);
});

// --- the edit log ------------------------------------------------------------

const DRAFT_ROW = { id: 'draft-1', ticket_id: 'ticket-1', body_text: 'Bonjour, votre commande part demain.' };

test('an edit is recorded with the model text it was an edit OF', () => {
  // THE SNAPSHOT IS THE POINT. ticket_drafts.body_text is replaced by the next
  // drafting run while approved_body_text is kept, so the two columns stop being
  // a pair the moment a draft is re-run — and a pair that never existed is the
  // worst thing to train on.
  const rec = recorder({ rows: [DRAFT_ROW] });
  const draft = createDraftRecord({}, { shopId: SHOP, transport: rec.transport });

  return draft
    .decide('draft-1', { status: 'edited', approvedBodyText: 'Bonjour, votre colis part mardi.' })
    .then(() => {
      const logged = rec.calls.find((call) => call.kind === 'insert');
      assert.ok(logged, 'no edit was recorded');
      assert.equal(logged.table, T.TICKET_DRAFT_EDITS);
      assert.equal(logged.bodies[0].model_body_text, DRAFT_ROW.body_text);
      assert.equal(logged.bodies[0].human_body_text, 'Bonjour, votre colis part mardi.');
      assert.equal(logged.bodies[0].source, 'dashboard');
      assert.equal(logged.bodies[0].ticket_id, 'ticket-1');
    });
});

test('the mailbox can be named as the source of an edit', () => {
  // Declared before anything writes it: editing a review copy in Outlook is the
  // intended second source.
  const rec = recorder({ rows: [DRAFT_ROW] });
  const draft = createDraftRecord({}, { shopId: SHOP, transport: rec.transport });

  return draft
    .decide('draft-1', { status: 'edited', approvedBodyText: 'Autre chose.', source: 'mailbox' })
    .then(() => {
      assert.equal(rec.calls.find((c) => c.kind === 'insert').bodies[0].source, 'mailbox');
    });
});

test('an edit that changed nothing but whitespace is not recorded', () => {
  // A row asserting the agent's text needed correcting into itself is the most
  // misleading training pair there is.
  const rec = recorder({ rows: [DRAFT_ROW] });
  const draft = createDraftRecord({}, { shopId: SHOP, transport: rec.transport });

  return draft
    .decide('draft-1', { status: 'edited', approvedBodyText: '  Bonjour,   votre commande part demain. ' })
    .then(() => {
      assert.equal(rec.calls.find((call) => call.kind === 'insert'), undefined);
      // The decision itself is still recorded.
      assert.ok(rec.calls.some((call) => call.kind === 'updateById'));
    });
});

test('approving or rejecting records no edit', () => {
  const rec = recorder({ rows: [DRAFT_ROW] });
  const draft = createDraftRecord({}, { shopId: SHOP, transport: rec.transport });

  return Promise.all([
    draft.decide('draft-1', { status: 'approved' }),
    draft.decide('draft-2', { status: 'rejected' })
  ]).then(() => {
    assert.equal(rec.calls.find((call) => call.kind === 'insert'), undefined);
  });
});
