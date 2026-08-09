// Scoring for the retrieval eval. Pure: cases and results in, numbers out. No
// database, no OpenAI, no clock — the same split as score-categorisation.mjs, so
// the judgement can be argued with and tested on its own.
//
// FIVE AXES, because "did it find something" is not one question:
//
//   recall@k     did the right DOCUMENT appear at all?
//   precision@k  of what came back, how much was right?
//   MRR          how far down was the first correct one?
//   band         answerable / weak / none — does the threshold agree with a human?
//   entities     order numbers, products, codes pulled out of the text
//
// WHY PRECISION MATTERS AS MUCH AS RECALL HERE. Withholding is a design goal:
// below the answerable band the chunks never reach the case file, only the
// prohibition does. A retriever that returns three chunks for every query scores
// perfectly on recall and is useless — it hands a drafting model text to answer
// from when nothing answers the question. That failure only shows up in
// precision and in the `expectNone` cases.

/** Label at DOCUMENT level: chunk ids are regenerated on every re-import. */
export function documentOf(chunk) {
  return String(chunk?.title ?? chunk?.documentTitle ?? '').trim();
}

const norm = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Did the retrieved chunks include a document this case expects?
 *
 * `accept` holds documents a human would also call correct — a delivery question
 * answered from either the shipping policy or the delivery FAQ is not a miss,
 * and scoring without it measures agreement with one arbitrary reading.
 */
function isRelevant(chunk, testCase) {
  const doc = norm(documentOf(chunk));
  if (!doc) return false;
  const expected = [...(testCase.expectDocuments || []), ...(testCase.accept || [])].map(norm);
  return expected.includes(doc);
}

export function scoreCase(testCase, result, { k = 3 } = {}) {
  const chunks = (result?.chunks || []).slice(0, k);
  const expectsNothing = Boolean(testCase.expectNone);

  // --- the "nothing answers this" case ------------------------------------
  // Scored separately because recall is meaningless when the right answer is an
  // empty hand. What is being measured is restraint.
  if (expectsNothing) {
    const restrained = result?.verdict === 'none' || chunks.length === 0;
    return {
      id: testCase.id,
      expectsNothing: true,
      correct: restrained,
      recall: null,
      precision: restrained ? 1 : 0,
      reciprocalRank: null,
      bandCorrect: result?.verdict === (testCase.expectBand || 'none'),
      returned: chunks.length,
      verdict: result?.verdict ?? 'none'
    };
  }

  const flags = chunks.map((chunk) => isRelevant(chunk, testCase));
  const hits = flags.filter(Boolean).length;
  const firstHit = flags.indexOf(true);

  return {
    id: testCase.id,
    expectsNothing: false,
    correct: hits > 0,
    recall: hits > 0 ? 1 : 0,
    // Of what was actually shown, how much was right. Zero returned scores 0 —
    // an empty hand is not precision when something WAS expected.
    precision: chunks.length === 0 ? 0 : hits / chunks.length,
    reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    bandCorrect: testCase.expectBand ? result?.verdict === testCase.expectBand : null,
    returned: chunks.length,
    verdict: result?.verdict ?? 'none'
  };
}

/**
 * Entity extraction, scored per type.
 *
 * Precision and recall separately, never merged into "accuracy": missing an
 * order number and inventing one are different failures with different costs.
 * Inventing `#4854` sends a lookup after an order that is not the customer's;
 * missing it just leaves the ticket unresolved.
 */
export function scoreEntities(expected = {}, actual = {}) {
  const types = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  const perType = {};

  for (const type of types) {
    const want = new Set((expected[type] || []).map(norm));
    const got = new Set((actual[type] || []).map(norm));
    const truePositives = [...got].filter((value) => want.has(value)).length;

    perType[type] = {
      expected: want.size,
      returned: got.size,
      truePositives,
      falsePositives: got.size - truePositives,
      falseNegatives: want.size - truePositives,
      precision: got.size === 0 ? (want.size === 0 ? 1 : 0) : truePositives / got.size,
      recall: want.size === 0 ? 1 : truePositives / want.size
    };
    perType[type].f1 = f1(perType[type].precision, perType[type].recall);
  }

  return perType;
}

function f1(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function summarise(scores) {
  const answerable = scores.filter((s) => !s.expectsNothing);
  const nothing = scores.filter((s) => s.expectsNothing);
  const banded = scores.filter((s) => s.bandCorrect !== null);

  return {
    cases: scores.length,
    // Only over cases where something SHOULD be found.
    recall: mean(answerable.map((s) => s.recall)),
    precision: mean(answerable.map((s) => s.precision)),
    mrr: mean(answerable.map((s) => s.reciprocalRank)),
    // The restraint half: did it correctly return nothing?
    restraint: nothing.length ? mean(nothing.map((s) => (s.correct ? 1 : 0))) : null,
    restraintCases: nothing.length,
    // Whether the ANSWERABLE/WEAK thresholds agree with a human. This is what
    // tells you the bands need re-deriving after a retrieval change.
    bandAccuracy: banded.length ? mean(banded.map((s) => (s.bandCorrect ? 1 : 0))) : null
  };
}

export function summariseEntities(perCaseEntities) {
  const totals = {};
  for (const perType of perCaseEntities) {
    for (const [type, s] of Object.entries(perType)) {
      const t = (totals[type] ||= { truePositives: 0, falsePositives: 0, falseNegatives: 0 });
      t.truePositives += s.truePositives;
      t.falsePositives += s.falsePositives;
      t.falseNegatives += s.falseNegatives;
    }
  }
  for (const [, t] of Object.entries(totals)) {
    // Micro-averaged: one wrong extraction counts the same wherever it happened,
    // rather than being diluted by the number of cases.
    t.precision = t.truePositives + t.falsePositives === 0 ? 1 : t.truePositives / (t.truePositives + t.falsePositives);
    t.recall = t.truePositives + t.falseNegatives === 0 ? 1 : t.truePositives / (t.truePositives + t.falseNegatives);
    t.f1 = f1(t.precision, t.recall);
  }
  return totals;
}

function mean(values) {
  const usable = values.filter((v) => Number.isFinite(v));
  return usable.length === 0 ? null : usable.reduce((a, b) => a + b, 0) / usable.length;
}

export function pct(value) {
  return value === null ? ' n/a' : `${(value * 100).toFixed(0)}%`.padStart(4);
}
