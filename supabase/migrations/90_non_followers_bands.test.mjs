import assert from 'node:assert/strict';
import test from 'node:test';

import { BAND_METRICS } from '../../scripts/lib/social-bands.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('90_non_followers_bands'));

test('90 widens the band metrics to exactly the list the app offers', () => {
  const metrics = [...CODE.match(/check \(\s*metric in \(([^)]*)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(metrics, BAND_METRICS);
});

test('a non-followers rule is never a % of followers and never above 100 points', () => {
  assert.match(CODE, /metric <> 'nonFollowersPct' or \(mode <> 'followers' and \(mode <> 'absolute' or high <= 100\)\)/);
});

test('90 writes no data', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
