import assert from 'node:assert/strict';
import test from 'node:test';

import { failurePatch } from '../../../scripts/lib/mail-job-record.mjs';
import { confirmSentActions, createAutoSendActions, runOutbound } from './outbound-runner.mjs';

// --- fakes ------------------------------------------------------------------
//
// In-memory stand-ins for the three records, the store and the provider. The
// record fakes apply the same conditional state moves the real module writes
// ("set X where state in (...)"), because those conditions are what stop a
// second send, and a fake that ignored them would test nothing.

const REPLY_TO = {
  id: 'm-customer',
  ticket_id: 't1',
  graph_message_id: 'AAMk-customer',
  from_email: 'marie@example.com',
  direction: 'inbound',
  actor: 'customer',
  received_at: '2026-09-28T09:00:00Z'
};

function world({ action = {}, draft = {}, caseVersion = 3, later = [], sentState = 'draft', storedSent = null, sendFails = null } = {}) {
  const actions = new Map([
    [
      'a1',
      {
        id: 'a1',
        ticket_id: 't1',
        draft_id: 'd1',
        case_version: 3,
        mode: 'human_approved',
        reply_to_message_id: 'm-customer',
        body_text: 'Bonjour Marie,\n\nVotre colis part demain.',
        state: 'approved',
        provider_draft_id: null,
        provider_internet_message_id: null,
        sent_message_id: null,
        ...action
      }
    ]
  ]);
  const drafts = new Map([['d1', { id: 'd1', ticket_id: 't1', status: 'approved', auto_send_eligible: false, ...draft }]]);
  const calls = [];
  const jobState = new Map();

  const move = (id, from, patch) => {
    const row = actions.get(id);
    if (!row || !from.includes(row.state)) return false;
    Object.assign(row, patch);
    return true;
  };

  const outboundRecord = {
    async get(id) {
      return actions.get(id) ? { ...actions.get(id) } : null;
    },
    async forTicket(ticketId) {
      return [...actions.values()].filter((a) => a.ticket_id === ticketId).map((a) => ({ ...a }));
    },
    async awaitingConfirmation() {
      return [...actions.values()].filter((a) => ['draft_created', 'send_requested'].includes(a.state));
    },
    async create(row) {
      const id = `a${actions.size + 1}`;
      actions.set(id, { id, state: 'approved', ...row });
      return { created: true, action: actions.get(id) };
    },
    markDraftCreated: async (id, { providerDraftId, internetMessageId }) =>
      move(id, ['approved'], { state: 'draft_created', provider_draft_id: providerDraftId, provider_internet_message_id: internetMessageId }),
    markSendRequested: async (id) => move(id, ['draft_created', 'send_requested'], { state: 'send_requested' }),
    markConfirmed: async (id, { sentMessageId }) =>
      move(id, ['draft_created', 'send_requested'], { state: 'sent_confirmed', sent_message_id: sentMessageId }),
    cancel: async (id, reason, { confirmedUnsent = false } = {}) =>
      move(id, confirmedUnsent ? ['approved', 'draft_created', 'send_requested'] : ['approved', 'draft_created'], {
        state: 'cancelled',
        cancel_reason: reason
      }),
    markFailed: async (id, reason) =>
      move(id, ['approved', 'draft_created', 'send_requested'], { state: 'failed', failure_reason: reason })
  };

  const draftRecord = {
    async markSent(id) {
      calls.push(['markSent', id]);
      drafts.get(id).status = 'sent';
      return true;
    }
  };

  const store = {
    draft: async (id) => (drafts.get(id) ? { ...drafts.get(id) } : null),
    caseCurrent: async () => ({ version: caseVersion }),
    message: async (id) => (id === REPLY_TO.id ? REPLY_TO : null),
    messagesAfter: async () => later,
    storedSentMessage: async () => storedSent,
    autoSendCandidates: async () => [...drafts.values()].filter((d) => d.status === 'pending'),
    draftsWithActions: async (ids) => new Set([...actions.values()].map((a) => a.draft_id).filter((id) => ids.includes(id)))
  };

  const provider = {
    async createReplyDraft(messageId, reply) {
      calls.push(['createReplyDraft', messageId, reply]);
      return { draftId: 'AAMk-draft', internetMessageId: '<draft@example.com>' };
    },
    async sendDraft(id) {
      calls.push(['sendDraft', id]);
      if (sendFails) throw sendFails;
    },
    async findSentMessage({ draftId }) {
      calls.push(['findSentMessage', draftId]);
      return sentState;
    }
  };

  const queued = [{ id: 'j1', payload: { outboundActionId: 'a1' }, retry_count: 0 }];
  const jobs = {
    claimedWith: null,
    async claim(options) {
      jobs.claimedWith = options;
      return queued.splice(0);
    },
    async complete(id) {
      jobState.set(id, { state: 'done' });
    },
    async fail(job, error, options) {
      const patch = failurePatch(job, error, options);
      jobState.set(job.id, patch);
      return patch;
    },
    enqueued: [],
    async enqueue(job) {
      jobs.enqueued.push(job);
    }
  };

  return { actions, drafts, calls, jobs, jobState, outboundRecord, draftRecord, store, provider, queued };
}

