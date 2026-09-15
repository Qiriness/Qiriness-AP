import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NONE,
  buildChooserUser,
  chooserSchema,
  createSituationChooser,
  createVariantLoader
} from './situation-chooser.mjs';

const CANDIDATES = [
  { exemplarKey: 'D-36', question: 'Ma commande a beaucoup de retard…', similarity: 0.63 },
  { exemplarKey: 'D-07', question: 'Quels sont vos délais ?', similarity: 0.6 }
];

function fakeOpenAI(answer) {
  const calls = [];
  return {
    calls,
    async completeJson(args) {
      calls.push(args);
      return typeof answer === 'function' ? answer(args) : answer;
    }
  };
}

test('it offers exactly the candidates plus none, and nothing else', () => {
  const schema = chooserSchema(['D-36', 'D-07']);
  assert.deepEqual(schema.properties.choice.enum, ['D-36', 'D-07', NONE]);
  // Strict structured outputs require every property to be required.
  assert.deepEqual(schema.required, ['choice', 'reason']);
  assert.equal(schema.additionalProperties, false);
});

test('the choice comes back with the reason, the model and what it chose from', async () => {
  const openai = fakeOpenAI({ choice: 'D-07', reason: 'Le client demande un délai de livraison.' });
  const choose = createSituationChooser(openai, { model: 'gpt-4o-mini' });

  const result = await choose({ subject: 'Livraison', body: 'Sera-t-elle livrée samedi ?', candidates: CANDIDATES, ticketId: 't1' });

  assert.deepEqual(result, {
    choice: 'D-07',
    reason: 'Le client demande un délai de livraison.',
    model: 'gpt-4o-mini',
    candidates: ['D-36', 'D-07']
  });
  // Its spend is its own row in llm_usage, tied to the ticket.
  assert.equal(openai.calls[0].pass, 'situation');
  assert.equal(openai.calls[0].ticketId, 't1');
});

test('none is returned as no situation', async () => {
  const choose = createSituationChooser(fakeOpenAI({ choice: 'none', reason: 'Changement de téléphone.' }), { model: 'm' });
  const result = await choose({ subject: '', body: 'Modification de mon numéro', candidates: CANDIDATES });
  assert.equal(result.choice, null);
  assert.equal(result.reason, 'Changement de téléphone.');
});

test('a key outside the candidates is never accepted', async () => {
  const choose = createSituationChooser(fakeOpenAI({ choice: 'O-09', reason: 'x' }), { model: 'm' });
  const result = await choose({ subject: '', body: 'x', candidates: CANDIDATES });
  assert.equal(result.choice, null);
});

test('no candidates means no call at all', async () => {
  const openai = fakeOpenAI({ choice: 'none', reason: '' });
  const choose = createSituationChooser(openai, { model: 'm' });
  const result = await choose({ subject: '', body: 'x', candidates: [] });
  assert.equal(result.choice, null);
  assert.equal(openai.calls.length, 0);
});

test('a failed call throws, so the caller can tell it from a model saying none', async () => {
  const choose = createSituationChooser(
    { async completeJson() { throw new Error('429'); } },
    { model: 'm' }
  );
  await assert.rejects(() => choose({ subject: '', body: 'x', candidates: CANDIDATES }), /429/);
});

test('a failed phrasing load narrows the prompt, not the run', async () => {
  const openai = fakeOpenAI({ choice: 'D-36', reason: 'retard' });
  const choose = createSituationChooser(openai, {
    model: 'm',
    loadVariants: async () => { throw new Error('down'); },
    logger: { warn() {} }
  });
  const result = await choose({ subject: '', body: 'retard', candidates: CANDIDATES });
  assert.equal(result.choice, 'D-36');
});

test('the prompt shows the message and each candidate with its phrasings', () => {
  const user = buildChooserUser({
    subject: 'Commande',
    body: 'Je n’ai rien reçu',
    candidates: CANDIDATES,
    variantsByKey: new Map([['D-36', ['a', 'b', 'c', 'd']]])
  });
  assert.match(user, /Objet : Commande/);
  assert.match(user, /\[D-36\] Ma commande a beaucoup de retard/);
  assert.match(user, /« c »/);
  assert.doesNotMatch(user, /« d »/, 'three phrasings per candidate, no more');
  assert.match(user, /\[D-07\] Quels sont vos délais/);
});

test('the variant loader keeps authored phrasings in order, skips the canonical, and caches', async () => {
  let loads = 0;
  let clock = 0;
  const load = createVariantLoader({
    selectExemplars: async () => {
      loads += 1;
      return [{ id: 'e1', exemplar_key: 'D-01', canonical_question: 'Où en est ma commande ?' }];
    },
    selectPhrasings: async () => [
      { support_exemplar_id: 'e1', phrasing_index: 2, phrasing_kind: 'variant', phrasing_text: 'second' },
      { support_exemplar_id: 'e1', phrasing_index: 0, phrasing_kind: 'canonical', phrasing_text: 'Où en est ma commande ?' },
      { support_exemplar_id: 'e1', phrasing_index: 1, phrasing_kind: 'variant', phrasing_text: 'first' },
      { support_exemplar_id: 'gone', phrasing_index: 1, phrasing_kind: 'variant', phrasing_text: 'orphan' }
    ],
    now: () => clock
  });

  assert.deepEqual((await load()).get('D-01'), ['first', 'second']);
  clock += 60_000;
  await load();
  assert.equal(loads, 1, 'reused inside the cache window');
  clock += 20 * 60_000;
  await load();
  assert.equal(loads, 2, 'reloaded once the window has passed');
});
