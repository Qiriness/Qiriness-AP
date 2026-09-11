import { createHash } from 'node:crypto';

import { DEFAULT_PHRASING_LANGUAGE, TRANSLATION_INDEX_BASE } from './exemplar-import.mjs';

// Decides WHAT to translate and WHERE each translation lands. Pure: phrasings
// in, plans out. No model, no database, no clock — the network half lives in
// scripts/translate-exemplars.mjs so every judgement here is unit-testable.
//
// THE LIBRARY IS TRANSLATED, NOT THE QUERY. Measured 2026-08-12: French tickets
// match at median 0.637 and English at 0.476, a gap wider than the whole
// distance between NEAR and MATCHED. Translating the incoming email instead was
// tried and reversed — machine translation of a messy email produces TIDY
// French, and tidy-versus-messy is the exact register gap the variants exist to
// close. See DECISIONS.md, "Translate the library, not the query".
//
// A TRANSLATION NEVER REPLACES ITS SOURCE. The eleven real foreign phrasings in
// the corpus are the most valuable rows in it — Spanish tickets score median
// 0.814, the highest of any language — so `fr` is a TARGET like any other and
// the original stays exactly where it was.

/**
 * The five languages the library carries, and the slot each one owns.
 *
 * A SUBSET OF `REPLY_LANGUAGES` ON PURPOSE. That list is what we can reply in;
 * this is what we have decided to pay to index. `nl` and `pt` are in the
 * vocabulary and are not here: two Dutch phrasings exist and no Portuguese one
 * does, which is not enough demand to justify 140 more rows each. They stay
 * translatable INTO nothing and translatable FROM everything — the two Dutch
 * variants get all five targets like any other source.
 *
 * THE SLOT IS PART OF THE ADDRESS, not a display order, so it must never be
 * reordered: `phrasing_index` is derived from it and a re-run after a shuffle
 * would write every translation to a new row and orphan the old one.
 */
export const TRANSLATION_LANGUAGES = Object.freeze(['fr', 'en', 'es', 'it', 'de']);

const LANGUAGE_SLOT = Object.freeze({ fr: 0, en: 1, es: 2, it: 3, de: 4 });

/** What each code is called in the prompt. The model is told a language, not a code. */
export const LANGUAGE_NAMES = Object.freeze({
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  it: 'Italian',
  de: 'German',
  nl: 'Dutch',
  pt: 'Portuguese',
  other: 'an unidentified language'
});

/**
 * The most authored phrasings one exemplar may have before indexes collide.
 *
 * Ten, because the address is `base + source * 10 + slot` and one decade holds
 * one source. An eleventh source has no decade of its own, so it would have to
 * borrow one and every index past it would mean something different. The
 * document's largest entry has 8 phrasings. Asserted rather than assumed:
 * `translationIndex` throws rather than write a row at an address that no
 * longer decodes.
 */
export const MAX_AUTHORED_PHRASINGS = 10;

/**
 * Where a translation of phrasing N into language L lives.
 *
 * DETERMINISTIC, AND THAT IS THE WHOLE IDEMPOTENCE STORY. The phrasing table is
 * upserted on `(support_exemplar_id, phrasing_index)`, so a re-run that
 * recomputes the same address updates in place; anything positional or
 * append-ordered would write a second copy every time. It also means a
 * translation can be regenerated alone, without touching its neighbours.
 *
 * A DECADE PER SOURCE rather than `count * languages + slot`, so the address
 * survives an authored phrasing being added or removed above it. Renumbering on
 * every edit is exactly what the two index spaces exist to avoid.
 */
export function translationIndex(sourceIndex, language) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error(`translationIndex: bad source index ${sourceIndex}`);
  }
  if (sourceIndex >= MAX_AUTHORED_PHRASINGS) {
    throw new Error(
      `translationIndex: source index ${sourceIndex} is past the ${MAX_AUTHORED_PHRASINGS}-phrasing ceiling`
    );
  }
  const slot = LANGUAGE_SLOT[language];
  if (slot === undefined) {
    throw new Error(`translationIndex: ${language} has no slot`);
  }
  return TRANSLATION_INDEX_BASE + sourceIndex * 10 + slot;
}

/**
 * Hash of the source text a translation was made from.
 *
 * THE STALENESS GATE, and a different one from `content_hash`. That hash covers
 * the row's OWN text and answers "does this need re-embedding". This one covers
 * the text the row was DERIVED from and answers "does this need re-translating".
 * Editing a French variant must invalidate its four translations, and neither
 * the phrasing's own hash nor the embedding's input hash can see that happen.
 */
export function sourceHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * What still needs translating, for one exemplar.
 *
 * Every authored phrasing — the canonical question included — into every
 * TRANSLATION_LANGUAGE except the one it is already written in. A Spanish
 * variant is planned into fr/en/it/de and not into es, which is both a saved
 * call and the reason `language` had to be declared in the document before any
 * of this could run.
 *
 * `existing` is whatever the last run produced, keyed `index:language`. A plan
 * is emitted only where there is no entry or where the source text has changed
 * since — so a re-run after editing one variant costs four calls, not 140.
 */
