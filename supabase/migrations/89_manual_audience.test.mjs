import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('89_manual_audience'));

test('89 holds one latest distribution per shop, platform and dimension', () => {
  assert.match(CODE, /primary key \(shop_id, kind, dimension\)/);
  assert.match(CODE, /check \(kind in \('instagram', 'facebook', 'tiktok'\)\)|kind text not null check \(kind in \('instagram', 'facebook', 'tiktok'\)\)/);
});

test('89 is closed to anon and authenticated and writes no data', () => {
  assert.match(CODE, /revoke all on public\.social_audience_manual from anon, authenticated;/);
  assert.doesNotMatch(CODE, /\binsert into\b|\bdelete from\b/i);
});

test('89 never rescales: the validator only caps the total at 100', () => {
  assert.match(CODE, /return total <= 100;/);
});
