import assert from 'node:assert/strict';
import test from 'node:test';

import { REPLY_TONES, TONE_KEYS, normaliseTones, toneInstructions } from './reply-tones.mjs';

test('the catalogue is the six tones the rule editor offers', () => {
  assert.deepEqual(TONE_KEYS, ['reassuring', 'empathetic', 'factual', 'firm', 'apologetic', 'understanding']);
});

test('every tone carries a label, a hint, a prompt name and an instruction', () => {
  for (const [key, tone] of Object.entries(REPLY_TONES)) {
    for (const field of ['label', 'hint', 'name', 'instruction']) {
      assert.ok(String(tone[field] ?? '').trim().length > 0, `${key} has no ${field}`);
    }
  }
});

test('unknown tones are dropped, repeats collapse, and the order is the catalogue’s', () => {
  assert.deepEqual(normaliseTones(['understanding', 'shouty', 'apologetic', 'apologetic']), [
    'apologetic',
    'understanding'
  ]);
});

test('nothing, null and a bare string all read sensibly', () => {
  assert.deepEqual(normaliseTones(undefined), []);
  assert.deepEqual(normaliseTones(null), []);
  assert.deepEqual(normaliseTones('firm'), ['firm']);
});

test('no tone produces no instruction, rather than an empty one', () => {
  assert.equal(toneInstructions([]), null);
  assert.equal(toneInstructions(['not-a-tone']), null);
});

test('one tone is one line, several are told to combine', () => {
  const one = toneInstructions(['firm']);
  assert.match(one, /^- Ferme : /);
  assert.doesNotMatch(one, /se cumulent/);

  const two = toneInstructions(['understanding', 'apologetic']);
  assert.equal(two.split('\n').filter((line) => line.startsWith('- ')).length, 2);
  assert.match(two, /se cumulent/);
});

test('the apology is regret for the inconvenience, never an admission of fault', () => {
  // The line the chase rule in brand-voice.mjs already draws. An apologetic tone
  // that admitted fault would be a reply conceding what no one has decided.
  assert.match(REPLY_TONES.apologetic.instruction, /n’est pas reconnaître une faute/);
});
