import assert from 'node:assert/strict';
import test from 'node:test';

import { namedSample } from './collections.mjs';

test('namedSample names a few and counts the rest', () => {
  const items = Array.from({ length: 94 }, (_, i) => ({ title: `P${i}` }));
  const out = namedSample(items, { render: (p) => `« ${p.title} »` });

  assert.match(out, /« P0 »/);
  assert.match(out, /et 89 autres$/, 'the tail is counted, not enumerated');
  assert.ok(out.length < 120, 'the string cannot grow with the catalogue');
});

test('namedSample says nothing extra when the list already fits', () => {
  assert.equal(namedSample(['a', 'b']), 'a, b');
  assert.equal(namedSample([]), '');
  assert.equal(namedSample(null), '');
});

test('namedSample uses the singular for a tail of one', () => {
  assert.match(namedSample(['a', 'b', 'c', 'd', 'e', 'f']), /et 1 autre$/);
});
