import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSLATION_INDEX_BASE, parseExemplarDocument } from './exemplar-import.mjs';
import { REPLY_LANGUAGES } from './support-taxonomy.mjs';
import {
  LANGUAGE_NAMES,
  MAX_AUTHORED_PHRASINGS,
  TRANSLATION_LANGUAGES,
  TRANSLATION_SCHEMA,
  buildTranslationPrompt,
  planTranslations,
  sourceHash,
  translationIndex,
  translationRows,
  validateTranslation
} from './exemplar-translation.mjs';

test('every translation language is in the reply vocabulary', () => {
  for (const code of TRANSLATION_LANGUAGES) {
    assert.ok(REPLY_LANGUAGES.includes(code), `${code} is not a reply language`);
    assert.ok(LANGUAGE_NAMES[code], `${code} has no name for the prompt`);
  }
});

test('every index a translation can take is above the pruner base', () => {
  for (let source = 0; source < MAX_AUTHORED_PHRASINGS; source += 1) {
    for (const language of TRANSLATION_LANGUAGES) {
      assert.ok(
        translationIndex(source, language) >= TRANSLATION_INDEX_BASE,
        `${source}/${language} would land in the authored space`
      );
    }
  }
});

test('indexes are unique across every source and language pair', () => {
  const seen = new Set();
  for (let source = 0; source < MAX_AUTHORED_PHRASINGS; source += 1) {
    for (const language of TRANSLATION_LANGUAGES) {
      const index = translationIndex(source, language);
      assert.ok(!seen.has(index), `collision at ${index}`);
      seen.add(index);
    }
  }
});

test('an index is stable across calls, which is what makes the upsert idempotent', () => {
  assert.equal(translationIndex(3, 'de'), translationIndex(3, 'de'));
  assert.equal(translationIndex(0, 'fr'), TRANSLATION_INDEX_BASE);
});

test('a source past the ceiling throws rather than writing a misaddressed row', () => {
  assert.throws(() => translationIndex(MAX_AUTHORED_PHRASINGS, 'en'), /ceiling/);
  assert.throws(() => translationIndex(-1, 'en'), /bad source index/);
  assert.throws(() => translationIndex(0, 'nl'), /no slot/);
});

test('a phrasing is never translated into the language it is already in', () => {
  const { plans } = planTranslations([
    { index: 0, text: 'Où en est ma commande ?', language: 'fr' },
    { index: 1, text: 'Do you ship to Germany?', language: 'en' }
  ]);

  const french = plans.filter((p) => p.sourceIndex === 0).map((p) => p.language);
  const english = plans.filter((p) => p.sourceIndex === 1).map((p) => p.language);

  assert.deepEqual(french.sort(), ['de', 'en', 'es', 'it']);
  assert.deepEqual(english.sort(), ['de', 'es', 'fr', 'it']);
});

test('a phrasing with no declared language is treated as French', () => {
  const { plans } = planTranslations([{ index: 0, text: 'Je souhaite annuler ma commande.' }]);
  assert.ok(!plans.some((p) => p.language === 'fr'));
  assert.equal(plans.length, 4);
});

test('a Dutch phrasing is translated into all five, because nl is not a target', () => {
  const { plans } = planTranslations([
    { index: 0, text: 'Kan geen bestelling plaatsen', language: 'nl' }
  ]);
  assert.equal(plans.length, TRANSLATION_LANGUAGES.length);
  assert.deepEqual(
    plans.map((p) => p.language).sort(),
    [...TRANSLATION_LANGUAGES].sort()
  );
});

test('--languages narrows the targets, which is how the French-first pass runs', () => {
  const { plans } = planTranslations(
    [
      { index: 0, text: 'Où en est ma commande ?', language: 'fr' },
      { index: 1, text: 'Do you ship to Germany?', language: 'en' }
    ],
    { languages: ['fr'] }
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0].sourceIndex, 1);
  assert.equal(plans[0].language, 'fr');
});

test('an unchanged translation is kept rather than re-requested', () => {
  const text = 'Do you ship to Germany?';
  const existing = {
    '0:en': { text: 'Livrez-vous en Allemagne ?', sourceHash: sourceHash(text) }
  };

  const { plans, fresh } = planTranslations([{ index: 0, text, language: 'fr' }], {
    languages: ['en'],
    existing
  });

  assert.equal(plans.length, 0);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].text, 'Livrez-vous en Allemagne ?');
});

