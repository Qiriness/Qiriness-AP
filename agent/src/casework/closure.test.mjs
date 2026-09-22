import assert from 'node:assert/strict';
import test from 'node:test';

import { closureAllowed } from '../drafting/draft-rules.mjs';
import { buildClosurePrompt, readsAsClosure } from './closure.mjs';

function openaiReturning(answer) {
  const calls = [];
  return {
    calls,
    async completeJson(request) {
      calls.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

// --- the code half, which runs first ------------------------------------------

test('a dossier with nothing outstanding may be closed by the customer', () => {
  assert.equal(closureAllowed({ verdict: 'answerable', missing: [], handoff: null }), true);
});

test('a point sitting with a colleague is not closed by a thank-you', () => {
  // `d6d0d1c3`: « J'ai bien réceptionné le colis. Merci encore » — and the free
  // mask is still missing, so the case file reads needs_human. Read on the
  // message alone this is a closure; read against the dossier it is a customer
  // being gracious about half of their problem.
  assert.equal(closureAllowed({ verdict: 'needs_human', missing: [], handoff: null }), false);
  assert.equal(
    closureAllowed({ verdict: 'answerable', missing: [], handoff: { why: 'vérifier le masque' } }),
    false
  );
});

test('a question we asked is still outstanding', () => {
  assert.equal(
    closureAllowed({ verdict: 'answerable', missing: [{ field: 'shopify_order_number' }], handoff: null }),
    false
  );
  assert.equal(closureAllowed({ verdict: 'needs_customer_input', missing: [], handoff: null }), false);
});

test('no case file closes nothing', () => {
  assert.equal(closureAllowed(null), false);
  assert.equal(closureAllowed(undefined), false);
});

// --- the read, which only happens once the code half allows it ----------------

test('only the customer’s own words are read, never the quoted chain', () => {
  const prompt = buildClosurePrompt({
    body_text: 'Merci, tout est réglé.\n\nLe 3 août 2026, Qiriness a écrit :\n> pouvez-vous confirmer ?'
  });
  assert.ok(prompt.includes('tout est réglé'));
  assert.ok(!prompt.includes('pouvez-vous confirmer'));
});

test('a closure is reported with the sentence that justifies it', async () => {
  const openai = openaiReturning({ closes: true, why: 'le client confirme avoir reçu sa commande' });
  const result = await readsAsClosure({
    openai,
    model: 'gpt-4o-mini',
    message: { body_text: 'Je vous confirme que j’ai bien reçu ma commande.' },
    ticketId: 'tk1'
  });

  assert.equal(result.closes, true);
  assert.match(result.why, /confirme/);
  assert.equal(openai.calls[0].pass, 'closure');
});

test('an empty message closes nothing, and costs no call', async () => {
  // NOT THE SAME AS "only a quoted chain". `splitQuotedReply` returns the whole
  // body as `own` when nothing precedes the quote boundary, so a reply that is
  // only our own mail quoted back still reaches the model — verified against the
  // splitter rather than assumed. That is the shared module's behaviour and not
  // this file's to second-guess. What is guarded here is a genuinely empty body.
  const openai = openaiReturning({ closes: true, why: 'should never be reached' });
  for (const body_text of ['', '   \n  ', null]) {
    const result = await readsAsClosure({ openai, model: 'gpt-4o-mini', message: { body_text } });
    assert.equal(result.closes, false);
  }
  assert.equal(openai.calls.length, 0);
});

test('a failed call is never a closure', async () => {
  // The dangerous direction is a rate limit quietly shortening a reply to a
  // customer who was still waiting on us. A throw reads as « not a closure »,
  // which is the behaviour before this existed.
  const result = await readsAsClosure({
    openai: openaiReturning(new Error('429 rate limited')),
    model: 'gpt-4o-mini',
    message: { body_text: 'Merci, tout est réglé.' }
  });

  assert.equal(result.closes, false);
  assert.match(result.why, /429/);
});

test('anything but a literal true is not a closure', async () => {
  for (const closes of ['true', 1, null, undefined]) {
    const result = await readsAsClosure({
      openai: openaiReturning({ closes, why: '' }),
      model: 'gpt-4o-mini',
      message: { body_text: 'Merci.' }
    });
    assert.equal(result.closes, false);
  }
});