function run(w, options = {}) {
  return runOutbound({
    jobs: w.jobs,
    outboundRecord: w.outboundRecord,
    draftRecord: w.draftRecord,
    store: w.store,
    provider: w.provider,
    enabled: true,
    maxAttempts: 5,
    shopId: 'shop-1',
    ...options
  });
}

const sent = (w) => w.calls.filter(([name]) => name === 'sendDraft');

// --- runOutbound --------------------------------------------------------------

test('an approved reply becomes a reply draft to the customer, then is sent', async () => {
  const w = world();
  const totals = await run(w);

  assert.equal(totals.sent, 1);
  const [, messageId, reply] = w.calls.find(([name]) => name === 'createReplyDraft');
  assert.equal(messageId, 'AAMk-customer');
  assert.deepEqual(reply.to, ['marie@example.com']);
  assert.equal(reply.bodyText, 'Bonjour Marie,\n\nVotre colis part demain.');
  assert.deepEqual(sent(w), [['sendDraft', 'AAMk-draft']]);
  assert.equal(w.actions.get('a1').state, 'send_requested');
  assert.equal(w.actions.get('a1').provider_draft_id, 'AAMk-draft');
  assert.equal(w.jobState.get('j1').state, 'done');
});

test('OUTBOUND_STOP_BEFORE_SEND: the checks run and the reply draft is made, but nothing is sent', async () => {
  const w = world();
  const totals = await run(w, { stopBeforeSend: true });
  assert.equal(totals.held, 1);
  assert.equal(totals.sent, 0);
  assert.equal(w.calls.filter(([name]) => name === 'createReplyDraft').length, 1);
  assert.equal(sent(w).length, 0);
  assert.equal(w.actions.get('a1').state, 'draft_created');
  assert.equal(w.jobState.get('j1').state, 'done');

  // Retried from draft_created (the draft is still a draft): still not sent.
  const again = world({ action: { state: 'draft_created', provider_draft_id: 'AAMk-draft' }, sentState: 'draft' });
  await run(again, { stopBeforeSend: true });
  assert.equal(sent(again).length, 0);
});

test('a held draft a person sent from Outlook is confirmed like any other', async () => {
  const w = world({
    action: { state: 'draft_created', provider_draft_id: 'AAMk-draft' },
    storedSent: { id: 'm-sent', direction: 'outbound' }
  });
  await confirmSentActions({ outboundRecord: w.outboundRecord, draftRecord: w.draftRecord, store: w.store });
  assert.equal(w.actions.get('a1').state, 'sent_confirmed');
});

test('with sending off nothing is claimed', async () => {
  const w = world();
  const totals = await run(w, { enabled: false });
  assert.equal(totals.considered, 0);
  assert.equal(w.jobs.claimedWith, null);
  assert.equal(w.calls.length, 0);
});

test('a pre-send refusal cancels without touching the mailbox', async () => {
  const w = world({ caseVersion: 4 });
  const totals = await run(w);
  assert.equal(totals.cancelled, 1);
  assert.equal(w.actions.get('a1').state, 'cancelled');
  assert.equal(w.actions.get('a1').cancel_reason, 'case_moved');
  assert.equal(w.calls.length, 0);
});