export function planTranslations(phrasings, { languages = TRANSLATION_LANGUAGES, existing = {} } = {}) {
  const targets = languages.filter((code) => {
    if (LANGUAGE_SLOT[code] === undefined) {
      throw new Error(`planTranslations: ${code} is not a translation language`);
    }
    return true;
  });

  const plans = [];
  const fresh = [];

  for (const phrasing of phrasings) {
    const source = phrasing.language ?? DEFAULT_PHRASING_LANGUAGE;
    for (const language of targets) {
      if (language === source) continue;

      const key = `${phrasing.index}:${language}`;
      const plan = {
        key,
        sourceIndex: phrasing.index,
        sourceLanguage: source,
        sourceText: phrasing.text,
        sourceHash: sourceHash(phrasing.text),
        language,
        index: translationIndex(phrasing.index, language)
      };

      const held = existing[key];
      if (held && held.sourceHash === plan.sourceHash && held.text) {
        fresh.push({ ...plan, text: held.text });
        continue;
      }
      plans.push(plan);
    }
  }

  return { plans, fresh };
}

/**
 * The instruction, and it is mostly about register.
 *
 * THE VARIANTS ARE MESSY ON PURPOSE. They are real customer mail — misspelt,
 * unpunctuated, shouting — and they exist so a messy incoming email meets a
 * messy stored one. A translation that tidies the sentence up rebuilds exactly
 * the mismatch the whole exercise is trying to remove, so "keep the register"
 * is the requirement and "keep the meaning" is the easy part.
 *
 * ORDER NUMBERS, PRODUCT NAMES AND CODES STAY PUT. Several phrasings quote a
 * real order (« Commande #6216 »); a model asked to translate freely will
 * happily localise the word « Commande » and renumber nothing, which is fine,
 * or invent a plausible number, which is not.
 */
export function buildTranslationPrompt({ sourceText, sourceLanguage, language }) {
  const from = LANGUAGE_NAMES[sourceLanguage] ?? sourceLanguage;
  const to = LANGUAGE_NAMES[language] ?? language;

  const system = [
    'You translate real customer-support emails for a retrieval index.',
    '',
    'The text is one line a customer actually wrote to a skincare brand. Your',
    'translation is stored and compared against incoming mail in the target',
    'language, so it has to sound like mail, not like a translation.',
    '',
    'Rules:',
    `- Render the ${from} line into ${to}.`,
    '- KEEP THE REGISTER. If the original is misspelt, lower-case, ungrammatical,',
    '  abrupt or shouting, the translation is too. Do not repair spelling, do not',
    '  add punctuation the original lacks, do not make it polite.',
    '- Keep it the same length and the same one line.',
    '- Leave order numbers, reference codes, dates, prices, product names and',
    '  brand names exactly as they appear. Never invent one.',
    '- A trailing ellipsis means the quote was cut off. Keep it cut off.',
    '- Translate only. Do not answer, explain, or comment.'
  ].join('\n');

  return { system, user: sourceText };
}

/**
 * The JSON shape the model must return. One field, so there is nothing to
 * mis-key and nothing to parse out of prose.
 */
export const TRANSLATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    translation: { type: 'string' }
  },
  required: ['translation'],
  additionalProperties: false
});

/**
 * What disqualifies a translation before it is ever written.
 *
 * NOT QUALITY — that is what review is for. These are the failures that are
 * mechanically detectable and that would each be worse than having no
 * translation at all: nothing came back; the model echoed the source; or it
 * wrapped the line in the quote marks the document uses as delimiters, which
 * would then be embedded as part of the text.
 *
 * A MATCHING PAIR, AND ONLY WHERE THE SOURCE HAS NONE. The first version of this
 * check tested the first and last character separately and rejected three real
 * translations of P-17, whose source ends « … quand je clique sur "je le veux" »
 * — a faithful translation ends in a quote mark because the sentence does. The
 * failure worth catching is the model quoting its own answer, and that shows up
 * as a wrapper the source did not have.
 */
export function validateTranslation({ text, sourceText, language }) {
  const problems = [];
  const value = String(text ?? '').trim();

  if (!value) {
    problems.push('empty');
    return problems;
  }
  if (value === String(sourceText ?? '').trim()) {
    problems.push('identical to the source');
  }
  if (isWrapped(value) && !isWrapped(String(sourceText ?? '').trim())) {
    problems.push('wrapped in quote marks');
  }
  // Ten times the source is not a translation of it, whatever it is. The bound
  // is deliberately loose: German is genuinely longer than French and a
  // four-word fragment can double honestly.
  if (value.length > Math.max(80, String(sourceText ?? '').length * 10)) {
    problems.push('far longer than the source');
  }
  if (LANGUAGE_SLOT[language] === undefined) {
    problems.push(`${language} is not a translation language`);
  }

  return problems;
}

/** Opens and closes with a matching quote mark, i.e. the whole line is quoted. */
function isWrapped(value) {
  return /^«[\s\S]*»$/.test(value) || /^"[\s\S]*"$/.test(value) || /^'[\s\S]*'$/.test(value);
}

/**
 * Translations as phrasing rows, ready to upsert.
 *
 * `content_hash` is left to the caller: it is computed by `hashEmbeddingInput`,
 * which belongs to the embedding pipeline, and importing it here would drag the
 * embedding module into a file that is otherwise pure text.
 */
export function translationRows(translations) {
  return translations.map((t) => ({
    phrasing_index: t.index,
    phrasing_kind: 'translated',
    phrasing_text: t.text,
    language: t.language,
    translated_from_index: t.sourceIndex
  }));
}
