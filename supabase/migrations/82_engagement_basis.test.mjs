import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGAGEMENT_BASES, DEFAULT_ENGAGEMENT_BASIS } from '../../scripts/lib/social-model.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('82_engagement_basis'));

test('82 constrains the basis to exactly the bases the app offers, defaulting to the old rate', () => {
  const allowed = [...CODE.match(/check \(engagement_basis in \(([^)]*)\)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed, ENGAGEMENT_BASES);
  assert.match(CODE, new RegExp(`engagement_basis text not null default '${DEFAULT_ENGAGEMENT_BASIS}'`));
});

test('the post totals are recreated with the same grants, and the old columns first', () => {
  assert.match(CODE, /drop function if exists public\.insights_social_post_totals\(uuid, timestamp, timestamp, text\);/);
  assert.match(CODE, /security invoker/);
  assert.match(CODE, /revoke all on function public\.insights_social_post_totals\([^)]*\) from public, anon, authenticated;/);
  assert.match(CODE, /grant execute on function public\.insights_social_post_totals\([^)]*\) to service_role;/);
  const cols = [...CODE.slice(CODE.indexOf('returns table'), CODE.indexOf('language sql')).matchAll(/^\s+(\w+) (?:text|uuid|bigint)/gm)].map((m) => m[1]);
  assert.deepEqual(cols, ['kind', 'account_id', 'posts', 'views', 'engagement', 'rated_engagement', 'rated_reach', 'engaged_posts', 'rated_views_engagement', 'rated_views']);
});

test('no data is written', () => {
  const outside = CODE.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
  assert.doesNotMatch(outside, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
