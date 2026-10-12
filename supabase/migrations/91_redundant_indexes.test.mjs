import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL, codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('91_redundant_indexes'));
const DROPPED = ['email_blocklist_shop_pattern_idx', 'sender_directory_shop_pattern_idx', 'support_answers_shop_set_idx'];

test('91 drops exactly the three redundant indexes, idempotently', () => {
  const drops = [...CODE.matchAll(/drop index if exists public\.(\w+);/g)].map((m) => m[1]);
  assert.deepEqual(drops, DROPPED);
  assert.doesNotMatch(CODE.replace(/drop index if exists public\.\w+;/g, ''), /\S/);
});

test('the baseline no longer creates them, so a fresh install matches an upgraded one', () => {
  for (const name of DROPPED) assert.doesNotMatch(codeOnly(ALL), new RegExp(`create index ${name}\\b`));
});

test('each dropped index is still covered by a unique index with the same leading columns', () => {
  const baseline = codeOnly(ALL);
  assert.match(baseline, /constraint email_blocklist_shop_pattern_unique unique \(shop_id, pattern_type, pattern\)/);
  assert.match(baseline, /constraint sender_directory_shop_pattern_unique unique \(shop_id, pattern_type, pattern\)/);
  assert.match(baseline, /create unique index support_answers_shop_set_key_unique\s+on public\.support_answers \(shop_id, answer_set, answer_key\);/);
});
