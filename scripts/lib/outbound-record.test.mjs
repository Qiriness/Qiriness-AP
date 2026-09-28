import assert from 'node:assert/strict';
import test from 'node:test';

import { actionFromDraft, createOutboundRecord } from './outbound-record.mjs';
import { T } from './tables.mjs';

const DRAFT = {
  id: 'd1',
  ticket_id: 't1',
  trigger_message_id: 'm1',
  case_version: 3,
  status: 'approved',
  body_text: 'Texte du modèle',
  approved_body_text: null,
  auto_send_eligible: false,
  checks_passed: true
};

test('an approved draft becomes the row to insert, keyed on its case version', () => {
  const { row } = actionFromDraft(DRAFT, { requestedBy: 'user-1' });
  assert.deepEqual(row, {
    ticket_id: 't1',
    draft_id: 'd1',
    case_version: 3,
    action_type: 'reply',
    mode: 'human_approved',
    requested_by: 'user-1',
    reply_to_message_id: 'm1',
    body_text: 'Texte du modèle'
  });
});

test('the reviewer\'s version is what goes, when there is one', () => {
  const { row } = actionFromDraft({ ...DRAFT, status: 'edited', approved_body_text: 'Texte relu' });
  assert.equal(row.body_text, 'Texte relu');
});

test('what cannot be sent says why', () => {
  assert.equal(actionFromDraft(null).error, 'no_draft');
  assert.equal(actionFromDraft({ ...DRAFT, status: 'pending' }).error, 'not_approved');
  assert.equal(actionFromDraft({ ...DRAFT, status: 'stale' }).error, 'not_approved');
  assert.equal(actionFromDraft({ ...DRAFT, case_version: null }).error, 'no_case_version');
  assert.equal(actionFromDraft({ ...DRAFT, body_text: '  ' }).error, 'empty_body');
});

test('an auto-send comes only from a pending draft the level gate marked eligible', () => {
  assert.equal(actionFromDraft({ ...DRAFT, status: 'pending' }, { mode: 'auto_send' }).error, 'not_eligible');
  assert.equal(actionFromDraft(DRAFT, { mode: 'auto_send' }).error, 'not_approved');
  const { row } = actionFromDraft(
    { ...DRAFT, status: 'pending', auto_send_eligible: true, checks_passed: true },
    { mode: 'auto_send', requestedBy: 'agent' }
  );
  assert.equal(row.mode, 'auto_send');
});

function recorder({ insertError = null, selectRows = [], updated = [{ id: 'a1' }] } = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      async insert(_c, table, rows) {
        calls.push({ kind: 'insert', table, rows });
        if (insertError) throw insertError;
        return rows.map((r) => ({ id: 'a1', ...r }));
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

test('a second approval of the same case version collides with the key and gets the live row back', async () => {
  const rec = recorder({
    insertError: new Error('Supabase insert into outbound_actions failed: duplicate key value violates unique constraint "outbound_actions_idempotency_key"'),
    selectRows: [{ id: 'a-existing', state: 'send_requested' }]
  });
  const record = createOutboundRecord({}, { shopId: 'shop-1', transport: rec.transport });
  const result = await record.create(actionFromDraft(DRAFT).row);
  assert.deepEqual(result, { created: false, action: { id: 'a-existing', state: 'send_requested' } });
  const lookup = rec.calls.find((c) => c.kind === 'select');
  assert.deepEqual(lookup.filters.state, { operator: 'not.in', value: '(cancelled,failed)' });
});

test('any other insert error is not swallowed', async () => {
  const rec = recorder({ insertError: new Error('Supabase insert into outbound_actions failed: HTTP 500') });
  const record = createOutboundRecord({}, { shopId: 'shop-1', transport: rec.transport });
  await assert.rejects(record.create(actionFromDraft(DRAFT).row), /HTTP 500/);
});

test('every state move is conditional on the state it leaves', async () => {
  const rec = recorder();
  const record = createOutboundRecord({}, { shopId: 'shop-1', transport: rec.transport });
  await record.markDraftCreated('a1', { providerDraftId: 'AAMk' });
  await record.markSendRequested('a1');
  await record.markConfirmed('a1', { sentMessageId: 'm9' });
  await record.cancel('a1', 'case_moved');
  await record.cancel('a1', 'case_moved', { confirmedUnsent: true });
  await record.markFailed('a1', 'draft_missing');

  const from = rec.calls.map((c) => c.filters.state.value);
  assert.deepEqual(from, [
    '(approved)',
    '(draft_created,send_requested)',
    '(draft_created,send_requested)',
    '(approved,draft_created)',
    '(approved,draft_created,send_requested)',
    '(approved,draft_created,send_requested)'
  ]);
  for (const call of rec.calls) {
    assert.equal(call.table, T.OUTBOUND_ACTIONS);
    assert.equal(call.filters.shop_id, 'shop-1');
  }
});

test('a move that lost the race reports it', async () => {
  const rec = recorder({ updated: [] });
  const record = createOutboundRecord({}, { shopId: 'shop-1', transport: rec.transport });
  assert.equal(await record.markSendRequested('a1'), false);
});

test('only a declared reason can cancel', () => {
  const record = createOutboundRecord({}, { shopId: 'shop-1', transport: recorder().transport });
  assert.throws(() => record.cancel('a1', 'felt_like_it'), /case_moved/);
});
