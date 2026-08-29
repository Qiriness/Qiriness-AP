import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditAnswerSet,
  needsNamedBy,
  isLive,
  liveAnswers,
  matches,
  nextNeed,
  normaliseConditions,
  selectAnswer,
  specificity
} from './answer-selection.mjs';

const answer = (answerKey, conditions, extra = {}) => ({
  answerKey,
  conditions: normaliseConditions(conditions),
  priority: 0,
  isFallback: false,
  ...extra
});

/** The promotions set from Email-Example-Queries.md, as conditions. */
const PROMO = [
  answer('code_inexistant_ou_expire', {
    promotion_validity: ['expired', 'not_found', 'not_yet_started', 'inactive']
  }),
  answer('code_valide_eligible', {
    promotion_validity: 'active',
    promotion_eligibility: 'eligible'
  }),
  answer('code_valide_non_eligible', {
    promotion_validity: 'active',
    promotion_eligibility: 'blocked'
  }),
  answer('panier_invisible', {
    promotion_validity: 'active',
    promotion_eligibility: 'undetermined'
  })
];

// --- conditions --------------------------------------------------------------

test('a bare value is widened to a single-element list', () => {
  assert.deepEqual(normaliseConditions({ promotion_validity: 'active' }), {
    promotion_validity: ['active']
  });
});

test('a condition naming an unknown need is dropped, loudly', () => {
  // Keeping it would produce an answer that silently never fires — the failure
  // hardest to notice from outside.
  const warnings = [];
  const conditions = normaliseConditions(
    { vibes: 'good', promotion_validity: 'active' },
    { warn: (m) => warnings.push(m) }
  );
  assert.deepEqual(conditions, { promotion_validity: ['active'] });
  assert.match(warnings.join('\n'), /unknown need « vibes »/);
});

