import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('88_manual_post_metrics'));

test('88 keys an annotation to shop, account, post and metric and cascades with the post', () => {
  assert.match(CODE, /primary key \(shop_id, account_id, post_id, metric\)/);
  assert.match(CODE, /foreign key \(shop_id, account_id, post_id\) references public\.social_posts \(shop_id, account_id, external_id\) on delete cascade/);
  assert.match(CODE, /create unique index if not exists social_posts_shop_account_external_key/);
});

test('88 is closed to anon and authenticated, like the other social tables', () => {
  assert.match(CODE, /alter table public\.social_post_manual_metrics enable row level security;/);
  assert.match(CODE, /revoke all on public\.social_post_manual_metrics from anon, authenticated;/);
});

test('88 only copies existing non-follower values and never touches the provider columns', () => {
  assert.doesNotMatch(CODE, /\bupdate public\.|\bdelete from\b|\bdrop\b/i);
  assert.match(CODE, /on conflict do nothing/);
});
