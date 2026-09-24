import assert from 'node:assert/strict';
import test from 'node:test';

import { fromKey } from './insights-range.mjs';
import { readTotals } from './storefront-analytics.mjs';
import {
  combineSessionTotals,
  liveFrom,
  monthDrift,
  monthsBetween,
  planSessionWindow,
  readSessionMonths,
  sessionMonthsQuery,
  storedSpan
} from './storefront-months.mjs';

const now = fromKey('2026-09-24T10:00:00');
const boundary = liveFrom(now);
const stored = [
  '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01',
  '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'
];

test('the live window is this month and the one before', () => {
  assert.equal(boundary, '2026-08-01T00:00:00');
  assert.equal(liveFrom(fromKey('2026-01-03T00:00:00')), '2025-12-01T00:00:00');
  assert.deepEqual(storedSpan(now), { from: '2023-08-01T00:00:00', to: '2026-08-01T00:00:00' });
});

test('a 6-month range starting mid-month asks the stray days live, never the whole month', () => {
  // The real "Last 6 months" window on 2026-09-24: it starts on Monday 30 March.
  const plan = planSessionWindow({ from: '2026-03-30T00:00:00', to: '2026-09-28T00:00:00' }, { liveFrom: boundary, stored });
  assert.deepEqual(plan.months, ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
  assert.deepEqual(plan.live, [
    { from: '2026-03-30T00:00:00', to: '2026-04-01T00:00:00' },
    { from: '2026-08-01T00:00:00', to: '2026-09-28T00:00:00' }
  ]);
});

test('a window inside the live months is one live piece', () => {
  for (const window of [
    { from: '2026-09-23T11:00:00', to: '2026-09-24T11:00:00' },
    { from: '2026-09-18T00:00:00', to: '2026-09-25T00:00:00' },
    { from: '2026-08-26T00:00:00', to: '2026-09-25T00:00:00' }
  ]) {
    assert.deepEqual(planSessionWindow(window, { liveFrom: boundary, stored }), { months: [], live: [window] });
  }
});

test('a month missing from the store is asked live, merged with its neighbours', () => {
  const gappy = stored.filter((m) => m !== '2026-05-01' && m !== '2026-06-01');
  const plan = planSessionWindow({ from: '2026-04-01T00:00:00', to: '2026-10-01T00:00:00' }, { liveFrom: boundary, stored: gappy });
  assert.deepEqual(plan.months, ['2026-04-01', '2026-07-01']);
  assert.deepEqual(plan.live, [
    { from: '2026-05-01T00:00:00', to: '2026-07-01T00:00:00' },
    { from: '2026-08-01T00:00:00', to: '2026-10-01T00:00:00' }
  ]);
});

test('a whole month inside the live window is never read from the store, even if a row exists', () => {
  const plan = planSessionWindow(
    { from: '2026-08-01T00:00:00', to: '2026-09-01T00:00:00' },
    { liveFrom: boundary, stored: [...stored, '2026-08-01'] }
  );
  assert.deepEqual(plan, { months: [], live: [{ from: '2026-08-01T00:00:00', to: '2026-09-01T00:00:00' }] });
});

test('a year of whole months is all stored except the live tail', () => {
  const plan = planSessionWindow({ from: '2025-10-01T00:00:00', to: '2026-10-01T00:00:00' }, { liveFrom: boundary, stored });
  assert.equal(plan.months.length, 10);
  assert.deepEqual(plan.live, [{ from: '2026-08-01T00:00:00', to: '2026-10-01T00:00:00' }]);
});

test('the pieces of a plan tile the window exactly, with no gap and no overlap', () => {
  const window = { from: '2025-09-29T00:00:00', to: '2026-03-30T00:00:00' };
  const plan = planSessionWindow(window, { liveFrom: boundary, stored });
  const pieces = [
    ...plan.months.map((m) => {
      const from = `${m}T00:00:00`;
      const d = fromKey(from);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return { from, to: d.toISOString().slice(0, 19) };
    }),
    ...plan.live
  ].sort((a, b) => a.from.localeCompare(b.from));
  assert.equal(pieces[0].from, window.from);
  assert.equal(pieces[pieces.length - 1].to, window.to);
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].from, pieces[i - 1].to);
});

test('the monthly query is human sessions, counts only, bucketed by month', () => {
  assert.equal(
    sessionMonthsQuery({ from: '2023-08-01T00:00:00', to: '2026-08-01T00:00:00' }),
    'FROM sessions SHOW sessions, pageviews, sessions_with_cart_additions, sessions_that_reached_checkout, ' +
      "sessions_that_completed_checkout WHERE human_or_bot_session = 'human' TIMESERIES month SINCE 2023-08-01 UNTIL 2026-07-31"
  );
});

test('rows are read strictly: a missing count or a non-month bucket throws instead of storing a guess', () => {
  const good = {
    month: '2026-03-01',
    sessions: '5000',
    pageviews: '15000',
    sessions_with_cart_additions: '400',
    sessions_that_reached_checkout: '300',
    sessions_that_completed_checkout: '100'
  };
  assert.deepEqual(readSessionMonths([good], 'shop'), [
    { shop_id: 'shop', month: '2026-03-01', sessions: 5000, pageviews: 15000, cart_sessions: 400, checkout_sessions: 300, converted_sessions: 100 }
  ]);
  assert.throws(() => readSessionMonths([{ ...good, sessions_that_completed_checkout: null }], 'shop'), /not a count/);
  assert.throws(() => readSessionMonths([{ ...good, month: '2026-03-15' }], 'shop'), /not a month/);
});

test('one live piece is Shopify untouched; anything assembled is summed and says what it cannot know', () => {
  const live = readTotals([
    {
      sessions: '1000',
      online_store_visitors: '800',
      conversion_rate: '0.02',
      pageviews: '3000',
      bounce_rate: '0.6',
      sessions_with_cart_additions: '90',
      sessions_that_reached_checkout: '50',
      sessions_that_completed_checkout: '20'
    }
  ]);
  assert.equal(combineSessionTotals([], [live]), live);

  const stored = [{ sessions: 4000, pageviews: 12000, cart_sessions: 300, checkout_sessions: 200, converted_sessions: 80 }];
  const combined = combineSessionTotals(stored, [live]);
  assert.equal(combined.sessions, 5000);
  assert.equal(combined.convertedSessions, 100);
  assert.equal(combined.conversionRate, 2);
  assert.equal(combined.pageviews, 15000);
  assert.equal(combined.cartSessions, 390);
  assert.equal(combined.visitors, null);
  assert.equal(combined.bounceRate, null);
});

test('drift names the closed months a fresh read disagrees with', () => {
  const before = [{ month: '2026-06-01', sessions: 5000, pageviews: 1, cart_sessions: 1, checkout_sessions: 1, converted_sessions: 1 }];
  assert.deepEqual(monthDrift(before, [{ ...before[0] }]), []);
  assert.deepEqual(monthDrift(before, [{ ...before[0], sessions: 5010 }]), [
    { month: '2026-06-01', fields: ['sessions'], before: 5000, after: 5010 }
  ]);
});

test('monthsBetween lists the months of a stored span', () => {
  assert.deepEqual(monthsBetween('2026-05-01T00:00:00', '2026-08-01T00:00:00'), ['2026-05-01', '2026-06-01', '2026-07-01']);
});
