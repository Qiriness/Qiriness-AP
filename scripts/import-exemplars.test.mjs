import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { attachTranslations } from './import-exemplars.mjs';
import {
  TRANSLATION_INDEX_BASE,
  parseExemplarDocument,
  validateExemplar
} from './lib/exemplar-import.mjs';
import { sourceHash, translationIndex } from './lib/exemplar-translation.mjs';

const exemplar = (phrasings) => ({
  exemplarKey: 'D-33',
  phrasings: phrasings.map((p, index) => ({
    index,
    kind: index === 0 ? 'canonical' : 'variant',
    language: 'fr',
    ...p
  }))
});

const entry = (overrides) => ({
  index: translationIndex(0, 'en'),
  sourceIndex: 0,
  sourceLanguage: 'fr',
  language: 'en',
  ...overrides
});

test('a translation is attached as a phrasing the upsert can write', () => {
  const e = exemplar([{ text: 'Livrez-vous dans mon pays ?' }]);
  const held = {
    'D-33': {
      '0:en': entry({
        sourceHash: sourceHash('Livrez-vous dans mon pays ?'),
        text: 'Do you deliver to my country?'
      })
    }
  };

  const result = attachTranslations([e], held);

  assert.deepEqual(result, { attached: 1, dropped: 0 });
  assert.equal(e.phrasings.length, 2);

  const [, translated] = e.phrasings;
  assert.equal(translated.kind, 'translated');
  assert.equal(translated.language, 'en');
  assert.equal(translated.translatedFromIndex, 0);
  assert.ok(translated.index >= TRANSLATION_INDEX_BASE);
});

test('a translation whose source text has changed is dropped, not written', () => {
  // THE ONE THAT MATTERS. Editing a French variant without re-running the
  // translator would otherwise leave four rows in the retrieval index answering
  // a question nobody asks any more — and they look exactly like fresh ones.
  const e = exemplar([{ text: 'Livrez-vous dans mon pays, finalement ?' }]);
  const held = {
    'D-33': {
      '0:en': entry({ sourceHash: sourceHash('Livrez-vous dans mon pays ?'), text: 'stale' })
    }
  };

  const warnings = [];
  const result = attachTranslations([e], held, (m) => warnings.push(m));

  assert.deepEqual(result, { attached: 0, dropped: 1 });
  assert.equal(e.phrasings.length, 1);
  assert.match(warnings[0], /source text has changed/);
});

test('a translation of a deleted variant is dropped', () => {
  const e = exemplar([{ text: 'Livrez-vous dans mon pays ?' }]);
  const held = {
    'D-33': {
      '4:en': entry({ sourceIndex: 4, sourceHash: sourceHash('gone'), text: 'orphan' })
    }
  };

  const warnings = [];
  const result = attachTranslations([e], held, (m) => warnings.push(m));

  assert.deepEqual(result, { attached: 0, dropped: 1 });
  assert.match(warnings[0], /which no longer exists/);
});

test('an exemplar with no translations is left exactly as it was', () => {
  const e = exemplar([{ text: 'Livrez-vous dans mon pays ?' }]);
  const result = attachTranslations([e], {});

  assert.deepEqual(result, { attached: 0, dropped: 0 });
  assert.equal(e.phrasings.length, 1);
});

test('the real corpus attaches every translation it holds, with none stale', () => {
  // The file and the document are edited independently, so this is the check
  // that they are still describing the same phrasings.
  const documentUrl = new URL('../Email-Example-Queries.md', import.meta.url);
  const translationsUrl = new URL('../Email-Example-Queries.translations.json', import.meta.url);

  if (!existsSync(translationsUrl)) return; // nothing generated yet

  const exemplars = parseExemplarDocument(readFileSync(documentUrl, 'utf8')).filter(
    (x) => validateExemplar(x).length === 0
  );
  const held = JSON.parse(readFileSync(translationsUrl, 'utf8')).exemplars ?? {};

  const warnings = [];
  const result = attachTranslations(exemplars, held, (m) => warnings.push(m));

  assert.equal(result.dropped, 0, `stale translations: ${warnings.join('; ')}`);
  assert.ok(result.attached > 0, 'the translations file attached nothing');
});
