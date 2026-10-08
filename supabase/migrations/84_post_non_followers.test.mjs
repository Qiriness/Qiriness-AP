import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('84_post_non_followers'));

test('84 adds one nullable percentage to the posts, held between 0 and 100', () => {
  assert.match(CODE, /alter table public\.social_posts add column if not exists non_followers_pct numeric;/);
  assert.match(CODE, /check \(non_followers_pct is null or \(non_followers_pct >= 0 and non_followers_pct <= 100\)\)/);
  assert.doesNotMatch(CODE, /non_followers_pct numeric not null/);
});

test('it is documented, creates nothing else, and writes no data', () => {
  assert.match(CODE, /comment on column public\.social_posts\.non_followers_pct is/);
  assert.doesNotMatch(CODE, /create table|create or replace function/i);
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
