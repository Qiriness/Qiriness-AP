import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FALLBACK_LANGUAGE, SOURCE_LANGUAGE, SUPPORTED, fallbackChain, languageOf, localized, messages, packs } from './languages.mjs';
import { WIDGET_FILES, withWidgetBlock } from './widget-words.mjs';

// EVERY LANGUAGE IS WHOLE (owner, 2026-10-30: « build it so that this is expandable to more
// languages »). A language added with a key missing would fall silent on that one rule; these
// tests name the key instead. French is the reference: the shop's own language.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [reference] = packs().filter((p) => p.code === SOURCE_LANGUAGE);

/** Every path of an object: nested objects walked; arrays, strings, regexes and functions are leaves. */
function shape(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof RegExp) return [prefix];
  return Object.keys(value).flatMap((k) => shape(value[k], prefix ? `${prefix}.${k}` : k));
}
const at = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);

/** Groups whose keys are open data (counts, quantities, aliases): present, but their own keys free. */
const OPEN = ['refs.counts', 'refs.pluralAlone', 'shopping.quantities', 'countryAliases', 'equivalents'];
const closed = (paths) => paths.filter((p) => !OPEN.some((o) => p === o || p.startsWith(`${o}.`)));

test('the registry: supported codes, the shop\'s own language, English for the others', () => {
  assert.ok(SUPPORTED.includes(SOURCE_LANGUAGE));
  assert.ok(SUPPORTED.includes(FALLBACK_LANGUAGE));
  assert.equal(languageOf('pt-BR'), FALLBACK_LANGUAGE);
  assert.equal(languageOf(null), SOURCE_LANGUAGE);
  for (const code of SUPPORTED) assert.equal(languageOf(`${code.toUpperCase()}-XX`), code);
  assert.deepEqual(fallbackChain('pt'), [...new Set([FALLBACK_LANGUAGE, SOURCE_LANGUAGE])]);
  assert.equal(localized({ fr: 'Rides', en: 'Wrinkles' }, 'pt'), 'Wrinkles');
  assert.equal(localized({ label_fr: 'Rides' }, 'en', { prefix: 'label_' }), 'Rides');
  assert.equal(localized({ fr: '', en: 'Wrinkles' }, 'fr'), 'Wrinkles');
});

for (const pack of packs()) {
  test(`${pack.code}: the lexicon, the words and the messages have every key of the ${SOURCE_LANGUAGE} ones`, () => {
    for (const part of ['lexicon', 'words', 'messages']) {
      assert.equal(pack[part].code, pack.code, `${pack.code}/${part}.mjs says it is ${pack[part].code}`);
      const missing = closed(shape(reference[part])).filter((p) => at(pack[part], p) === undefined);
      assert.deepEqual(missing, [], `${pack.code}/${part}.mjs lacks ${missing.join(', ')}`);
      const extra = closed(shape(pack[part])).filter((p) => at(reference[part], p) === undefined);
      assert.deepEqual(extra, [], `${pack.code}/${part}.mjs has keys ${SOURCE_LANGUAGE} lacks: ${extra.join(', ')}`);
    }
  });

  test(`${pack.code}: every message takes the same arguments and writes text`, () => {
    for (const p of shape(reference.messages)) {
      const mine = at(pack.messages, p);
      const theirs = at(reference.messages, p);
      assert.equal(typeof mine, typeof theirs, `${pack.code} messages.${p}`);
      if (typeof theirs === 'function') {
        assert.equal(mine.length, theirs.length, `${pack.code} messages.${p} takes ${mine.length} arguments`);
        const args = Array.from({ length: theirs.length }, (_, i) => `«arg${i}»`);
        const said = mine(...args);
        assert.equal(typeof said, 'string');
        // Every argument it is given is said (the product's name, the days…), except an optional last one.
        for (const a of args.slice(0, Math.max(1, args.length - 1))) assert.ok(said.includes(a), `${pack.code} messages.${p} drops ${a}`);
      } else if (typeof theirs === 'string' && p !== 'formalAddress') assert.ok(mine.trim(), `${pack.code} messages.${p} is empty`);
    }
  });

  test(`${pack.code}: every word pattern compiles`, () => {
    const fragments = shape(pack.words).flatMap((p) => {
      const v = at(pack.words, p);
      return Array.isArray(v) && p !== 'faqStopwords' && p !== 'searchStopwords' && !p.startsWith('refs.') && p !== 'shopping.codeFiller' ? v.map((f) => [p, f]) : [];
    });
    for (const [p, f] of fragments) assert.doesNotThrow(() => new RegExp(f, 'iu'), `${pack.code} words.${p}: ${f}`);
  });

  test(`${pack.code}: the widget has its locale, with every key of the ${SOURCE_LANGUAGE} one`, () => {
    const dir = path.join(root, 'storefront-app', 'extensions', 'storefront-advisor', 'locales');
    const file = (code) => path.join(dir, code === SOURCE_LANGUAGE ? `${code}.default.json` : `${code}.json`);
    assert.ok(fs.existsSync(file(pack.code)), `no locales/${pack.code}.json`);
    const mine = JSON.parse(fs.readFileSync(file(pack.code), 'utf8'));
    const theirs = JSON.parse(fs.readFileSync(file(SOURCE_LANGUAGE), 'utf8'));
    const missing = shape(theirs).filter((p) => typeof at(mine, p) !== 'string' || !at(mine, p).trim());
    assert.deepEqual(missing, [], `locales/${pack.code}.json lacks ${missing.join(', ')}`);
    // Placeholders kept: « {{ shop }} », « {count} ».
    for (const p of shape(theirs)) {
      const holes = (s) => (String(s).match(/\{\{?\s*\w+\s*\}?\}/g) ?? []).map((h) => h.replace(/\s/g, '')).sort();
      assert.deepEqual(holes(at(mine, p)), holes(at(theirs, p)), `locales/${pack.code}.json ${p} placeholders`);
    }
  });
}

test('the widget\'s generated words are the language packs\' (npm run widget:words)', () => {
  for (const [file, keys] of Object.entries(WIDGET_FILES)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const expected = withWidgetBlock(source, keys);
    assert.ok(expected !== null, `${file} has no words markers`);
    assert.equal(source, expected, `${file} is out of date: run npm run widget:words`);
  }
});

test('the widget block\'s Liquid passes every locale key it reads', () => {
  const liquid = fs.readFileSync(path.join(root, 'storefront-app', 'extensions', 'storefront-advisor', 'blocks', 'advisor-embed.liquid'), 'utf8');
  const fr = JSON.parse(fs.readFileSync(path.join(root, 'storefront-app', 'extensions', 'storefront-advisor', 'locales', 'fr.default.json'), 'utf8'));
  const missing = shape(fr.routine).filter((k) => !liquid.includes(`'routine.${k}' | t`));
  assert.deepEqual(missing, [], `advisor-embed.liquid does not pass routine.${missing.join(', routine.')}`);
});

test('a message in an unsupported language is answered in English', () => {
  assert.equal(messages('pt').flow.routineReady, messages(FALLBACK_LANGUAGE).flow.routineReady);
});
