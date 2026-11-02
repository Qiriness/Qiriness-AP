import assert from 'node:assert/strict';
import test from 'node:test';

import { num, priceTokens, rate, routineProfile } from './agent-dashboard.mjs';

test('a rate over nothing is null, not zero', () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(0, 4), 0);
  assert.equal(rate(1, 4), 0.25);
  assert.equal(num('12.50'), 12.5);
  assert.equal(num(null), null);
});

test('tokens are priced per model, by route and intent; an unknown model makes the figure a floor', () => {
  const rates = { cheap: { input: 1, output: 10 } };
  const priced = priceTokens(
    [
      { route: 'llm', intent: 'faq', model: 'cheap', input: 1_000_000, output: 100_000 },
      { route: 'llm', intent: 'routine_building', model: 'cheap', input: 500_000, output: 0 },
      { route: 'llm', intent: 'faq', model: 'mystery', input: 10, output: 10 },
    ],
    rates
  );
  assert.equal(priced.total, 2.5);
  assert.equal(priced.byRoute.llm, 2.5);
  assert.equal(priced.byIntent.faq, 2);
  assert.equal(priced.byIntent.routine_building, 0.5);
  assert.equal(priced.unpriced, true);
  assert.equal(priceTokens([{ route: 'llm', intent: 'faq', model: 'mystery', input: 1, output: 1 }], rates).total, null);
});

test('routine answers are named by the shop\'s labels in the page language; unlabelled codes and unasked answers stay null', () => {
  const profile = routineProfile(
    {
      total: 3,
      main_concern: [{ code: 'A', routines: 2 }, { code: 'Z', routines: 1 }],
      skin_type: [{ code: 'dry', routines: 2 }, { code: null, routines: 1 }],
      age_band: [{ code: '25_34', routines: 3 }],
      routine_time: [{ code: 'both', routines: 3 }],
      labels: {
        main: { A: { fr: 'Hydratation', en: 'Hydration' } },
        skin: { dry: { fr: 'Peau sèche', en: 'Dry' } },
        age_ranges: [{ key: '25_34', label_fr: '25 à 34 ans', label_en: '25 to 34' }],
        routine_times: [{ key: 'both', label_fr: 'Jour et nuit', label_en: 'Day and night' }],
      },
    },
    'en'
  );
  assert.equal(profile.total, 3);
  assert.deepEqual(profile.charts.map((c) => c.field), ['main_concern', 'skin_type', 'age_band', 'routine_time']);
  assert.deepEqual(profile.charts[0].slices, [{ code: 'A', label: 'Hydration', routines: 2 }, { code: 'Z', label: null, routines: 1 }]);
  assert.deepEqual(profile.charts[1].slices[1], { code: null, label: null, routines: 1 });
  assert.equal(profile.charts[2].slices[0].label, '25 to 34');
  assert.equal(routineProfile({ routine_time: [{ code: 'both', routines: 1 }], labels: { routine_times: [{ key: 'both', label_fr: 'Jour et nuit', label_en: 'Day and night' }] } }, 'fr').charts[3].slices[0].label, 'Jour et nuit');
  assert.deepEqual(routineProfile(null, 'fr'), { total: 0, charts: ['main_concern', 'skin_type', 'age_band', 'routine_time'].map((field) => ({ field, slices: [] })) });
});
