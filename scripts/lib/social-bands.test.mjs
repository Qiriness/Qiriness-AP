import assert from 'node:assert/strict';
import test from 'node:test';

import { bandOf, bandPosts, DEFAULT_BANDS, effectiveRules, median, validateRule } from './social-bands.mjs';

test('below low is low, high and above is high, between is medium', () => {
  const rule = { mode: 'absolute', low: 3, high: 10 };
  assert.equal(bandOf(2.9, rule), 'low');
  assert.equal(bandOf(3, rule), 'medium');
  assert.equal(bandOf(9.99, rule), 'medium');
  assert.equal(bandOf(10, rule), 'high');
});

test('relative modes: % of followers, % of the median', () => {
  assert.equal(bandOf(1500, { mode: 'followers', low: 100, high: 300 }, { followers: 1000 }), 'medium', '150 % of followers');
  assert.equal(bandOf(3000, { mode: 'followers', low: 100, high: 300 }, { followers: 1000 }), 'high');
  assert.equal(bandOf(800, { mode: 'median', low: 50, high: 150 }, { median: 1000 }), 'medium');
  assert.equal(bandOf(1600, { mode: 'median', low: 50, high: 150 }, { median: 1000 }), 'high');
  assert.equal(bandOf(400, { mode: 'median', low: 50, high: 150 }, { median: 1000 }), 'low');
});

test('no colour when the metric is off, unknown, or what it is relative to is missing', () => {
  assert.equal(bandOf(5, { mode: 'off', low: null, high: null }), null);
  assert.equal(bandOf(null, { mode: 'absolute', low: 1, high: 2 }), null);
  assert.equal(bandOf(5, { mode: 'followers', low: 1, high: 2 }, { followers: null }), null);
  assert.equal(bandOf(5, { mode: 'median', low: 1, high: 2 }, { median: 0 }), null);
  assert.equal(bandOf(0, { mode: 'absolute', low: 1, high: 2 }), 'low', 'a measured zero is low, not unknown');
});

test('median of the known numbers', () => {
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null]), null);
});

test('stored rules override the suggestions, and an unlisted metric starts off', () => {
  const rules = effectiveRules([{ metric: 'views', mode: 'absolute', low: '1000', high: '5000' }]);
  assert.deepEqual(rules.views, { mode: 'absolute', low: 1000, high: 5000 });
  assert.deepEqual(rules.reach, DEFAULT_BANDS.reach);
  assert.equal(rules.likes.mode, 'off');
});

test('validation: modes per metric, numbers, order', () => {
  assert.equal(validateRule('views', { mode: 'followers', low: 1, high: 2 }).ok, true);
  assert.equal(validateRule('engagementRate', { mode: 'followers', low: 1, high: 2 }).ok, false, 'a rate is not a share of followers');
  assert.equal(validateRule('views', { mode: 'absolute', low: 5, high: 2 }).ok, false);
  assert.equal(validateRule('views', { mode: 'absolute', low: '', high: 2 }).ok, false);
  assert.equal(validateRule('views', { mode: 'absolute', low: -1, high: 2 }).ok, false);
  assert.equal(validateRule('nope', { mode: 'off' }).ok, false);
  assert.deepEqual(validateRule('views', { mode: 'off', low: 'x' }), { ok: true, rule: { mode: 'off', low: null, high: null } });
});

test('bandPosts: each post gets its own colour, medians come from the posts given', () => {
  const posts = [
    { accountId: 'a', views: 100, reach: 50, engagementRate: 12 },
    { accountId: 'a', views: 1000, reach: 2000, engagementRate: 1 },
    { accountId: 'a', views: 2000, reach: null, engagementRate: 5 }
  ];
  const out = bandPosts(posts, effectiveRules(), new Map([['a', 1000]]));
  assert.deepEqual(out[0], { views: 'low', reach: 'low', engagementRate: 'high' }, 'median views 1000: 100 is 10 %');
  assert.deepEqual(out[1], { views: 'medium', reach: 'medium', engagementRate: 'low' }, 'reach 200 % of followers');
  assert.deepEqual(out[2], { views: 'high', engagementRate: 'medium' }, 'no reach, no reach band');
});
