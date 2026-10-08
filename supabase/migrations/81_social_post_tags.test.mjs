import assert from 'node:assert/strict';
import test from 'node:test';

import { SOCIAL_TAG_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('81_social_post_tags'));

test('81 creates exactly the tag tables, named as tables.mjs names them', () => {
  assert.deepEqual([...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]), Object.values(SOCIAL_TAG_T));
});

test('every table is closed to anon and authenticated, and documented', () => {
  for (const table of Object.values(SOCIAL_TAG_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`), table);
    assert.match(CODE, new RegExp(`comment on table public\\.${table} is`), table);
  }
});

test('posts gain a nullable insights_at, so every stored post starts as never read', () => {
  assert.match(CODE, /alter table public\.social_posts add column if not exists insights_at timestamptz;/);
});

test('tag names are unique per shop ignoring case, and a link dies with its tag or its post', () => {
  assert.match(CODE, /on public\.social_post_tags \(shop_id, lower\(name\)\)/);
  assert.match(CODE, /references public\.social_post_tags\(id\) on delete cascade/);
  assert.match(CODE, /references public\.social_posts\(account_id, external_id\) on delete cascade/);
});

test('no data is written', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
