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

test('carries the reason and model through for the audit trail', async () => {
  const { triage } = createSpamClassifier(
    fakeOpenAI({ label: 'spam', reason: 'prospection SEO non sollicitée' }),
    { model: 'gpt-4o-mini' }
  );
  const verdict = await triage(item());
  assert.equal(verdict.reason, 'prospection SEO non sollicitée');
  assert.equal(verdict.model, 'gpt-4o-mini');
});

test('a fail-open keep says so in the reason, so it is not read as a judged pass', async () => {
  const { triage } = createSpamClassifier(fakeOpenAI(new Error('boom')), {
    model: 'gpt-4o-mini',
    logger: { warn() {} }
  });
  const verdict = await triage(item());
  assert.match(verdict.reason, /fail-open/);
  assert.match(verdict.reason, /boom/);
  assert.equal(verdict.model, 'gpt-4o-mini');
});

test('instructs the model to answer "unsure" for a precautionary keep', async () => {
  // The audit trail's "unsure" value depends on this prompt rule, so pin it here.
  const captured = {};
  const openai = {
    async completeJson(args) {
      Object.assign(captured, args);
      return { label: 'keep', reason: 'unsure' };
    }
  };
  await createSpamClassifier(openai, { model: 'm' }).triage(item());
  assert.match(captured.system, /"unsure"/);
  assert.match(captured.system, /reason/);
});
