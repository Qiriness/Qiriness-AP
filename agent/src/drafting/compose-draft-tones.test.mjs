import assert from 'node:assert/strict';
import test from 'node:test';

import { caseFileFromRow, composeDraftingMessage, promptInputs } from './compose-draft.mjs';

// The tones a rule sets, from the stored row to the drafting prompt.

const EMPTY = {
  verdict: 'answerable',
  established: [],
  unverified: [],
  missing: [],
  doNotClaim: [],
  knowledge: []
};
const MESSAGE = { subject: 'Retard', body_text: 'Ma commande n’est toujours pas partie.' };

test('a rule’s tones are read by name, in catalogue order, unknown ones dropped', () => {
  const caseFile = caseFileFromRow({
    verdict: 'answerable',
    exemplar_match: {
      similarity: 0.8,
      policy: { tones: ['understanding', 'shouty', 'apologetic', 'apologetic'] }
    }
  });
  assert.deepEqual(caseFile.tones, ['apologetic', 'understanding']);
});

test('no rule means no tone, as an empty list', () => {
  assert.deepEqual(caseFileFromRow({}).tones, []);
});

test('the tones reach the prompt as an adjustment to the brand voice, never a replacement', () => {
  const prompt = composeDraftingMessage({
    message: MESSAGE,
    caseFile: { ...EMPTY, tones: ['apologetic'] }
  });
  assert.match(prompt, /## Ton de cette réponse/);
  assert.match(prompt, /sans la remplacer/);
  assert.match(prompt, /- Désolé : /);
  assert.match(prompt, /n’est pas reconnaître une faute/);
});

test('several tones are told to combine; one is not', () => {
  const two = composeDraftingMessage({
    message: MESSAGE,
    caseFile: { ...EMPTY, tones: ['understanding', 'apologetic'] }
  });
  assert.match(two, /se cumulent/);

  const one = composeDraftingMessage({ message: MESSAGE, caseFile: { ...EMPTY, tones: ['firm'] } });
  assert.doesNotMatch(one, /se cumulent/);
});

test('no tone leaves the prompt exactly as it was', () => {
  // Every rule saved before tones existed carries `{}`, and its drafts must not move.
  assert.equal(
    composeDraftingMessage({ message: MESSAGE, caseFile: { ...EMPTY, tones: [] } }),
    composeDraftingMessage({ message: MESSAGE, caseFile: EMPTY })
  );
});

test('the tone sits after the guidance and before the code', () => {
  // The skeleton says what the reply does, the tone how it lands, the code what it
  // does it with.
  const prompt = composeDraftingMessage({
    message: MESSAGE,
    caseFile: { ...EMPTY, answerSkeleton: 'Donner le code.', offerCode: 'QIRINESS20', tones: ['reassuring'] },
    offerableCodes: new Set(['QIRINESS20'])
  });
  const guidance = prompt.indexOf('## Ce que cette réponse doit faire');
  const tone = prompt.indexOf('## Ton de cette réponse');
  const code = prompt.indexOf('## Code à communiquer au client');
  assert.ok(guidance >= 0 && tone > guidance && code > tone, 'guidance, then tone, then code');
});

test('the prompt inputs record which tones were asked for', () => {
  const toned = promptInputs({
    caseFile: caseFileFromRow({ verdict: 'answerable', exemplar_match: { policy: { tones: ['firm'] } } }),
    investigationId: 'i',
    model: 'm'
  });
  assert.deepEqual(toned.tones, ['firm']);

  const plain = promptInputs({ caseFile: caseFileFromRow({ verdict: 'answerable' }), investigationId: 'i', model: 'm' });
  assert.deepEqual(plain.tones, []);
});
