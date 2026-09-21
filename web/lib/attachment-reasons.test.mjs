import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_REASONS,
  ATTACHMENT_REASON_FALLBACK,
  fetchAttachmentReason
} from './attachment-reasons.ts';

// Every reason the route can put in the header, from attachment-service.ts.
const ROUTE_REASONS = [
  'not_found',
  'message_gone',
  'mailbox_mismatch',
  'too_large',
  'graph_not_configured',
  'graph_unavailable'
];

test('every failure the route can report has its own sentence', () => {
  // The bug this replaces was one sentence for six causes. A reason with no
  // entry silently falls back to that sentence, so the set has to be complete.
  for (const reason of ROUTE_REASONS) {
    assert.ok(ATTACHMENT_REASONS[reason], `no sentence for ${reason}`);
  }
  assert.equal(Object.keys(ATTACHMENT_REASONS).length, ROUTE_REASONS.length);
});

test('the sentences do not all say the same thing', () => {
  const sentences = new Set(Object.values(ATTACHMENT_REASONS));
  assert.equal(sentences.size, ROUTE_REASONS.length, 'two reasons share a sentence');
});

test('a misconfigured deployment is not described as lost mail', () => {
  // THE WHOLE POINT. « the message may have left the mailbox » sent an operator
  // to Outlook for a photo that was there, while the real fault was an unset
  // MS_GRAPH_* on the deployment.
  const text = ATTACHMENT_REASONS.graph_not_configured;
  assert.doesNotMatch(text, /left the mailbox/i);
  assert.doesNotMatch(text, /Outlook/i);
  assert.match(text, /credentials/i);

  // And the one case the old sentence was right about still ends in Outlook
  // being pointless, because the mail is genuinely gone.
  assert.match(ATTACHMENT_REASONS.message_gone, /left the mailbox/i);
});

test('the header is read back and mapped', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, cache: init?.cache });
    return { headers: new Headers({ 'X-Attachment-Reason': 'graph_not_configured' }) };
  };

  assert.equal(
    await fetchAttachmentReason('/api/tickets/t1/attachments/0'),
    ATTACHMENT_REASONS.graph_not_configured
  );
  // HEAD, because the failure path wants the header and none of the bytes.
  assert.equal(seen[0].method, 'HEAD');
  assert.equal(seen[0].cache, 'no-store');
});

test('an unknown or missing reason falls back rather than inventing one', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => ({ headers: new Headers({ 'X-Attachment-Reason': 'something_new' }) });
  assert.equal(await fetchAttachmentReason('/x'), ATTACHMENT_REASON_FALLBACK);

  globalThis.fetch = async () => ({ headers: new Headers() });
  assert.equal(await fetchAttachmentReason('/x'), ATTACHMENT_REASON_FALLBACK);
});

test('the reason slug carries no mailbox address or Exchange id', () => {
  // The route now sends the slug as the body so it is readable from an address
  // bar. That is only safe because the slug is a closed enum: `detail` holds
  // Graph's own text, which names the mailbox and the item id, and never leaves
  // the server. If a reason key ever starts carrying data, this catches it.
  for (const reason of Object.keys(ATTACHMENT_REASONS)) {
    assert.match(reason, /^[a-z_]+$/, `${reason} is not a plain slug`);
    assert.doesNotMatch(reason, /@/);
  }
});

test('a network failure on the reason lookup does not throw at the component', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await fetchAttachmentReason('/x'), ATTACHMENT_REASON_FALLBACK);
});
