import assert from 'node:assert/strict';
import test from 'node:test';

import { excessWorkingDays, workingDaysBetween } from './working-days.mjs';

test('working days exclude weekends', () => {
  assert.equal(workingDaysBetween('2026-09-18T12:00:00Z', '2026-09-23T12:00:00Z'), 3);
});

test('excess is max(0, elapsed working days minus threshold)', () => {
  assert.equal(excessWorkingDays('2026-09-18T12:00:00Z', '2026-09-23T12:00:00Z', 3), 0);
  assert.equal(excessWorkingDays('2026-09-18T12:00:00Z', '2026-09-24T12:00:00Z', 3), 1);
});

test('unknown input stays unknown rather than becoming zero', () => {
  assert.equal(excessWorkingDays(null, '2026-09-24T12:00:00Z', 3), null);
  assert.equal(excessWorkingDays('2026-09-18T12:00:00Z', '2026-09-24T12:00:00Z', null), null);
});
