import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreCase, summarise, confusions, calibration } from './score-categorisation.mjs';
import { CASES } from './categorisation-cases.mjs';
import { TICKET_SUBJECTS, REQUEST_KINDS, defaultLevel } from '../../scripts/lib/support-taxonomy.mjs';

const result = (overrides = {}) => ({
  category: 'order',
  request_kind: 'question',
  secondary_category: null,
  secondary_request_kind: null,
  level: 2,
  reason: 'r',
  ...overrides
});

const testCase = (overrides = {}) => ({
  id: 'c1',
  expect: { category: 'order', request_kind: 'question', level: 2 },
  ...overrides
});

test('confidence is reported as accuracy per band, in a fixed order', () => {
  // The point of the band report: if `high` does not beat `low`, the model is
  // saying "high" to everything and the signal is worthless to Phase 5.
  const scores = [
    scoreCase(testCase(), result({ confidence: 'high' })),
    scoreCase(testCase(), result({ confidence: 'high' })),
    scoreCase(testCase(), result({ confidence: 'low', category: 'payment' })),
    scoreCase(testCase(), result({ confidence: 'medium' }))
  ];
  assert.deepEqual(calibration(scores), [
    { band: 'high', of: 2, exact: 2 },
    { band: 'medium', of: 1, exact: 1 },
    { band: 'low', of: 1, exact: 0 }
  ]);
  // ... and it rides along on the summary the runner prints.
  assert.deepEqual(summarise(scores).confidence, calibration(scores));
});

test('an API failure is left out of the confidence bands', () => {
  // No answer means no self-assessment; counting it would drag a band down for a
  // reason that has nothing to do with the model's judgement.
  const failed = { id: 'c2', error: 'timeout', exact: false, actual: {} };
  assert.deepEqual(calibration([failed]), []);
});

test('an exact match scores on all three axes', () => {
  const score = scoreCase(testCase(), result());
  assert.equal(score.exact, true);
  assert.equal(score.subject, true);
  assert.equal(score.kind, true);
  assert.equal(score.level, true);
});

test('an accepted alternative counts as agreement', () => {
  // Real support mail is ambiguous; scoring against one arbitrary reading would
  // measure conformity, not correctness.
  const score = scoreCase(
    testCase({ accept: { category: ['delivery'] } }),
    result({ category: 'delivery' })
  );
  assert.equal(score.subject, true);
  assert.equal(score.exact, true);
});

test('level agreement is only attributed when the pair was right', () => {
  // A wrong level on a wrong pair is a consequence, not a second failure.
  const wrongPair = scoreCase(testCase(), result({ category: 'payment', level: 3 }));
  assert.equal(wrongPair.levelFromPair, null);
  const rightPair = scoreCase(testCase(), result({ level: 4 }));
  assert.equal(rightPair.levelFromPair, false);
});

test('an unexpected secondary is spurious, not a failure', () => {
  const score = scoreCase(testCase(), result({ secondary_category: 'product' }));
  assert.equal(score.secondary.status, 'spurious');
  // ... and does not touch the headline accuracy.
  assert.equal(score.exact, true);
});

test('a tolerated secondary is not counted as spurious', () => {
  const score = scoreCase(
    testCase({ tolerateSecondary: ['payment'] }),
    result({ secondary_category: 'payment' })
  );
  assert.equal(score.secondary.status, 'ok');
});

test('an expected secondary must match subject and kind', () => {
  const expectSecondary = { category: 'product_stock', request_kind: 'question' };
  assert.equal(scoreCase(testCase({ expectSecondary }), result()).secondary.status, 'missed');
  assert.equal(
    scoreCase(
      testCase({ expectSecondary }),
      result({ secondary_category: 'product_stock', secondary_request_kind: 'problem' })
    ).secondary.status,
    'wrong'
  );
  assert.equal(
    scoreCase(
      testCase({ expectSecondary }),
      result({ secondary_category: 'product_stock', secondary_request_kind: 'question' })
    ).secondary.status,
    'ok'
  );
});

test('the summary counts each axis separately', () => {
  const scores = [
    scoreCase(testCase(), result()),
    scoreCase(testCase(), result({ request_kind: 'problem', level: 3 }))
  ];
  const summary = summarise(scores);
  assert.equal(summary.total, 2);
  assert.equal(summary.subject, 2);
  assert.equal(summary.kind, 1);
  assert.equal(summary.exact, 1);
});

test('confusions name what was mistaken for what', () => {
  const scores = [scoreCase(testCase(), result({ category: 'delivery' }))];
  assert.deepEqual(confusions([testCase()], scores), [['order -> delivery', 1]]);
});

// --- the review set itself ---------------------------------------------------

test('every case is labelled with values the taxonomy allows', () => {
  for (const c of CASES) {
    assert.ok(TICKET_SUBJECTS.includes(c.expect.category), `${c.id}: ${c.expect.category}`);
    assert.ok(REQUEST_KINDS.includes(c.expect.request_kind), `${c.id}: ${c.expect.request_kind}`);
    for (const alt of c.accept?.category || []) {
      assert.ok(TICKET_SUBJECTS.includes(alt), `${c.id}: accept ${alt}`);
    }
    for (const alt of c.accept?.request_kind || []) {
      assert.ok(REQUEST_KINDS.includes(alt), `${c.id}: accept ${alt}`);
    }
  }
});

test('expected levels agree with defaultLevel unless the case is an escalation', () => {
  // Otherwise a label could demand a level the clamp can never produce, and the
  // eval would report a model failure that is really a labelling mistake.
  for (const c of CASES) {
    const floor = defaultLevel(c.expect.category, c.expect.request_kind);
    assert.ok(
      c.expect.level >= floor,
      `${c.id}: expects level ${c.expect.level} below the floor ${floor}`
    );
  }
});

test('the review set covers every subject and every kind', () => {
  const subjects = new Set(CASES.map((c) => c.expect.category));
  const kinds = new Set(CASES.map((c) => c.expect.request_kind));
  for (const subject of TICKET_SUBJECTS) {
    assert.ok(subjects.has(subject), `no case labelled ${subject}`);
  }
  for (const kind of REQUEST_KINDS) {
    assert.ok(kinds.has(kind), `no case labelled ${kind}`);
  }
});

test('the level-4 cases are the three severity triggers, and nothing else', () => {
  const level4 = CASES.filter((c) => c.expect.level === 4).map((c) => c.id);
  assert.deepEqual(level4.sort(), ['cosmeto-hospital', 'legal-threat']);
});