test('a value outside the need vocabulary is dropped, but stray whitespace is forgiven', () => {
  // These are typed into a dashboard field. A typo must not become a silently
  // dead branch — but a trailing space is not a typo, it is a keystroke, and
  // trimming before validating fixes it rather than reporting it.
  const warnings = [];
  const conditions = normaliseConditions(
    { promotion_validity: ['active', 'expired ', 'nonsense'] },
    { warn: (m) => warnings.push(m) }
  );
  assert.deepEqual(conditions, { promotion_validity: ['active', 'expired'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /« nonsense » is not a finding/);
});

test('a need nothing can branch on is rejected', () => {
  // `other_fact` has no findings vocabulary, so no condition on it could match.
  assert.deepEqual(normaliseConditions({ other_fact: 'anything' }), {});
});

test('normalising never throws on junk', () => {
  assert.deepEqual(normaliseConditions(null), {});
  assert.deepEqual(normaliseConditions('nope'), {});
  assert.deepEqual(normaliseConditions([1, 2]), {});
  assert.deepEqual(normaliseConditions(), {});
});

// --- matching ----------------------------------------------------------------

test('a need with no finding yet does not match', () => {
  // Absence of evidence is not the `unknown` finding: `unknown` means a tool ran
  // and could not pin a value, and an answer for that case must say so.
  const conditions = normaliseConditions({ promotion_validity: 'active' });
  assert.equal(matches(conditions, {}), false);
  assert.equal(matches(conditions, { promotion_validity: 'unknown' }), false);
  assert.equal(matches(conditions, { promotion_validity: 'active' }), true);
});

test('a condition is a conjunction across needs', () => {
  const conditions = normaliseConditions({
    promotion_validity: 'active',
    promotion_eligibility: 'blocked'
  });
  assert.equal(matches(conditions, { promotion_validity: 'active' }), false);
  assert.equal(
    matches(conditions, { promotion_validity: 'active', promotion_eligibility: 'blocked' }),
    true
  );
});

test('a condition is a disjunction within one need', () => {
  const conditions = normaliseConditions({ promotion_validity: ['expired', 'not_found'] });
  assert.equal(matches(conditions, { promotion_validity: 'expired' }), true);
  assert.equal(matches(conditions, { promotion_validity: 'not_found' }), true);
  assert.equal(matches(conditions, { promotion_validity: 'active' }), false);
});

test('liveness and matching differ exactly on the unestablished need', () => {
  // This is what makes collection progressive rather than a fixed checklist.
  const conditions = normaliseConditions({ promotion_validity: 'active' });
  assert.equal(isLive(conditions, {}), true, 'still reachable');
  assert.equal(matches(conditions, {}), false, 'but not yet true');
  assert.equal(isLive(conditions, { promotion_validity: 'expired' }), false, 'contradicted');
});

// --- selection ---------------------------------------------------------------

test('the promotions set selects the right answer for each position', () => {
  const cases = [
    [{ promotion_validity: 'expired' }, 'code_inexistant_ou_expire'],
    [{ promotion_validity: 'not_found' }, 'code_inexistant_ou_expire'],
    [{ promotion_validity: 'active', promotion_eligibility: 'blocked' }, 'code_valide_non_eligible'],
    [{ promotion_validity: 'active', promotion_eligibility: 'eligible' }, 'code_valide_eligible'],
    [{ promotion_validity: 'active', promotion_eligibility: 'undetermined' }, 'panier_invisible']
  ];
  for (const [findings, expected] of cases) {
    const result = selectAnswer(PROMO, findings);
    assert.equal(result.verdict, 'selected', JSON.stringify(findings));
    assert.equal(result.answer.answerKey, expected);
  }
});

test('most specific wins, so a general answer cannot shadow a precise one', () => {
  const general = answer('general', { promotion_validity: 'active' });
  const precise = answer('precise', {
    promotion_validity: 'active',
    promotion_eligibility: 'blocked'
  });
  // Declared general-first, which is exactly the order that would break
  // first-match-wins.
  const result = selectAnswer([general, precise], {
    promotion_validity: 'active',
    promotion_eligibility: 'blocked'
  });
  assert.equal(result.answer.answerKey, 'precise');
});

test('priority breaks a tie between equally specific answers', () => {
  const low = answer('low', { promotion_validity: 'active' }, { priority: 0 });
  const high = answer('high', { promotion_validity: 'active' }, { priority: 5 });
  assert.equal(selectAnswer([low, high], { promotion_validity: 'active' }).answer.answerKey, 'high');
});

test('an unbreakable tie is reported, not resolved by sort order', () => {
  // Two answers matching equally deeply at equal priority is an authoring bug.
  // Picking one would hide it for ever.
  const a = answer('a', { promotion_validity: 'active' });
  const b = answer('b', { promotion_validity: ['active', 'expired'] });
  const result = selectAnswer([a, b], { promotion_validity: 'active' });
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.answer, null);
  assert.equal(result.candidates.length, 2);
});

test('no match with no fallback routes to a person', () => {
  const result = selectAnswer(PROMO, { promotion_validity: 'unknown' });
  assert.equal(result.verdict, 'none');
  assert.equal(result.answer, null);
});

test('a fallback catches an unmatched position and is never preferred', () => {
  const fallback = answer('fallback', {}, { isFallback: true });
  assert.equal(selectAnswer([...PROMO, fallback], { promotion_validity: 'unknown' }).verdict, 'fallback');
  // But a real match still beats it.
  const matched = selectAnswer([...PROMO, fallback], { promotion_validity: 'expired' });
  assert.equal(matched.verdict, 'selected');
  assert.equal(matched.answer.answerKey, 'code_inexistant_ou_expire');
});

test('selection never throws on missing input', () => {
  assert.equal(selectAnswer().verdict, 'none');
  assert.equal(selectAnswer([], {}).verdict, 'none');
  assert.equal(selectAnswer([null, undefined], {}).verdict, 'none');
});

// --- progressive collection --------------------------------------------------

const DECLARED = ['promotion_identity', 'promotion_validity', 'promotion_eligibility'];

test('collection walks the dependency chain and stops when one answer is left', () => {
  // The worked trace: identity, then validity, then eligibility — and a halt
  // reached because nothing is left to decide, not because the budget ran out.
  const findings = {};

  assert.equal(liveAnswers(PROMO, findings).length, 4);

  // Identity first, even though NO answer branches on it: the promotion cannot
  // be looked up without knowing which code it is. The most discriminating need
  // is eligibility, and the DAG walks back from there to what has to come first.
  assert.equal(nextNeed(PROMO, findings, DECLARED), 'promotion_identity');

  findings.promotion_identity = 'resolved';
  assert.equal(nextNeed(PROMO, findings, DECLARED), 'promotion_validity');

  findings.promotion_validity = 'active';
  assert.equal(liveAnswers(PROMO, findings).length, 3, 'the expired answer is struck out');

  const second = nextNeed(PROMO, findings, DECLARED);
  assert.equal(second, 'promotion_eligibility');

  findings.promotion_eligibility = 'blocked';
  assert.equal(liveAnswers(PROMO, findings).length, 1);
  assert.equal(nextNeed(PROMO, findings, DECLARED), null, 'STOP');
  assert.equal(selectAnswer(PROMO, findings).answer.answerKey, 'code_valide_non_eligible');
});

test('an expired code never costs an eligibility lookup', () => {
  // There is nothing to be eligible FOR. The DAG says so and the selector
  // honours it, so the saving is real rather than advisory.
  const findings = { promotion_identity: 'resolved', promotion_validity: 'expired' };
  assert.equal(liveAnswers(PROMO, findings).length, 1);
  assert.equal(nextNeed(PROMO, findings, DECLARED), null);
});

test('a need no live answer branches on is never chosen', () => {
  // It cannot change the outcome however it resolves, so collecting it is a tool
  // call spent to learn nothing.
  const findings = { promotion_validity: 'active' };
  const chosen = nextNeed(PROMO, findings, [...DECLARED, 'brand_answer', 'product_identity']);
  assert.equal(chosen, 'promotion_eligibility');
});

test('a need whose prerequisite is unestablished is not chosen yet', () => {
  const answers = [
    answer('a', { customer_identity: 'resolved', customer_account_state: 'resolved' }),
    answer('b', { customer_identity: 'none' })
  ];
  const chosen = nextNeed(answers, {}, ['customer_identity', 'customer_account_state']);
  assert.equal(chosen, 'customer_identity', 'the prerequisite comes first');
});

test('collection stops when nothing available can separate the survivors', () => {
  const findings = { promotion_validity: 'active' };
  // Eligibility is what splits them, and it is not on offer.
  assert.equal(nextNeed(PROMO, findings, ['promotion_identity', 'promotion_validity']), null);
});

test('nextNeed never throws on missing input', () => {
  assert.equal(nextNeed(), null);
  assert.equal(nextNeed([], {}, []), null);
});

// --- authoring audit ---------------------------------------------------------

test('a healthy set has nothing to report', () => {
  assert.deepEqual(auditAnswerSet(PROMO), []);
});

test('two answers with identical conditions can never be told apart', () => {
  const problems = auditAnswerSet([
    answer('one', { promotion_validity: 'active' }),
    answer('two', { promotion_validity: ['active'] })
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /same conditions as one/);
});

test('an unconditional answer should be a fallback and is flagged', () => {
  const problems = auditAnswerSet([answer('catch_all', {})]);
  assert.match(problems[0], /use is_fallback instead/);
});

test('two fallbacks in one set are flagged', () => {
  const problems = auditAnswerSet([
    answer('a', {}, { isFallback: true }),
    answer('b', {}, { isFallback: true })
  ]);
  assert.match(problems.join('\n'), /more than one fallback/);
});

test('specificity counts needs, not values', () => {
  assert.equal(specificity(normaliseConditions({ promotion_validity: ['a', 'b', 'active'] })), 1);
  assert.equal(
    specificity(normaliseConditions({ promotion_validity: 'active', promotion_eligibility: 'blocked' })),
    2
  );
});

// --- the situation axis ------------------------------------------------------

const CANCEL = answer('annulation_possible', { order_state: 'not_dispatched' }, { situationKey: 'O-13' });
const SHARED = answer('non_expediee', { order_state: 'not_dispatched' });

test('a rule naming no situation applies to every situation in its set', () => {
  // What makes a shared answer shared: « pas encore expédiée » answers both
  // "where is my order" and "why has it not shipped".
  for (const key of ['O-13', 'D-01', null]) {
    const result = selectAnswer([SHARED], { order_state: 'not_dispatched' }, { situationKey: key });
    assert.equal(result.answer?.answerKey, 'non_expediee', String(key));
  }
});

test('a rule naming a situation fires only there', () => {
  assert.equal(
    selectAnswer([CANCEL], { order_state: 'not_dispatched' }, { situationKey: 'O-13' }).answer?.answerKey,
    'annulation_possible'
  );
  assert.equal(
    selectAnswer([CANCEL], { order_state: 'not_dispatched' }, { situationKey: 'O-14' }).verdict,
    'none'
  );
});

test('an unmatched exemplar does not fire a situation-specific rule', () => {
  // `null` is "we do not know what they want", not "any". A rule written for a
  // cancellation must not answer a ticket whose intent was never identified —
  // this is what keeps a 65%-recall matcher from becoming a liability.
  assert.equal(selectAnswer([CANCEL], { order_state: 'not_dispatched' }).verdict, 'none');
});

test('the situation outranks condition depth, not the other way round', () => {
  // THE ORDERING DECISION. Without it a generic two-condition rule would beat
  // the rule written for this exact request, and the specific answer would be
  // unreachable whenever a broader one happened to name more needs.
  const generic = answer('generique', { order_state: 'not_dispatched', payment_state: 'paid' });
  const result = selectAnswer([generic, CANCEL], {
    order_state: 'not_dispatched',
    payment_state: 'paid'
  }, { situationKey: 'O-13' });
  assert.equal(result.answer.answerKey, 'annulation_possible');
});

test('a situation rule and a shared rule at equal depth are not ambiguous', () => {
  // They are ranked, deliberately. Reporting them as tied would refuse to answer
  // exactly where the two axes are doing their job.
  const result = selectAnswer([SHARED, CANCEL], { order_state: 'not_dispatched' }, { situationKey: 'O-13' });
  assert.equal(result.verdict, 'selected');
  assert.equal(result.answer.answerKey, 'annulation_possible');
});

test('progressive collection ignores rules for another situation', () => {
  // Spending a tool call to split answers that were never candidates is the
  // whole thing `nextNeed` exists to avoid.
  const elsewhere = answer('ailleurs', { photo_evidence: ['attached', 'none'] }, { situationKey: 'R-21' });
  const here = answer('ici', { order_state: 'not_dispatched' }, { situationKey: 'O-13' });
  const live = liveAnswers([elsewhere, here], {}, { situationKey: 'O-13' });
  assert.deepEqual(live.map((a) => a.answerKey), ['ici']);
});

test('the audit knows a situation is part of a rule shape', () => {
  // Two rules with identical conditions under different situations are not
  // duplicates — they are the point of the second axis.
  const a = answer('x', { order_state: 'not_dispatched' }, { situationKey: 'O-13' });
  const b = answer('y', { order_state: 'not_dispatched' }, { situationKey: 'O-14' });
  assert.deepEqual(auditAnswerSet([a, b]), []);

  const c = answer('z', { order_state: 'not_dispatched' }, { situationKey: 'O-13' });
  assert.equal(auditAnswerSet([a, c]).length, 1);
});

test('a rule with a situation and no conditions is legitimate', () => {
  // "Whatever the evidence says, this is what we tell someone asking X." The
  // audit must not push it towards is_fallback, which would apply to the set.
  assert.deepEqual(auditAnswerSet([answer('x', {}, { situationKey: 'O-13' })]), []);
  assert.equal(auditAnswerSet([answer('x', {})]).length, 1);
});

test('the audit catches the two outcomes the schema forbids', () => {
  // Reachable only when a row is built in code rather than read from the table,
  // and the failure is the same either way.
  assert.match(
    auditAnswerSet([answer('x', { order_state: 'not_dispatched' }, { ask: 'photo', route: 'needs_human' })])[0],
    /asks for photo without routing to the customer/
  );
  assert.match(
    auditAnswerSet([answer('y', { order_state: 'not_dispatched' }, { route: 'answerable' })])[0],
    /may never route to answerable/
  );
});

test('the rules say which needs to score, not the ticket', () => {
  // THE BUG THIS PREVENTS, and it is not hypothetical: D-02 declares
  // `order_identity, order_state, policy_answer` while its rules branch on
  // `photo_evidence`. Scoring only the declared needs would leave every one of
  // those rules permanently unmatched — a branch that can never fire.
  const rules = [
    answer('a', { photo_evidence: 'attached' }, { situationKey: 'D-02' }),
    answer('b', { photo_evidence: ['none', 'mentioned_not_attached'] }, { situationKey: 'D-02' }),
    answer('c', { order_state: 'not_dispatched' })
  ];
  assert.deepEqual(needsNamedBy(rules).sort(), ['order_state', 'photo_evidence']);
});

test('a set with no conditions anywhere names no needs', () => {
  assert.deepEqual(needsNamedBy([answer('x', {}, { situationKey: 'O-13' })]), []);
  assert.deepEqual(needsNamedBy([]), []);
});
