import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_SEGMENT_CONDITIONS,
  SEGMENT_MEMBER_LIMIT,
  SEGMENT_METRICS,
  SEGMENT_OPERATORS,
  describeSegment,
  segmentArgs,
  segmentGroups,
  validateSegment
} from './segment-finder.mjs';

const a = { metric: 'orders', op: 'gt', value: 2 };
const b = { metric: 'spend', op: 'gt', value: 100 };
const c = { metric: 'lifetime_spend', op: 'lt', value: 500 };

const segment = (conditions, connectors, windowMonths = 6) => ({ windowMonths, conditions, connectors });

test('a well-formed segment passes, with string inputs from the form coerced', () => {
  const checked = validateSegment({
    windowMonths: '12',
    conditions: [
      { metric: 'orders', op: 'gt', value: '2' },
      { metric: 'spend', op: 'lt', value: '99.5' }
    ],
    connectors: ['or']
  });
  assert.deepEqual(checked, {
    ok: true,
    segment: segment([{ metric: 'orders', op: 'gt', value: 2 }, { metric: 'spend', op: 'lt', value: 99.5 }], ['or'], 12)
  });
});

test('bad input is refused in words the form can show', () => {
  const cases = [
    [{ windowMonths: 0, conditions: [a], connectors: [] }, /time range/],
    [{ windowMonths: 1.5, conditions: [a], connectors: [] }, /time range/],
    [{ windowMonths: 121, conditions: [a], connectors: [] }, /time range/],
    [{ windowMonths: 6, conditions: [], connectors: [] }, /at least one/],
    [{ windowMonths: 6, conditions: Array(MAX_SEGMENT_CONDITIONS + 1).fill(a), connectors: Array(MAX_SEGMENT_CONDITIONS).fill('and') }, /At most/],
    [{ windowMonths: 6, conditions: [{ ...a, metric: 'age' }], connectors: [] }, /Condition 1: choose what/],
    [{ windowMonths: 6, conditions: [{ ...a, op: 'gte' }], connectors: [] }, /more than or less than/],
    [{ windowMonths: 6, conditions: [{ ...a, value: '' }], connectors: [] }, /enter a number/],
    [{ windowMonths: 6, conditions: [{ ...a, value: -1 }], connectors: [] }, /0 or more/],
    [{ windowMonths: 6, conditions: [{ ...a, value: 1.5 }], connectors: [] }, /whole number/],
    [{ windowMonths: 6, conditions: [a, b], connectors: [] }, /AND or OR/],
    [{ windowMonths: 6, conditions: [a, b], connectors: ['xor'] }, /AND or OR/]
  ];
  for (const [input, message] of cases) {
    const checked = validateSegment(input);
    assert.equal(checked.ok, false, JSON.stringify(input));
    assert.match(checked.error, message);
  }
  assert.equal(validateSegment(null).ok, false);
});

test('a euro amount may have cents; orders may not', () => {
  assert.equal(validateSegment({ windowMonths: 6, conditions: [{ ...b, value: 49.99 }], connectors: [] }).ok, true);
  assert.equal(validateSegment({ windowMonths: 6, conditions: [{ ...a, value: 0 }], connectors: [] }).ok, true);
});

test('AND binds tighter than OR', () => {
  assert.deepEqual(segmentGroups(segment([a, b, c], ['and', 'or'])), [[a, b], [c]]);
  assert.deepEqual(segmentGroups(segment([a, b, c], ['or', 'and'])), [[a], [b, c]]);
  assert.deepEqual(segmentGroups(segment([a, b, c], ['and', 'and'])), [[a, b, c]]);
  assert.deepEqual(segmentGroups(segment([a, b, c], ['or', 'or'])), [[a], [b], [c]]);
  assert.deepEqual(segmentGroups(segment([a], [])), [[a]]);
});

test('the description brackets exactly where AND and OR mix', () => {
  assert.equal(
    describeSegment(segment([a, b, c], ['and', 'or'])),
    '(Orders in the last 6 months > 2 AND Spent in the last 6 months > €100) OR Lifetime spend < €500'
  );
  assert.equal(
    describeSegment(segment([a, b], ['and'], 1)),
    'Orders in the last month > 2 AND Spent in the last month > €100'
  );
  assert.equal(describeSegment(segment([c, a], ['or'])), 'Lifetime spend < €500 OR Orders in the last 6 months > 2');
  assert.equal(describeSegment(segment([{ ...c, value: 1250.5 }], [])), 'Lifetime spend < €1,250.5');
});

test('the RPC arguments carry the groups, the window and the member cap', () => {
  assert.deepEqual(segmentArgs('shop-1', segment([a, b, c], ['or', 'and'], 3), ['amazon']), {
    p_shop: 'shop-1',
    p_window_months: 3,
    p_groups: [[a], [b, c]],
    p_not_channels: ['amazon'],
    p_limit: SEGMENT_MEMBER_LIMIT
  });
});

test('every metric and operator offered here is one the SQL function understands', () => {
  // Two vocabularies in two languages: if they drift, a condition the screen
  // offers fails closed in SQL and quietly matches nobody.
  const sql = readFileSync(new URL('../../supabase/migrations/06_analytics.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.customer_segment_find(');
  assert.ok(start >= 0, 'customer_segment_find is not in 06');
  const statement = sql.slice(start, sql.indexOf('\n$$;', start));
  for (const metric of SEGMENT_METRICS) assert.ok(statement.includes(`when '${metric.id}' then`), metric.id);
  for (const operator of SEGMENT_OPERATORS) assert.ok(statement.includes(`when '${operator.id}' then`), operator.id);
});