test('a customer message after approval stops the send', async () => {
  const w = world({ later: [{ id: 'm2', direction: 'inbound', actor: 'customer' }] });
  await run(w);
  assert.equal(w.actions.get('a1').cancel_reason, 'customer_wrote_again');
  assert.equal(sent(w).length, 0);
});

test('SEND_REQUESTED IS NEVER RETRIED BLIND: a draft that already went is left for confirmation', async () => {
  const w = world({ action: { state: 'send_requested', provider_draft_id: 'AAMk-draft' }, sentState: 'sent' });
  const totals = await run(w);
  assert.equal(totals.awaitingConfirmation, 1);
  assert.deepEqual(w.calls, [['findSentMessage', 'AAMk-draft']]);
  assert.equal(sent(w).length, 0);
  assert.equal(w.actions.get('a1').state, 'send_requested');
});

test('send_requested whose draft is still a draft is checked again, then sent', async () => {
  const w = world({ action: { state: 'send_requested', provider_draft_id: 'AAMk-draft' }, sentState: 'draft' });
  const totals = await run(w);
  assert.equal(totals.sent, 1);
  assert.deepEqual(sent(w), [['sendDraft', 'AAMk-draft']]);
  // No second reply draft was made.
  assert.equal(w.calls.filter(([name]) => name === 'createReplyDraft').length, 0);
});

test('send_requested, still a draft, and the case moved: cancelled, never sent', async () => {
  const w = world({ action: { state: 'send_requested', provider_draft_id: 'AAMk-draft' }, sentState: 'draft', caseVersion: 5 });
  await run(w);
  assert.equal(w.actions.get('a1').state, 'cancelled');
  assert.equal(sent(w).length, 0);
});

test('a draft that has vanished from the mailbox fails the action for a person to look at', async () => {
  const w = world({ action: { state: 'draft_created', provider_draft_id: 'AAMk-draft' }, sentState: 'missing' });
  const totals = await run(w);
  assert.equal(totals.failed, 1);
  assert.equal(w.actions.get('a1').failure_reason, 'draft_missing');
});

test('a provider error retries the job with backoff, and the action stays "maybe sent"', async () => {
  const w = world({ sendFails: new Error('Graph send failed: HTTP 503') });
  const totals = await run(w);
  assert.equal(totals.retried, 1);
  assert.equal(w.jobState.get('j1').state, 'queued');
  assert.equal(w.jobState.get('j1').retry_count, 1);
  assert.equal(w.actions.get('a1').state, 'send_requested');
});

test('at the attempt cap the job goes dead and the action is marked failed', async () => {
  const w = world({ sendFails: new Error('Graph send failed: ErrorAccessDenied') });
  w.queued[0].retry_count = 4;
  const totals = await run(w, { maxAttempts: 5 });
  assert.equal(totals.dead, 1);
  assert.equal(w.jobState.get('j1').state, 'dead');
  assert.equal(w.actions.get('a1').state, 'failed');
});

test('a reply target with no address fails rather than guessing one', async () => {
  const w = world();
  w.store.message = async () => ({ ...REPLY_TO, from_email: null });
  await run(w);
  assert.equal(w.actions.get('a1').failure_reason, 'no_recipient');
  assert.equal(w.calls.length, 0);
});

test('an action already closed is left alone', async () => {
  for (const state of ['sent_confirmed', 'cancelled', 'failed']) {
    const w = world({ action: { state } });
    const totals = await run(w);
    assert.equal(totals.closed, 1, state);
    assert.equal(w.calls.length, 0, state);
  }
});

// --- confirmSentActions ---------------------------------------------------------

test('a reply read back from Sent Items confirms the action and marks the draft sent', async () => {
  const w = world({
    action: { state: 'send_requested', provider_draft_id: 'AAMk-draft' },
    storedSent: { id: 'm-sent', direction: 'outbound' }
  });
  const totals = await confirmSentActions({ outboundRecord: w.outboundRecord, draftRecord: w.draftRecord, store: w.store });
  assert.equal(totals.confirmed, 1);
  assert.equal(w.actions.get('a1').state, 'sent_confirmed');
  assert.equal(w.actions.get('a1').sent_message_id, 'm-sent');
  assert.deepEqual(w.calls, [['markSent', 'd1']]);
});

