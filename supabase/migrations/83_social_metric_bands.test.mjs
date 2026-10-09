import assert from 'node:assert/strict';
import test from 'node:test';

import { BAND_METRICS, BAND_MODES } from '../../scripts/lib/social-bands.mjs';
import { ORGANIC_KINDS } from '../../scripts/lib/social-model.mjs';
import { SOCIAL_BAND_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('83_social_metric_bands'));

const listOf = (name) => [...CODE.match(new RegExp(`check \\(${name} in \\(([^)]*)\\)`))[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);

test('83 creates exactly the band table, named as tables.mjs names it, closed to anon and authenticated', () => {
  assert.deepEqual([...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]), Object.values(SOCIAL_BAND_T));
  assert.match(CODE, /alter table public\.social_metric_bands enable row level security;/);
  assert.match(CODE, /revoke all on public\.social_metric_bands from anon, authenticated;/);
  assert.match(CODE, /comment on table public\.social_metric_bands is/);
});

test('the checks list exactly the kinds, metrics and modes the app offers', () => {
  assert.deepEqual(listOf('kind'), ORGANIC_KINDS.filter(kind => kind !== 'tiktok'));
  assert.deepEqual(listOf('metric'), BAND_METRICS);
  assert.deepEqual(listOf('mode'), BAND_MODES);
});

test('limits must be present and ordered unless the metric is off', () => {
  assert.match(CODE, /mode = 'off' or \(low is not null and high is not null and low >= 0 and low <= high\)/);
});

test('no data is written', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
