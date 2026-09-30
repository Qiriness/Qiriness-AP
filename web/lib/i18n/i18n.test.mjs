import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_LOCALE, resolveLocale, intlTag } from './locales.ts';
import { makeTranslate } from './translate.ts';
import { formatMoney, formatMonthKey, formatRelative } from './format.ts';

test('a person who never chose gets French; junk falls back too', () => {
  assert.equal(DEFAULT_LOCALE, 'fr');
  assert.equal(resolveLocale(undefined), 'fr');
  assert.equal(resolveLocale('de'), 'fr');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(intlTag('fr'), 'fr-FR');
});

test('translate: params, plurals (French 0 and 1 are singular), fallback to the source, then the key', () => {
  const en = { 'a.t_one': '{count} ticket', 'a.t_other': '{count} tickets', 'only.en': 'English' };
  const fr = { 'a.t_one': '{count} ticket', 'a.t_other': '{count} tickets' };
  const tf = makeTranslate('fr', fr, en);
  assert.equal(tf('a.t', { count: 0 }), '0 ticket');
  assert.equal(tf('a.t', { count: 1 }), '1 ticket');
  assert.equal(tf('a.t', { count: 2 }), '2 tickets');
  assert.equal(tf('only.en'), 'English');
  assert.equal(tf('missing.key'), 'missing.key');
  assert.equal(makeTranslate('en', en, en)('a.t', { count: 0 }), '0 tickets');
  assert.equal(makeTranslate('en', { x: 'Hi {name}' }, {})('x', { name: 'Ana' }), 'Hi Ana');
});

test('format: French and English print the same quantity their own way', () => {
  assert.match(formatMoney(1234.5, 'EUR', 'fr'), /1\s234,50\s€/);
  assert.match(formatMoney(1234.5, 'EUR', 'en'), /€1,234\.50/);
  assert.match(formatMonthKey('2026-07-01', 'fr'), /juil\.? 2026/);
  assert.equal(formatMonthKey('2026-07-01', 'en'), 'Jul 2026');
  assert.equal(formatMonthKey('nope', 'fr'), 'nope');
  const now = new Date('2026-09-29T12:00:00Z');
  assert.match(formatRelative('2026-09-26T12:00:00Z', 'fr', now), /3 jours/);
  assert.match(formatRelative('2026-09-26T12:00:00Z', 'en', now), /3 days ago/);
});
