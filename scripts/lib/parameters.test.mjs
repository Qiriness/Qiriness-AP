import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARAMETERS,
  PARAMETER_KEYS,
  PARAMETER_KINDS,
  amount,
  days,
  fillParameters,
  placeholdersIn,
  text,
  toParameterMap
} from './parameters.mjs';

const map = (entries) => toParameterMap(entries.map(([parameter_key, value]) => ({ parameter_key, value })));

test('every declared parameter carries a kind the readers know', () => {
  // The catalogue and the parsers are the same file; a kind nothing can parse
  // would be a parameter an operator could set and nothing could use.
  for (const key of PARAMETER_KEYS) {
    assert.ok(PARAMETER_KINDS.includes(PARAMETERS[key].kind), key);
    assert.ok(PARAMETERS[key].label, `${key} needs a label`);
    assert.ok(PARAMETERS[key].usedBy, `${key} must say what it changes`);
  }
});

test('a key nothing declares is dropped rather than carried', () => {
  // A row for a parameter this codebase does not read cannot be acted on, and
  // keeping it would let a caller ask for one and get an answer with no meaning.
  const m = map([['returns_window_days', '30'], ['invented_key', '9']]);
  assert.equal(m.has('invented_key'), false);
  assert.equal(days(m, 'returns_window_days'), 30);
});

test('unset reads as null, and null is not zero', () => {
  // THE DIFFERENCE THAT MATTERS MOST HERE. Zero days would make every return out
  // of window, which is a policy nobody wrote.
  assert.equal(days(map([]), 'returns_window_days'), null);
  assert.equal(days(map([['returns_window_days', null]]), 'returns_window_days'), null);
  assert.equal(days(map([['returns_window_days', '  ']]), 'returns_window_days'), null);
  assert.equal(days(map([['returns_window_days', '0']]), 'returns_window_days'), 0);
});

test('a reader refuses a value of the wrong kind', () => {
  // `days` on an amount parameter is a programming mistake, and returning a
  // number anyway would let it run.
  assert.equal(days(map([['free_shipping_threshold', '70']]), 'free_shipping_threshold'), null);
  assert.equal(amount(map([['returns_window_days', '30']]), 'returns_window_days'), null);
  assert.equal(amount(map([['free_shipping_threshold', '70.00']]), 'free_shipping_threshold'), 70);
  assert.equal(text(map([['returns_address', ' 12 rue X ']]), 'returns_address'), '12 rue X');
});

// --- quoting one in prose ----------------------------------------------------

test('placeholders are found by name, once each', () => {
  assert.deepEqual(
    placeholdersIn('jusqu’à {returns_window_days} jours, à {returns_address}, {returns_window_days}'),
    ['returns_window_days', 'returns_address']
  );
  assert.deepEqual(placeholdersIn('aucun'), []);
});

test('a resolved skeleton is filled', () => {
  const filled = fillParameters('Retour possible {returns_window_days} jours après réception.', map([['returns_window_days', '30']]));
  assert.equal(filled.text, 'Retour possible 30 jours après réception.');
  assert.equal(filled.resolved, true);
});

test('an unset parameter leaves the text UNCHANGED and says which', () => {
  // Never half-substituted and never silently emptied: half a sentence about a
  // returns window is worse than an obviously broken one, and the caller that
  // has to decide is holding both the text and the reason.
  const filled = fillParameters(
    'Retour possible {returns_window_days} jours, adresse : {returns_address}.',
    map([['returns_address', '12 rue X']])
  );
  assert.match(filled.text, /\{returns_window_days\}/);
  assert.deepEqual(filled.unset, ['returns_window_days']);
  assert.equal(filled.resolved, false);
});

test('a parameter that does not exist is reported apart from one that is unset', () => {
  // Different failures: one is an authoring mistake the editor refuses on save,
  // the other is a decision nobody has made yet.
  const filled = fillParameters('{made_up} et {returns_window_days}', map([]));
  assert.deepEqual(filled.unknown, ['made_up']);
  assert.deepEqual(filled.unset, ['returns_window_days']);
});

test('text with no placeholders resolves untouched', () => {
  const filled = fillParameters('Aucun paramètre ici.', map([]));
  assert.equal(filled.text, 'Aucun paramètre ici.');
  assert.equal(filled.resolved, true);
});