test('nothing stored yet: nothing confirmed', async () => {
  const w = world({ action: { state: 'send_requested', provider_draft_id: 'AAMk-draft' } });
  const totals = await confirmSentActions({ outboundRecord: w.outboundRecord, draftRecord: w.draftRecord, store: w.store });
  assert.equal(totals.confirmed, 0);
  assert.equal(w.actions.get('a1').state, 'send_requested');
});

// --- createAutoSendActions --------------------------------------------------------

test('auto-send creates nothing while DRAFT_ONLY is on', async () => {
  const w = world({ draft: { id: 'd2', status: 'pending', auto_send_eligible: true, checks_passed: true, case_version: 2 } });
  const totals = await createAutoSendActions({ ...w, enabled: true, draftOnly: true });
  assert.equal(totals.created, 0);
  assert.equal(w.jobs.enqueued.length, 0);
});

test('with DRAFT_ONLY off an eligible pending draft becomes an auto_send action and a job', async () => {
  const w = world();
  w.drafts.set('d2', {
    id: 'd2',
    ticket_id: 't2',
    trigger_message_id: 'm9',
    status: 'pending',
    auto_send_eligible: true,
    checks_passed: true,
    case_version: 2,
    body_text: 'Bonjour'
  });
  const totals = await createAutoSendActions({ ...w, enabled: true, draftOnly: false });
  assert.equal(totals.created, 1);
  const created = [...w.actions.values()].find((a) => a.draft_id === 'd2');
  assert.equal(created.mode, 'auto_send');
  assert.equal(created.requested_by, 'agent');
  assert.equal(w.jobs.enqueued[0].kind, 'send_outbound');
  assert.equal(w.jobs.enqueued[0].dedupeKey, `send:${created.id}`);
});

// --- manual replies -----------------------------------------------------------

const MANUAL = {
  draft_id: null,
  mode: 'manual',
  action_type: 'manual_reply',
  client_key: '0b7c2c9e-1f7a-4a57-9a7e-2d1f0f3c9a11',
  body_text: 'Voici le suivi.',
  body_html: '<p>Voici <strong>le suivi</strong>.</p>'
};

test('a manual reply is sent as its HTML, with no draft to read or mark', async () => {
  // Our earlier reply already went, and the case moved: neither stops it.
  const w = world({
    action: MANUAL,
    caseVersion: 7,
    later: [{ id: 'm-ours', direction: 'outbound', actor: 'support', received_at: '2026-09-28T10:00:00Z' }]
  });
  const totals = await run(w);
  assert.equal(totals.sent, 1);
  const [, , reply] = w.calls.find(([name]) => name === 'createReplyDraft');
  assert.equal(reply.bodyHtml, '<p>Voici <strong>le suivi</strong>.</p>');
  assert.equal(reply.bodyText, 'Voici le suivi.');

  w.actions.get('a1').state = 'send_requested';
  w.actions.get('a1').provider_draft_id = 'AAMk-draft';
  w.store.storedSentMessage = async () => ({ id: 'm-sent', direction: 'outbound' });
  await confirmSentActions({ outboundRecord: w.outboundRecord, draftRecord: w.draftRecord, store: w.store });
  assert.equal(w.actions.get('a1').state, 'sent_confirmed');
  assert.equal(w.calls.filter(([name]) => name === 'markSent').length, 0);
});

test('a manual reply is still refused when the customer wrote after it was typed', async () => {
  const w = world({
    action: MANUAL,
    later: [{ id: 'm2', direction: 'inbound', actor: 'customer', received_at: '2026-09-28T10:00:00Z' }]
  });
  const totals = await run(w);
  assert.equal(totals.cancelled, 1);
  assert.equal(w.actions.get('a1').cancel_reason, 'customer_wrote_again');
  assert.equal(sent(w).length, 0);
});
