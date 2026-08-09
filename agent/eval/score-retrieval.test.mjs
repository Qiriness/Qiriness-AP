import assert from 'node:assert/strict';
import test from 'node:test';

import { CASES } from './retrieval-cases.mjs';
import { scoreCase, scoreEntities, summarise, summariseEntities } from './score-retrieval.mjs';

const chunk = (title, similarity = 0.7) => ({ title, similarity });
const result = (chunks, verdict = 'answerable') => ({ chunks, verdict });

// --- retrieval scoring -------------------------------------------------------

test('a hit at rank 1 scores full recall, precision and MRR', () => {
  const c = { id: 'x', expectDocuments: ['Refund policy'] };
  const s = scoreCase(c, result([chunk('Refund policy')]));
  assert.equal(s.recall, 1);
  assert.equal(s.precision, 1);
  assert.equal(s.reciprocalRank, 1);
});

test('MRR degrades with rank while recall does not', () => {
  const c = { id: 'x', expectDocuments: ['Refund policy'] };
  const s = scoreCase(c, result([chunk('Shipping'), chunk('FAQ'), chunk('Refund policy')]));
  assert.equal(s.recall, 1, 'it was found');
  assert.equal(s.reciprocalRank, 1 / 3, 'but third');
  assert.ok(Math.abs(s.precision - 1 / 3) < 1e-9, 'and two of three were wrong');
});

test('precision punishes padding that recall rewards', () => {
  // The failure this whole axis exists to catch: return everything, always.
  const c = { id: 'x', expectDocuments: ['Refund policy'] };
  const lean = scoreCase(c, result([chunk('Refund policy')]));
  const padded = scoreCase(c, result([chunk('Refund policy'), chunk('Shipping'), chunk('FAQ')]));
  assert.equal(lean.recall, padded.recall, 'recall cannot tell them apart');
  assert.ok(padded.precision < lean.precision, 'precision can');
});

test('an accepted alternative document counts as correct', () => {
  // Real questions have more than one defensible source.
  const c = { id: 'x', expectDocuments: ['Shipping'], accept: ['Livraisons et retours'] };
  assert.equal(scoreCase(c, result([chunk('Livraisons et retours')])).recall, 1);
});

test('document matching ignores case and surrounding whitespace', () => {
  const c = { id: 'x', expectDocuments: ['Refund policy'] };
  assert.equal(scoreCase(c, result([chunk('  refund POLICY ')])).recall, 1);
});

// --- restraint ---------------------------------------------------------------

test('returning nothing when nothing answers is scored as CORRECT', () => {
  const c = { id: 'x', expectNone: true, expectBand: 'none' };
  const s = scoreCase(c, { chunks: [], verdict: 'none' });
  assert.equal(s.correct, true);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, null, 'recall is meaningless when nothing was expected');
});

test('answering confidently when nothing answers is scored as WRONG', () => {
  const c = { id: 'x', expectNone: true, expectBand: 'none' };
  const s = scoreCase(c, result([chunk('FAQ')], 'answerable'));
  assert.equal(s.correct, false);
  assert.equal(s.precision, 0);
});

test('restraint is summarised separately from recall', () => {
  // Mixing them would let a cautious retriever hide behind a chatty one.
  const scores = [
    scoreCase({ id: 'a', expectDocuments: ['X'] }, result([chunk('X')])),
    scoreCase({ id: 'b', expectNone: true }, { chunks: [], verdict: 'none' }),
    scoreCase({ id: 'c', expectNone: true }, result([chunk('Y')], 'answerable'))
  ];
  const s = summarise(scores);
  assert.equal(s.recall, 1, 'over answerable cases only');
  assert.equal(s.restraint, 0.5, 'one of two restraint cases passed');
  assert.equal(s.restraintCases, 2);
});

test('band accuracy is what tells you the thresholds need re-deriving', () => {
  const c = { id: 'x', expectDocuments: ['X'], expectBand: 'answerable' };
  assert.equal(scoreCase(c, result([chunk('X')], 'answerable')).bandCorrect, true);
  assert.equal(scoreCase(c, result([chunk('X')], 'weak')).bandCorrect, false);
});

// --- entity scoring ----------------------------------------------------------

test('missing an entity and inventing one are counted separately', () => {
  // Different failures with different costs: inventing #4854 sends a lookup
  // after someone else's order; missing it merely leaves the ticket unresolved.
  const s = scoreEntities({ orderNumbers: ['4854'] }, { orderNumbers: ['9999'] });
  assert.equal(s.orderNumbers.falseNegatives, 1);
  assert.equal(s.orderNumbers.falsePositives, 1);
  assert.equal(s.orderNumbers.precision, 0);
  assert.equal(s.orderNumbers.recall, 0);
});

test('extracting nothing when there is nothing to extract is perfect, not zero', () => {
  // The ERP-reference and bare-number traps depend on this being scored right.
  const s = scoreEntities({ orderNumbers: [] }, { orderNumbers: [] });
  assert.equal(s.orderNumbers.precision, 1);
  assert.equal(s.orderNumbers.recall, 1);
  assert.equal(s.orderNumbers.f1, 1);
});

test('a false positive against an empty expectation scores zero precision', () => {
  const s = scoreEntities({ orderNumbers: [] }, { orderNumbers: ['26200111'] });
  assert.equal(s.orderNumbers.precision, 0, 'the Q00 trap');
  assert.equal(s.orderNumbers.recall, 1, 'nothing was missed — only invented');
});

test('entity totals are micro-averaged across cases', () => {
  // One wrong extraction counts the same wherever it happened, rather than
  // being diluted by how many cases there are.
  const totals = summariseEntities([
    scoreEntities({ codes: ['A'] }, { codes: ['A'] }),
    scoreEntities({ codes: ['B'] }, { codes: [] })
  ]);
  assert.equal(totals.codes.truePositives, 1);
  assert.equal(totals.codes.falseNegatives, 1);
  assert.equal(totals.codes.recall, 0.5);
});

// --- the case set itself -----------------------------------------------------

test('every case has an id, a note and a band', () => {
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.note, `${c.id} has no note — a failure must be diagnosable`);
    assert.ok(c.subject && c.body, `${c.id} has no question`);
    assert.ok(['answerable', 'weak', 'none'].includes(c.expectBand), `${c.id} band`);
  }
});

test('the set is not all one-sided', () => {
  // A set of only answerable cases measures recall and nothing else; a set of
  // only expectNone cases rewards a retriever that returns nothing at all.
  const answerable = CASES.filter((c) => !c.expectNone).length;
  const none = CASES.filter((c) => c.expectNone).length;
  assert.ok(answerable >= 4, `only ${answerable} answerable cases`);
  assert.ok(none >= 4, `only ${none} restraint cases`);
});

test('an expectNone case never also names an expected document', () => {
  for (const c of CASES.filter((x) => x.expectNone)) {
    assert.equal((c.expectDocuments || []).length, 0, `${c.id} contradicts itself`);
  }
});
