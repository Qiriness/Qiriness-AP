import assert from 'node:assert/strict';
import test from 'node:test';

import { CANCEL_REASONS } from '../../../scripts/lib/outbound-record.mjs';
import { preSendCheck } from './outbound-rules.mjs';

const REPLY_TO = { id: 'm-customer', direction: 'inbound', actor: 'customer', received_at: '2026-09-28T09:00:00Z' };

function facts(overrides = {}) {
  return {
    action: { id: 'a1', mode: 'human_approved', case_version: 3, sent_message_id: null },
    draft: { status: 'approved', auto_send_eligible: false },
    caseCurrent: { version: 3 },
    replyTo: REPLY_TO,
    laterMessages: [],
    otherActions: [],
    draftOnly: true,
    ...overrides
  };
}

test('an approved reply on an unchanged case goes', () => {
  assert.deepEqual(preSendCheck(facts()), { ok: true });
  assert.deepEqual(preSendCheck(facts({ draft: { status: 'edited' } })), { ok: true });
});

test('a rejected, stale or already-sent draft is withdrawn', () => {
  for (const status of ['rejected', 'stale', 'sent', 'pending']) {
    assert.deepEqual(preSendCheck(facts({ draft: { status } })), { ok: false, reason: 'draft_withdrawn' }, status);
  }
  assert.deepEqual(preSendCheck(facts({ draft: null })), { ok: false, reason: 'draft_withdrawn' });
});

test('the case moved since the text was written', () => {
  assert.deepEqual(preSendCheck(facts({ caseCurrent: { version: 4 } })), { ok: false, reason: 'case_moved' });
  assert.deepEqual(preSendCheck(facts({ caseCurrent: null })), { ok: false, reason: 'case_moved' });
});

test('the customer wrote again after the message being answered', () => {
  const later = [{ id: 'm2', direction: 'inbound', actor: 'customer', received_at: '2026-09-28T10:00:00Z' }];
  assert.deepEqual(preSendCheck(facts({ laterMessages: later })), { ok: false, reason: 'customer_wrote_again' });
  // A row from before actors were stamped reads as the customer.
  const unstamped = [{ id: 'm2', direction: 'inbound', actor: null }];
  assert.deepEqual(preSendCheck(facts({ laterMessages: unstamped })), { ok: false, reason: 'customer_wrote_again' });
});

test('a colleague writing in is not the customer writing again', () => {
  const later = [{ id: 'm2', direction: 'inbound', actor: 'colleague' }];
  assert.deepEqual(preSendCheck(facts({ laterMessages: later })), { ok: true });
});

test('somebody already answered: an Outlook reply, or another action that went', () => {
  const outlook = [{ id: 'm3', direction: 'outbound', actor: 'support' }];
  assert.deepEqual(preSendCheck(facts({ laterMessages: outlook })), { ok: false, reason: 'already_answered' });

  for (const state of ['send_requested', 'sent_confirmed']) {
    const other = [{ id: 'a0', state, case_version: 3 }];
    assert.deepEqual(preSendCheck(facts({ otherActions: other })), { ok: false, reason: 'already_answered' }, state);
  }
  // A cancelled attempt and the action itself do not count.
  const harmless = [{ id: 'a0', state: 'cancelled' }, { id: 'a1', state: 'send_requested' }];
  assert.deepEqual(preSendCheck(facts({ otherActions: harmless })), { ok: true });
});

test('a reply we sent for an EARLIER case version does not block answering the new one', () => {
  // The customer wrote again after our reply: that is why the case has a new
  // version. Found on a real test thread, where the second reply was cancelled.
  const earlier = [{ id: 'a0', state: 'sent_confirmed', case_version: 2 }];
  assert.deepEqual(preSendCheck(facts({ otherActions: earlier })), { ok: true });
  const sameOrNewer = [{ id: 'a0', state: 'sent_confirmed', case_version: 4 }];
  assert.deepEqual(preSendCheck(facts({ otherActions: sameOrNewer })), { ok: false, reason: 'already_answered' });
});

test('auto-send is refused while DRAFT_ONLY is on, or when the draft is not eligible', () => {
  const auto = { id: 'a1', mode: 'auto_send', case_version: 3 };
  const eligible = { status: 'pending', auto_send_eligible: true };
  assert.deepEqual(preSendCheck(facts({ action: auto, draft: eligible })), { ok: false, reason: 'auto_send_off' });
  assert.deepEqual(
    preSendCheck(facts({ action: auto, draft: { status: 'pending', auto_send_eligible: false }, draftOnly: false })),
    { ok: false, reason: 'auto_send_off' }
  );
  assert.deepEqual(preSendCheck(facts({ action: auto, draft: eligible, draftOnly: false })), { ok: true });
  // A person who touched an auto-send draft owns it.
  assert.deepEqual(
    preSendCheck(facts({ action: auto, draft: { status: 'approved', auto_send_eligible: true }, draftOnly: false })),
    { ok: false, reason: 'draft_withdrawn' }
  );
});

test('every reason the check can give is a declared cancel reason', () => {
  const reasons = new Set();
  const cases = [
    facts({ draft: null }),
    facts({ caseCurrent: null }),
    facts({ laterMessages: [{ id: 'x', direction: 'inbound' }] }),
    facts({ laterMessages: [{ id: 'x', direction: 'outbound' }] }),
    facts({ action: { id: 'a', mode: 'auto_send', case_version: 3 }, draft: { status: 'pending' } })
  ];
  for (const c of cases) reasons.add(preSendCheck(c).reason);
  for (const reason of reasons) assert.ok(CANCEL_REASONS.includes(reason), reason);
});

test('a manual reply is checked only for a customer message it could not have read', () => {
  const manual = { id: 'a2', mode: 'manual', case_version: 3, sent_message_id: null };
  const ours = [{ id: 'm-ours', direction: 'outbound', actor: 'support', received_at: '2026-09-28T10:00:00Z' }];
  assert.deepEqual(
    preSendCheck(facts({ action: manual, draft: null, caseCurrent: { version: 9 }, laterMessages: ours, otherActions: [{ id: 'a1', state: 'sent_confirmed', case_version: 3 }] })),
    { ok: true }
  );
  const customer = [{ id: 'm2', direction: 'inbound', actor: 'customer', received_at: '2026-09-28T10:00:00Z' }];
  assert.deepEqual(preSendCheck(facts({ action: manual, draft: null, laterMessages: customer })), { ok: false, reason: 'customer_wrote_again' });
});
