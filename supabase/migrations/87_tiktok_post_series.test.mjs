import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('87_tiktok_post_series'));

test('87 is service-role only and reads nothing across shops', () => {
  assert.match(CODE, /from public, anon, authenticated;/);
  assert.match(CODE, /to service_role;/);
  assert.match(CODE, /where p\.shop_id = p_shop/);
  assert.match(CODE, /where d\.shop_id = p_shop/);
});

test('the period end is exclusive and only enabled TikTok accounts count', () => {
  assert.match(CODE, /p\.published_at < \(p_to at time zone p_tz\)/);
  assert.match(CODE, /a\.enabled/);
});

test('87 writes no data', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
