import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorExpiredError, assertMailProvider, replyHtml } from './mail-provider.mjs';
import { createOutlookGraphAdapter } from './outlook-graph-adapter.mjs';

function rejected(status) {
  const error = new Error(`Graph delta request failed: ${status}`);
  error.status = status;
  error.code = status === 410 ? 'SyncStateNotFound' : 'BadRequest';
  error.linkRejected = true;
  return error;
}

const raw = (id, address) => ({
  id,
  conversationId: 'c1',
  from: { emailAddress: { address } },
  receivedDateTime: '2026-09-28T09:00:00Z',
  body: { contentType: 'text', content: 'hello' }
});

test('it is a whole MailProvider', () => {
  assert.doesNotThrow(() => createOutlookGraphAdapter({ graphClient: {} }));
  assert.throws(() => assertMailProvider({ getChanges() {} }), /missing getMessage/);
});

test('getChanges maps Graph pages into items and cursors', async () => {
  const requests = [];
  const graphClient = {
    async getDeltaPage(url, options) {
      requests.push({ url, options });
      return { messages: [raw('m1', 'marie@example.com'), raw('m2', 'support@shop.example')], nextLink: 'next', deltaLink: null };
    }
  };
  const adapter = createOutlookGraphAdapter({ graphClient, mailbox: 'support@shop.example' });
  const page = await adapter.getChanges('inbox', 'saved', { stableIds: true });

  assert.deepEqual(requests, [{ url: 'saved', options: { top: undefined, immutableIds: true, folder: 'inbox' } }]);
  assert.equal(page.nextCursor, 'next');
  assert.equal(page.deltaCursor, null);
  assert.deepEqual(page.items.map((i) => [i.graphMessageId, i.message.direction]), [
    ['m1', 'inbound'],
    ['m2', 'outbound']
  ]);
});

test('everything in Sent Items is ours, whoever the envelope names', async () => {
  const graphClient = { getDeltaPage: async () => ({ messages: [raw('s1', 'someone@else.example')], nextLink: null, deltaLink: 'd' }) };
  const page = await createOutlookGraphAdapter({ graphClient }).getChanges('sentitems', null);
  assert.equal(page.items[0].message.direction, 'outbound');
});

test('a SAVED cursor Graph refuses becomes CursorExpiredError; a fresh read that fails stays an error', async () => {
  const graphClient = {
    getDeltaPage: async () => {
      throw rejected(410);
    }
  };
  const adapter = createOutlookGraphAdapter({ graphClient });
  const expired = await adapter.getChanges('inbox', 'saved').catch((e) => e);
  assert.ok(expired instanceof CursorExpiredError);
  assert.equal(expired.status, 410);
  assert.equal(expired.code, 'SyncStateNotFound');

  const fresh = await adapter.getChanges('inbox', null).catch((e) => e);
  assert.ok(!(fresh instanceof CursorExpiredError));
});

test('a reply draft is created with an HTML body and an explicit To line', async () => {
  const calls = [];
  const graphClient = {
    async createReplyDraft(messageId, options) {
      calls.push([messageId, options]);
      return { id: 'AAMk-draft', internetMessageId: '<x@y>' };
    }
  };
  const adapter = createOutlookGraphAdapter({ graphClient });
  const draft = await adapter.createReplyDraft('AAMk-customer', { bodyText: 'Bonjour <Marie>', to: ['marie@example.com'] });
  assert.deepEqual(draft, { draftId: 'AAMk-draft', internetMessageId: '<x@y>' });
  assert.deepEqual(calls, [['AAMk-customer', { html: '<p>Bonjour &lt;Marie&gt;</p>', toRecipients: ['marie@example.com'] }]]);
});

test('findSentMessage reads the draft\'s state: gone, still a draft, or sent', async () => {
  const states = { a: null, b: { isDraft: true }, c: { isDraft: false } };
  const adapter = createOutlookGraphAdapter({ graphClient: { getDraftState: async (id) => states[id] } });
  assert.equal(await adapter.findSentMessage({ draftId: 'a' }), 'missing');
  assert.equal(await adapter.findSentMessage({ draftId: 'b' }), 'draft');
  assert.equal(await adapter.findSentMessage({ draftId: 'c' }), 'sent');
});

test('reply HTML escapes the text and keeps its paragraphs and line breaks, nothing more', () => {
  assert.equal(
    replyHtml('Bonjour Marie,\r\n\r\nVotre colis <n°12> part "demain" & arrive\njeudi.\n\n\nCordialement'),
    '<p>Bonjour Marie,</p>\n<p>Votre colis &lt;n°12&gt; part &quot;demain&quot; &amp; arrive<br>jeudi.</p>\n<p>Cordialement</p>'
  );
});
