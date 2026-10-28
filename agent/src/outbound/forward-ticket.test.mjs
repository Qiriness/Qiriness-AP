import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_ATTACHMENT_BYTES, carryOutForward, forwardBody, sourceMessage } from './forward-ticket.mjs';

const thread = [
  { id: 'm1', graph_message_id: 'g1', direction: 'inbound', actor: 'customer', from_name: 'Camille', from_email: 'camille@gmail.com', body_text: 'Mon colis est perdu.', has_attachments: true, received_at: '2026-10-01T09:00:00Z' },
  { id: 'm2', graph_message_id: 'g2', direction: 'outbound', actor: 'support', body_text: 'Nous regardons.', has_attachments: false, received_at: '2026-10-01T10:00:00Z' },
  { id: 'm3', graph_message_id: 'g3', direction: 'inbound', actor: 'customer', from_name: 'Camille', from_email: 'camille@gmail.com', body_text: 'Toujours rien.', has_attachments: true, received_at: '2026-10-02T09:00:00Z' }
];

/** An in-memory forward record with the state machine's conditional moves. */
function fakeForwards(initial) {
  const rows = new Map([[initial.id, { ...initial }]]);
  const move = (id, from, patch) => {
    const row = rows.get(id);
    if (!row || !(Array.isArray(from) ? from : [from]).includes(row.state)) return null;
    Object.assign(row, patch);
    return { ...row };
  };
  return {
    rows,
    get: async (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    markDraftCreated: async (id, f) => move(id, 'queued', { state: 'draft_created', provider_draft_id: f.providerDraftId, internet_message_id: f.internetMessageId, attachments_skipped: f.attachmentsSkipped }),
    markSendRequested: async (id, f) => move(id, 'draft_created', { state: 'send_requested', attachments_sent: f.attachmentsSent }),
    markSent: async (id) => move(id, ['draft_created', 'send_requested'], { state: 'sent' }),
    markHeld: async (id, f) => move(id, 'draft_created', { state: 'held', attachments_sent: f.attachmentsSent }),
    restart: async (id) => move(id, 'draft_created', { state: 'queued', provider_draft_id: null }),
    markFailed: async (id, error) => move(id, ['queued', 'draft_created', 'send_requested'], { state: 'failed', error })
  };
}

function fakeProvider({ attachments = {}, sentState = 'draft' } = {}) {
  const calls = [];
  return {
    calls,
    createForwardDraft: async (messageId, args) => {
      calls.push(['createForwardDraft', messageId, args]);
      return { draftId: 'd1', internetMessageId: '<fwd@x>' };
    },
    listAttachments: async (messageId) => attachments[messageId] ?? [],
    getAttachment: async (_m, id) => ({ buffer: Buffer.from(id) }),
    addDraftAttachment: async (draftId, file) => calls.push(['attach', draftId, file.name]),
    deleteDraft: async (draftId) => calls.push(['delete', draftId]),
    sendDraft: async (draftId) => calls.push(['send', draftId]),
    findSentMessage: async () => sentState
  };
}

const store = { ticket: async () => ({ id: 't1', ticket_number: 1042 }), thread: async () => thread };
const queued = { id: 'f1', ticket_id: 't1', state: 'queued', note: 'Peux-tu vérifier ?', forwarded_by_name: 'Oscar', recipients: [{ email: 'dounia@lap-groupe.com' }] };

test('the latest customer message is forwarded; the earlier files are added, a too-large one is listed', async () => {
  const forwards = fakeForwards(queued);
  const provider = fakeProvider({
    attachments: {
      g1: [
        { id: 'a1', name: 'photo.jpg', size: 1000, isInline: false },
        { id: 'a2', name: 'video.mov', size: MAX_ATTACHMENT_BYTES + 1, isInline: false },
        { id: 'a3', name: 'logo.png', size: 10, isInline: true }
      ]
    }
  });
  const outcome = await carryOutForward('f1', { forwards, store, provider });
  assert.equal(outcome, 'sent');
  const [, source, args] = provider.calls.find((call) => call[0] === 'createForwardDraft');
  assert.equal(source, 'g3');
  assert.deepEqual(args.to, ['dounia@lap-groupe.com']);
  assert.match(args.html, /Peux-tu vérifier/);
  assert.match(args.html, /ticket T-1042/);
  assert.match(args.html, /video\.mov — non jointe \(trop volumineuse\)/);
  assert.deepEqual(provider.calls.filter((c) => c[0] === 'attach').map((c) => c[2]), ['photo.jpg']);
  assert.deepEqual(provider.calls.at(-1), ['send', 'd1']);
  const row = forwards.rows.get('f1');
  assert.equal(row.state, 'sent');
  assert.equal(row.internet_message_id, '<fwd@x>');
  assert.equal(row.attachments_sent, 1);
});

test('held in Outlook Drafts when sending is stopped before the send', async () => {
  const forwards = fakeForwards(queued);
  const provider = fakeProvider();
  assert.equal(await carryOutForward('f1', { forwards, store, provider, stopBeforeSend: true }), 'held');
  assert.equal(forwards.rows.get('f1').state, 'held');
  assert.equal(provider.calls.some((c) => c[0] === 'send'), false);
});

test('a retry never sends twice: a maybe-sent forward is asked about first', async () => {
  const forwards = fakeForwards({ ...queued, state: 'send_requested', provider_draft_id: 'd1' });
  const provider = fakeProvider({ sentState: 'sent' });
  assert.equal(await carryOutForward('f1', { forwards, store, provider }), 'sent');
  assert.equal(provider.calls.length, 0);
});

test('a half-built draft is thrown away and the forward starts again', async () => {
  const forwards = fakeForwards({ ...queued, state: 'draft_created', provider_draft_id: 'old' });
  const provider = fakeProvider();
  assert.equal(await carryOutForward('f1', { forwards, store, provider }), 'sent');
  assert.deepEqual(provider.calls[0], ['delete', 'old']);
});

test('the body names every message, oldest first, with only its new text', () => {
  const html = forwardBody({ messages: thread, ticketLabel: 'T-1', forwardedByName: 'Oscar' });
  assert.ok(html.indexOf('Mon colis est perdu.') < html.indexOf('Toujours rien.'));
  assert.match(html, /Service client/);
  assert.match(html, /Camille &lt;camille@gmail\.com&gt;/);
  assert.equal(forwardBody({ note: '<b>x</b>' }).includes('<b>x</b>'), false);
});

test('the source is the latest customer message, else the latest inbound one', () => {
  assert.equal(sourceMessage(thread).id, 'm3');
  assert.equal(sourceMessage([{ ...thread[0], actor: 'colleague' }]).id, 'm1');
  assert.equal(sourceMessage([thread[1]]), null);
});
