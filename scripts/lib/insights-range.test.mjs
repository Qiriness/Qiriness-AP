import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketCoverage,
  bucketKeys,
  bucketLabel,
  change,
  channelFilter,
  fillSeries,
  fromKey,
  grainForSpan,
  parsePlatform,
  platformOfChannel,
  RANGE_PRESETS,
  resolveRange,
  truncate,
  wallClock,
  windowCovered
} from './insights-range.mjs';

// 11 Sep 2026, 14:20 in Paris (UTC+2).
const NOW = new Date('2026-09-11T12:20:00Z');
const PARIS = { tz: 'Europe/Paris', now: NOW };

test('the default is the last 30 days, by day, ending with today', () => {
  const range = resolveRange({}, PARIS);
  assert.equal(range.preset, '30d');
  assert.equal(range.grain, 'day');
  assert.equal(range.keys.length, 30);
  assert.equal(range.from, '2026-08-13T00:00:00');
  assert.equal(range.to, '2026-09-12T00:00:00');
  assert.equal(range.currentKey, '2026-09-11T00:00:00');
});

test('each preset has its own grain and bucket count', () => {
  const shapes = Object.fromEntries(
    ['24h', '7d', '30d', '6m', '1y'].map((id) => {
      const r = resolveRange({ range: id }, PARIS);
      return [id, [r.grain, r.keys.length]];
    })
  );
  assert.deepEqual(shapes, {
    '24h': ['hour', 24],
    '7d': ['day', 7],
    '30d': ['day', 30],
    '6m': ['week', 26],
    '1y': ['month', 12]
  });
});

test('the last 24 hours end with the current hour on the shop clock', () => {
  const range = resolveRange({ range: '24h' }, PARIS);
  assert.equal(range.keys.at(-1), '2026-09-11T14:00:00');
  assert.equal(range.keys[0], '2026-09-10T15:00:00');
});

test('weeks start on Monday, as date_trunc does', () => {
  // 11 Sep 2026 is a Friday.
  assert.equal(truncate(fromKey('2026-09-11T14:00:00'), 'week').toISOString().slice(0, 10), '2026-09-07');
  const range = resolveRange({ range: '6m' }, PARIS);
  assert.ok(range.keys.every((k) => fromKey(k).getUTCDay() === 1));
});

test('the comparison covers the same elapsed time one span earlier', () => {
  // Half of today against half of the day 30 days ago, never a whole one.
  const range = resolveRange({}, PARIS);
  assert.deepEqual(range.previous, { from: '2026-07-14T00:00:00', to: '2026-08-12T14:20:00' });

  const year = resolveRange({ range: '1y' }, PARIS);
  assert.equal(year.from, '2025-10-01T00:00:00');
  assert.deepEqual(year.previous, { from: '2024-10-01T00:00:00', to: '2025-09-11T14:20:00' });
});

test('a custom range is inclusive of both days and picks its grain from its length', () => {
  const range = resolveRange({ from: '2026-08-13', to: '2026-09-11' }, PARIS);
  assert.equal(range.preset, 'custom');
  assert.equal(range.from, '2026-08-13T00:00:00');
  assert.equal(range.to, '2026-09-12T00:00:00');
  assert.equal(range.grain, 'day');
  assert.deepEqual(range.query, { from: '2026-08-13', to: '2026-09-11' });
  assert.equal(range.label, '13 Aug 2026 – 11 Sep 2026');
});

test('a custom range that ended in the past compares like with like and has no current bar', () => {
  const range = resolveRange({ from: '2026-08-01', to: '2026-08-10' }, PARIS);
  assert.equal(range.currentKey, null);
  assert.deepEqual(range.previous, { from: '2026-07-22T00:00:00', to: '2026-08-01T00:00:00' });
});

test('a custom end in the future is cut at today', () => {
  const range = resolveRange({ from: '2026-09-01', to: '2027-01-01' }, PARIS);
  assert.equal(range.to, '2026-09-12T00:00:00');
});

test('all time is the last preset on the bar', () => {
  assert.deepEqual(RANGE_PRESETS.at(-1), { id: 'all', label: 'All time', short: 'all time' });
});

test('all time starts at the first synced order, in months when the history is long', () => {
  // First order 3 May 2024, 10:00 UTC = 12:00 in Paris.
  const range = resolveRange({ range: 'all' }, { ...PARIS, earliest: '2024-05-03T10:00:00Z' });
  assert.equal(range.preset, 'all');
  assert.equal(range.label, 'All time');
  assert.equal(range.grain, 'month');
  assert.equal(range.from, '2024-05-01T00:00:00');
  assert.equal(range.to, '2026-10-01T00:00:00');
  assert.equal(range.keys.length, 29);
  assert.equal(range.currentKey, '2026-09-01T00:00:00');
  assert.deepEqual(range.query, { range: 'all' });
});

test('all time picks a finer grain when the history is short', () => {
  const range = resolveRange({ range: 'all' }, { ...PARIS, earliest: '2026-08-30T08:00:00Z' });
  assert.equal(range.grain, 'day');
  assert.equal(range.from, '2026-08-30T00:00:00');
  assert.equal(range.to, '2026-09-12T00:00:00');
});

