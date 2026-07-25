import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpamClassifier } from './spam-classifier.mjs';

function fakeOpenAI(result) {
  return {
    async completeJson() {
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const item = (fromEmail = 'x@y.com') => ({
  removed: false,
  message: { from_email: fromEmail, subject: 'Subject', body_text: 'Body' }
});

test('flags a spam label as spam', async () => {
  const { triage } = createSpamClassifier(fakeOpenAI({ label: 'spam', reason: 'r' }), { model: 'm' });
  const verdict = await triage(item());
  assert.equal(verdict.spam, true);
  assert.equal(verdict.label, 'spam');
});

test('keeps keep and irrelevant by default (only spam is dropped)', async () => {
  const keep = await createSpamClassifier(fakeOpenAI({ label: 'keep', reason: 'r' }), { model: 'm' }).triage(item());
  const irrelevant = await createSpamClassifier(fakeOpenAI({ label: 'irrelevant', reason: 'r' }), { model: 'm' }).triage(item());
  assert.equal(keep.spam, false);
  assert.equal(irrelevant.spam, false);
});

test('fails OPEN on a classifier error — never drops a real email', async () => {
  const { triage } = createSpamClassifier(fakeOpenAI(new Error('boom')), { model: 'm', logger: { warn() {} } });
  const verdict = await triage(item());
  assert.equal(verdict.spam, false);
  assert.equal(verdict.error, true);
});

test('a missing message is not spam', async () => {
  const { triage } = createSpamClassifier(fakeOpenAI({ label: 'spam', reason: 'r' }), { model: 'm' });
  assert.equal((await triage({ removed: false })).spam, false);
});
