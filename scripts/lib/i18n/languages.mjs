/**
 * THE STOREFRONT CHAT'S LANGUAGES (owner, 2026-10-30: « build it so that this is expandable to
 * more languages »). Each language is one folder beside this file:
 *
 *   <code>/lexicon.mjs   how customers describe their skin (advisory/lexicon.mjs reads every one)
 *   <code>/words.mjs     the chat's other vocabulary: yes / no, the cart, orders, references, topics
 *   <code>/messages.mjs  every sentence the server writes itself (questions, buttons, cart answers)
 *
 * ADDING A LANGUAGE: copy the `en` folder, translate it, add one line to PACKS below, add the
 * widget's locale file (storefront-app/extensions/storefront-advisor/locales/<code>.json), then run
 * `node scripts/storefront/build-widget-words.mjs`. i18n.test.mjs fails until every file has every
 * key of the French one, with the same placeholders.
 *
 * ALL VOCABULARY RUNS ON EVERY MESSAGE, in this order: customers mix languages (« j'ai des dark
 * spots »), and a one-word answer carries no language of its own. The order matters only where a
 * pattern's first match is used: French, then English, then the others, as before 2026-10-30.
 */

import frLexicon from './fr/lexicon.mjs';
import frWords from './fr/words.mjs';
import frMessages from './fr/messages.mjs';
import enLexicon from './en/lexicon.mjs';
import enWords from './en/words.mjs';
import enMessages from './en/messages.mjs';
import itLexicon from './it/lexicon.mjs';
import itWords from './it/words.mjs';
import itMessages from './it/messages.mjs';
import deLexicon from './de/lexicon.mjs';
import deWords from './de/words.mjs';
import deMessages from './de/messages.mjs';
import nlLexicon from './nl/lexicon.mjs';
import nlWords from './nl/words.mjs';
import nlMessages from './nl/messages.mjs';
import esLexicon from './es/lexicon.mjs';
import esWords from './es/words.mjs';
import esMessages from './es/messages.mjs';

// The Qiriness store publishes French, English, Italian, German and Dutch; Spanish was added before it
// is on the site (owner, 2026-10-30).
const PACKS = [
  { code: 'fr', lexicon: frLexicon, words: frWords, messages: frMessages },
  { code: 'en', lexicon: enLexicon, words: enWords, messages: enMessages },
  { code: 'it', lexicon: itLexicon, words: itWords, messages: itMessages },
  { code: 'de', lexicon: deLexicon, words: deWords, messages: deMessages },
  { code: 'nl', lexicon: nlLexicon, words: nlWords, messages: nlMessages },
  { code: 'es', lexicon: esLexicon, words: esWords, messages: esMessages },
];

/** The languages the chat speaks, in the order their vocabulary is read. */
export const SUPPORTED = Object.freeze(PACKS.map((p) => p.code));

/**
 * The shop's own language: the one its catalogue and policies are written in, and the one used when
 * nothing at all says which language to use (no locale, no message). Qiriness writes in French.
 */
export const SOURCE_LANGUAGE = 'fr';

/** A storefront in a language the chat does not speak is answered in English (owner, 2026-10-30). */
export const FALLBACK_LANGUAGE = 'en';

const byCode = new Map(PACKS.map((p) => [p.code, p]));

/** « it-IT », « IT », « it » → 'it' when supported. */
export function supported(locale) {
  const code = String(locale ?? '').slice(0, 2).toLowerCase();
  return byCode.has(code) ? code : null;
}

/**
 * The language to write in for a locale: itself when supported, English for any other language,
 * the shop's own language when there is no locale at all.
 */
export function languageOf(locale) {
  if (locale === null || locale === undefined || String(locale).trim() === '') return SOURCE_LANGUAGE;
  return supported(locale) ?? FALLBACK_LANGUAGE;
}

/** The order to look for a translated value in: the language, then English, then the shop's own. */
export function fallbackChain(lang) {
  return [...new Set([languageOf(lang), FALLBACK_LANGUAGE, SOURCE_LANGUAGE])];
}

/**
 * A brand value in a language (settings, Rules tab rows): `{ fr: …, en: … }` or `{ label_fr: …,
 * label_en: … }` (`prefix: 'label_'`), the first one present along the fallback chain.
 */
export function localized(row, lang, { prefix = '' } = {}) {
  if (!row || typeof row !== 'object') return null;
  for (const code of fallbackChain(lang)) {
    const value = row[`${prefix}${code}`];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/** Every language's lexicon, in reading order. */
export const LEXICONS = Object.freeze(PACKS.map((p) => p.lexicon));

/** A language's messages, along the fallback chain. */
export function messages(lang) {
  return byCode.get(languageOf(lang)).messages;
}

/** One words entry from every language, in reading order (arrays flattened, others listed). */
export function wordsOf(key) {
  return PACKS.flatMap((p) => {
    const value = p.words[key];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  });
}

/** One nested words entry (`refs.grammar`) from every language. */
export function wordsAt(path) {
  const keys = path.split('.');
  return PACKS.flatMap((p) => {
    const value = keys.reduce((o, k) => (o == null ? undefined : o[k]), p.words);
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  });
}

/** Regex fragments from every language joined as one alternation, without grouping. */
export function alternation(path) {
  return wordsAt(path).join('|');
}

/** Every language's words, raw (for the widget's generated patterns and the tests). */
export function packs() {
  return PACKS;
}