test('all time has nothing to compare with, so coverage refuses its previous window', () => {
  const earliest = '2024-05-03T10:00:00Z';
  const range = resolveRange({ range: 'all' }, { ...PARIS, earliest });
  assert.equal(range.previous.to, range.from);
  assert.ok(range.previous.from < range.from);
  assert.equal(windowCovered(range.previous, { from: earliest }, range.tz), false);
  assert.equal(range.compareLabel, 'no earlier period');
});

test('all time with no orders yet, or an unreadable date, is just the current bucket', () => {
  for (const earliest of [null, 'not a date']) {
    const range = resolveRange({ range: 'all' }, { ...PARIS, earliest });
    assert.equal(range.preset, 'all');
    assert.equal(range.keys.length, 1, String(earliest));
    assert.equal(range.currentKey, range.keys[0]);
  }
});

test('an explicit from/to wins over range=all, as it does over every preset', () => {
  const range = resolveRange({ range: 'all', from: '2026-08-13', to: '2026-09-11' }, { ...PARIS, earliest: '2024-05-03T10:00:00Z' });
  assert.equal(range.preset, 'custom');
});

test('nonsense in the URL falls back to the default rather than failing', () => {
  for (const query of [{ range: 'forever' }, { from: '2026-09-10', to: '2026-09-01' }, { from: 'x', to: 'y' }]) {
    assert.equal(resolveRange(query, PARIS).preset, '30d', JSON.stringify(query));
  }
  assert.equal(resolveRange({}, { tz: 'Not/AZone', now: NOW }).tz, 'UTC');
});

test('grain from span', () => {
  assert.deepEqual([1, 2, 3, 62, 63, 190, 191].map(grainForSpan), [
    'hour',
    'hour',
    'day',
    'day',
    'week',
    'week',
    'month'
  ]);
});

test('months step on the calendar', () => {
  assert.deepEqual(bucketKeys(fromKey('2026-01-31'), fromKey('2026-04-01'), 'month'), [
    '2026-01-01T00:00:00',
    '2026-02-01T00:00:00',
    '2026-03-01T00:00:00'
  ]);
});

test('wall-clock conversion follows daylight saving', () => {
  assert.equal(wallClock('2026-07-31T22:30:00Z', 'Europe/Paris').toISOString(), '2026-08-01T00:30:00.000Z');
  assert.equal(wallClock('2026-01-31T23:30:00Z', 'Europe/Paris').toISOString(), '2026-02-01T00:30:00.000Z');
});

test('a sparse series is filled, and both timestamp spellings line up', () => {
  const keys = ['2026-09-01T00:00:00', '2026-09-02T00:00:00', '2026-09-03T00:00:00'];
  const filled = fillSeries(
    keys,
    [{ bucket: '2026-09-01T00:00:00', n: 4 }, { bucket: '2026-09-03 00:00:00', n: 2 }],
    (r) => r.bucket,
    () => ({ n: 0 })
  );
  assert.deepEqual(filled.map((r) => r.n), [4, 0, 2]);
});

test('coverage separates a measured zero from an unsynced day', () => {
  const range = resolveRange({ range: '7d' }, PARIS);
  // Mail last synced on the 7th at 10:00 Paris; the source began long before.
  const states = bucketCoverage(range, { from: '2026-02-27T08:00:00Z', through: '2026-09-07T08:00:00Z' });
  assert.deepEqual(states, ['measured', 'measured', 'partial', 'missing', 'missing', 'missing', 'missing']);
});

test('the bar holding "now" is partial even when the source is current', () => {
  const range = resolveRange({ range: '7d' }, PARIS);
  const states = bucketCoverage(range, { from: null, through: NOW.toISOString() });
  assert.equal(states.at(-1), 'partial');
  assert.equal(states.at(-2), 'measured');
});

test('a bucket before the source begins is missing, and its edge is partial', () => {
  const range = resolveRange({ range: '1y' }, PARIS);
  const states = bucketCoverage(range, { from: '2026-02-27T08:00:00Z', through: null });
  assert.equal(states[0], 'missing'); // Oct 2025
  assert.equal(states[4], 'partial'); // Feb 2026
  assert.equal(states[5], 'measured'); // Mar 2026
});

test('change is null where no honest percentage exists', () => {
  assert.equal(change(110, 100), 0.1);
  assert.equal(change(5, 0), null);
  assert.equal(change(null, 3), null);
});

test('platforms map to channel handles, with Shopify as everything that is not a marketplace', () => {
  assert.deepEqual(channelFilter('amazon'), { channels: ['amazon'], notChannels: null });
  assert.deepEqual(channelFilter('yves_rocher'), { channels: ['connect-dev-1'], notChannels: null });
  assert.deepEqual(channelFilter('shopify'), { channels: null, notChannels: ['amazon', 'connect-dev-1'] });
  assert.deepEqual(channelFilter('all'), { channels: null, notChannels: null });
  assert.equal(platformOfChannel('shop-72'), 'shopify');
  assert.equal(platformOfChannel('connect-dev-1'), 'yves_rocher');
  assert.equal(parsePlatform('ebay'), 'all');
});

test('axis labels suit the grain', () => {
  assert.equal(bucketLabel('2026-09-11T14:00:00', 'hour'), '14:00');
  assert.equal(bucketLabel('2026-09-11T00:00:00', 'day'), '11 Sep');
  assert.equal(bucketLabel('2026-09-01T00:00:00', 'month'), 'Sep 26');
});
