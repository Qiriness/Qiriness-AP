// Pure scoring for the categorisation review set — no network, no I/O, so the
// judgement rules are unit-testable and the runner stays a thin shell.
//
// Three axes are scored separately rather than as one pass/fail: a model that
// gets the subject right and the kind wrong is a different (and much cheaper)
// problem than one that mislabels the subject, and averaging them hides which.

/** Does `actual` match the expected value, allowing the case's alternatives? */
export function matches(actual, expected, accepted = []) {
  return actual === expected || accepted.includes(actual);
}

export function scoreCase(testCase, result) {
  const accept = testCase.accept || {};
  const subject = matches(result.category, testCase.expect.category, accept.category);
  const kind = matches(result.request_kind, testCase.expect.request_kind, accept.request_kind);
  const level = matches(result.level, testCase.expect.level, accept.level);

  // A wrong level on a right pair means the model escalated (or the floor moved);
  // a wrong level on a wrong pair is just a consequence. Separating them stops a
  // single subject error being counted as two failures.
  const levelFromPair = subject && kind ? level : null;

  const expectedSecondary = testCase.expectSecondary || null;
  const secondary = scoreSecondary(expectedSecondary, result, testCase.tolerateSecondary);

  return {
    id: testCase.id,
    subject,
    kind,
    level,
    levelFromPair,
    secondary,
    exact: subject && kind && level,
    actual: {
      category: result.category,
      request_kind: result.request_kind,
      secondary_category: result.secondary_category,
      secondary_request_kind: result.secondary_request_kind,
      level: result.level,
      confidence: result.confidence,
      language: result.language,
      happiness: result.happiness,
      reason: result.reason
    }
  };
}

function scoreSecondary(expected, result, tolerated = []) {
  const got = result.secondary_category || null;
  if (!expected) {
    if (got && tolerated.includes(got)) {
      // Defensible rather than wrong (a missing invoice really does touch
      // payment): counting it as noise would make the metric argue with a
      // reviewer who would have accepted it.
      return { status: 'ok', got };
    }
    // Not expected: a secondary here is noise, not a hard failure — reported
    // separately so an over-eager model is visible without tanking accuracy.
    return { status: got ? 'spurious' : 'ok', got };
  }
  if (!got) {
    return { status: 'missed', got: null };
  }
  const kindOk = !expected.request_kind || result.secondary_request_kind === expected.request_kind;
  return { status: got === expected.category && kindOk ? 'ok' : 'wrong', got };
}

export function summarise(scores) {
  const total = scores.length;
  const count = (predicate) => scores.filter(predicate).length;

  const withPair = scores.filter((s) => s.levelFromPair !== null);
  const expectedSecondaries = scores.filter((s) => s.secondary.status !== 'ok' || s.secondary.got);

  return {
    total,
    subject: count((s) => s.subject),
    kind: count((s) => s.kind),
    level: count((s) => s.level),
    exact: count((s) => s.exact),
    // Level agreement measured only where the pair was right (see scoreCase).
    levelOnCorrectPair: {
      correct: withPair.filter((s) => s.levelFromPair).length,
      of: withPair.length
    },
    secondary: {
      ok: count((s) => s.secondary.status === 'ok' && s.secondary.got),
      missed: count((s) => s.secondary.status === 'missed'),
      wrong: count((s) => s.secondary.status === 'wrong'),
      spurious: count((s) => s.secondary.status === 'spurious')
    },
    expectedSecondaries: expectedSecondaries.length,
    confidence: calibration(scores)
  };
}

/**
 * Accuracy WITHIN each confidence band — the only thing that says whether the
 * self-reported confidence carries information. The signal is useful if `high`
 * scores meaningfully better than `low`; if the bands are flat, the model is
 * just labelling everything high and Phase 5 must not gate drafting on it.
 *
 * Unscored on purpose: there is no "correct" confidence for a case, so this is a
 * diagnostic, never a pass/fail axis.
 */
export function calibration(scores) {
  const bands = new Map();
  for (const score of scores) {
    if (score.error) continue;
    const band = score.actual.confidence || 'unknown';
    const seen = bands.get(band) || { of: 0, exact: 0 };
    seen.of += 1;
    if (score.exact) seen.exact += 1;
    bands.set(band, seen);
  }
  // Fixed order, so two runs are read side by side rather than re-sorted.
  return ['high', 'medium', 'low', 'unknown']
    .filter((band) => bands.has(band))
    .map((band) => ({ band, ...bands.get(band) }));
}

/** Which confusions actually happened, most frequent first — what to fix next. */
export function confusions(cases, scores) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const tally = new Map();
  for (const score of scores) {
    if (score.subject) continue;
    const key = `${byId.get(score.id).expect.category} -> ${score.actual.category}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
}

export function pct(n, of) {
  return of === 0 ? '--' : `${Math.round((n / of) * 100)}%`;
}
