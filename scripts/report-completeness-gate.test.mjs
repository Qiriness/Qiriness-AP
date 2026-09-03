import assert from 'node:assert/strict';
import test from 'node:test';

import { erroredCallsAffecting, gateVerdictFor, scoreRun } from './report-completeness-gate.mjs';
import { normaliseConditions } from '../agent/src/investigation/answer-selection.mjs';

// The scorer, not the printing. Every input is already on a stored row, so the
// whole of this runs without a database -- which is also why `scoreRun` is
// exported rather than folded into `main`.

const gap = (need, state, finding = 'unknown', asksCustomer = null) => ({
  need,
  state,
  finding,
  asksCustomer,
  evidenceIds: []
});

const row = (overrides = {}) => ({
  ticket_id: 'r1',
  verdict: 'answerable',
  evidence_gaps: [],
  tool_calls: [],
  exemplar_match: {},
  investigated_at: '2026-09-03T00:00:00.000+00:00',
  ...overrides
});

test('a need nothing looked for is closable now; the same need with no tool is not', () => {
  // The distinction the whole gate turns on: `not_attempted` is our miss and is
  // fixable by calling the tool. `unavailable` means nothing in this ticket's
  // registry could ever have settled it.
  const scored = scoreRun(
    row({ evidence_gaps: [gap('product_availability', 'not_attempted'), gap('checkout_state', 'unavailable')] })
  );

  const byNeed = Object.fromEntries(scored.mandatoryGaps.map((g) => [g.need, g.closability]));
  assert.equal(byNeed.product_availability, 'now');
  assert.equal(byNeed.checkout_state, 'never');
});

test('a question the customer can answer outranks having no tool for it', () => {
  // Cosmetovigilance has an empty tool set BY DESIGN, so every need on it scores
  // `unavailable` -- and CV-01 still asks which product was used. Reading the
  // state before the question would have called that unclosable.
  const scored = scoreRun(
    row({ evidence_gaps: [gap('reaction_product', 'unavailable', 'unknown', 'reaction_product_name')] })
  );

  assert.equal(scored.mandatoryGaps[0].closability, 'customer');
});

test('promotion_eligibility undetermined is unclosable even though a tool ran', () => {
  // The finding is a stronger statement than the state: the tool could not
  // decide because the basket is invisible, and asking the customer what is in
  // their basket does not make it checkable.
  const scored = scoreRun(
    row({ evidence_gaps: [gap('promotion_eligibility', 'attempted', 'undetermined', 'promotion_code')] })
  );

  assert.equal(scored.mandatoryGaps[0].closability, 'never');
});

test('a moot need is not an open gap at all', () => {
  // The code does not exist, so whether this customer could have used it is not
  // a question anybody asked. A gate counting it would demand evidence for it.
  const scored = scoreRun(
    row({
      evidence_gaps: [
        gap('promotion_validity', 'satisfied', 'not_found'),
        gap('promotion_eligibility', 'not_attempted', 'unknown')
      ]
    })
  );

  assert.deepEqual(scored.mandatoryGaps, []);
  assert.equal(scored.responseComplete, true);
});

test('an answerable run whose every gap is unclosable is reported as a wrong downgrade', () => {
  const scored = scoreRun(row({ evidence_gaps: [gap('checkout_state', 'unavailable')] }));

  assert.equal(scored.responseComplete, false);
  assert.equal(gateVerdictFor(scored), 'wrong');
});

test('an answerable run with a gap somebody can close is a downgrade worth making', () => {
  const scored = scoreRun(row({ evidence_gaps: [gap('policy_answer', 'not_attempted')] }));

  assert.equal(gateVerdictFor(scored), 'right');
});

test('one unclosable gap beside an actionable one is mixed, not wrong', () => {
  // The P-15 shape, and the reason `wrong` requires EVERY gap to be unclosable:
  // the run still had a question worth putting to the customer.
  const scored = scoreRun(
    row({
      evidence_gaps: [
        gap('promotion_identity', 'attempted', 'none', 'promotion_code'),
        gap('promotion_eligibility', 'attempted', 'undetermined')
      ]
    })
  );

  assert.equal(gateVerdictFor(scored), 'mixed');
});

test('the gate only ever downgrades — a needs_human is never a finding here', () => {
  // A floor, never a ceiling. The report must not learn to say a handover should
  // have been answerable.
  const scored = scoreRun(row({ verdict: 'needs_human', evidence_gaps: [gap('checkout_state', 'unavailable')] }));

  assert.equal(gateVerdictFor(scored), 'not-a-downgrade');
});

test('a complete answerable run stands', () => {
  const scored = scoreRun(row({ evidence_gaps: [gap('product_identity', 'satisfied', 'resolved')] }));

  assert.equal(scored.responseComplete, true);
  assert.equal(gateVerdictFor(scored), 'stands');
});

test('an errored call counts only against a need this ticket declared', () => {
  const gaps = [gap('product_availability', 'not_attempted')];

  assert.deepEqual(
    erroredCallsAffecting([{ tool: 'lookupStock', outcome: 'error' }], gaps),
    ['lookupStock'],
    'lookupStock can settle product_availability, which was declared'
  );
  assert.deepEqual(
    erroredCallsAffecting([{ tool: 'lookupStock', outcome: 'error' }], [gap('policy_answer', 'attempted')]),
    [],
    'the same failure against a ticket that never wanted availability is noise'
  );
  assert.deepEqual(
    erroredCallsAffecting([{ tool: 'lookupStock', outcome: 'found' }], gaps),
    [],
    'a call that worked is not an error'
  );
});

test('decision completeness is null when no rule set loaded, not false', () => {
  // A subject with no answer set never had a decision to complete, and reporting
  // that as "still splitting" would invent a problem.
  const noSet = scoreRun(row({ evidence_gaps: [gap('product_identity', 'satisfied', 'resolved')] }));
  assert.equal(noSet.decisionComplete, null);

  const answers = [
    { answerKey: 'a', situationKey: null, conditions: normaliseConditions({ order_identity: ['resolved'] }), isFallback: false },
    { answerKey: 'b', situationKey: null, conditions: normaliseConditions({ order_identity: ['none'] }), isFallback: false }
  ];
  const sets = new Map([['orders', answers]]);

  const undecided = scoreRun(
    row({
      evidence_gaps: [gap('order_identity', 'not_attempted')],
      exemplar_match: { policy: { answer_set: 'orders', situation_key: null, findings: {} } }
    }),
    sets
  );
  assert.equal(undecided.decisionComplete, false, 'both rules are still live');

  const decided = scoreRun(
    row({
      evidence_gaps: [gap('order_identity', 'satisfied', 'resolved')],
      exemplar_match: {
        policy: { answer_set: 'orders', situation_key: null, findings: { order_identity: 'resolved' } }
      }
    }),
    sets
  );
  assert.equal(decided.decisionComplete, true, 'one rule left');
});