test('editing the source invalidates its translation', () => {
  const existing = {
    '0:en': { text: 'Livrez-vous en Allemagne ?', sourceHash: sourceHash('old text') }
  };

  const { plans, fresh } = planTranslations([{ index: 0, text: 'new text', language: 'fr' }], {
    languages: ['en'],
    existing
  });

  assert.equal(fresh.length, 0);
  assert.equal(plans.length, 1);
});

test('a held entry with no text is re-requested rather than written empty', () => {
  const existing = { '0:en': { text: '', sourceHash: sourceHash('t') } };
  const { plans } = planTranslations([{ index: 0, text: 't', language: 'fr' }], {
    languages: ['en'],
    existing
  });
  assert.equal(plans.length, 1);
});

test('an unknown target language throws instead of planning nothing', () => {
  assert.throws(
    () => planTranslations([{ index: 0, text: 't', language: 'fr' }], { languages: ['nl'] }),
    /not a translation language/
  );
});

test('the prompt names both languages and carries the register rule', () => {
  const { system, user } = buildTranslationPrompt({
    sourceText: 'jai pas recu ma commande',
    sourceLanguage: 'fr',
    language: 'de'
  });

  assert.match(system, /French line into German/);
  assert.match(system, /KEEP THE REGISTER/);
  assert.match(system, /order numbers/i);
  assert.equal(user, 'jai pas recu ma commande');
});

test('the schema admits one field and nothing else', () => {
  assert.deepEqual(TRANSLATION_SCHEMA.required, ['translation']);
  assert.equal(TRANSLATION_SCHEMA.additionalProperties, false);
});

test('validation rejects the four mechanical failures', () => {
  const sourceText = 'Do you ship to Germany?';

  assert.deepEqual(validateTranslation({ text: '  ', sourceText, language: 'fr' }), ['empty']);
  assert.deepEqual(validateTranslation({ text: sourceText, sourceText, language: 'fr' }), [
    'identical to the source'
  ]);
  assert.deepEqual(
    validateTranslation({ text: '« Livrez-vous en Allemagne ? »', sourceText, language: 'fr' }),
    ['wrapped in quote marks']
  );
  assert.deepEqual(validateTranslation({ text: 'ok', sourceText, language: 'nl' }), [
    'nl is not a translation language'
  ]);
});

test('a translation is not rejected for a quote its source also has', () => {
  // P-17's source ends « … quand je clique sur "je le veux" », so a faithful
  // translation ends in a quote mark. Three real translations were thrown away
  // by a check that tested the first and last character separately.
  assert.deepEqual(
    validateTranslation({
      text: 'I am offered a free mask with my order but when I click on "I want it"',
      sourceText:
        'on m\'offre un masque gratuit lors de ma commande mais quand je clique sur "je le veux"',
      language: 'en'
    }),
    []
  );
});

test('a translation the model quoted whole is still rejected', () => {
  assert.deepEqual(
    validateTranslation({
      text: '"Where is my order?"',
      sourceText: 'Où en est ma commande ?',
      language: 'en'
    }),
    ['wrapped in quote marks']
  );
});

test('validation passes a normal translation', () => {
  assert.deepEqual(
    validateTranslation({
      text: 'Livrez-vous en Allemagne ?',
      sourceText: 'Do you ship to Germany?',
      language: 'fr'
    }),
    []
  );
});

test('rows carry the kind, the language and the source the constraint requires', () => {
  const [row] = translationRows([
    { index: 101, sourceIndex: 0, language: 'en', text: 'Where is my order?' }
  ]);

  assert.equal(row.phrasing_kind, 'translated');
  assert.equal(row.language, 'en');
  assert.equal(row.translated_from_index, 0);
  assert.ok(row.phrasing_index >= TRANSLATION_INDEX_BASE);
  assert.notEqual(row.phrasing_index, row.translated_from_index);
});

// The ceiling is a claim about the document, so the document is what checks it.
test('no exemplar in the corpus has more phrasings than the index scheme holds', async () => {
  const { readFileSync } = await import('node:fs');
  const markdown = readFileSync(new URL('../../Email-Example-Queries.md', import.meta.url), 'utf8');
  const exemplars = parseExemplarDocument(markdown);

  assert.ok(exemplars.length > 0, 'the document parsed to nothing');
  for (const exemplar of exemplars) {
    assert.ok(
      exemplar.phrasings.length <= MAX_AUTHORED_PHRASINGS,
      `${exemplar.exemplarKey} has ${exemplar.phrasings.length} phrasings`
    );
  }
});
