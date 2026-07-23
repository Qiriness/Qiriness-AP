import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlToText } from './html-to-text.mjs';

test('decodes common Latin-1 accented-character and smart-quote entities', () => {
  assert.equal(
    htmlToText('<p>Depuis 21 ans, Qiriness puise dans l&rsquo;&eacute;nergie vitale.</p>'),
    'Depuis 21 ans, Qiriness puise dans l’énergie vitale.'
  );
});

test('decodes smart-punctuation entities alongside markup entities', () => {
  assert.equal(
    htmlToText('<p>Qiriness &mdash; caf&eacute; &amp; th&eacute; &hellip;</p>'),
    'Qiriness — café & thé …'
  );
});

test('leaves unknown entities untouched rather than guessing', () => {
  assert.equal(htmlToText('<p>&notarealentity;</p>'), '&notarealentity;');
});
