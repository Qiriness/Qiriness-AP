// What may be drafted, and what would have been allowed to send itself.
//
// PURE, and separate from the runner for the same reason `investigation-rules`
// is separate from its own: these are the decisions worth testing exhaustively,
// and a rule reachable only through a model call is a rule nobody tests.
//
// NOTHING HERE SENDS OR DRAFTS. It answers two questions about a case file and
// a ticket, and the caller does the work.

/** The verdicts that produce customer-facing text, and what kind. */
export const DRAFTABLE_VERDICTS = {
  // A reply: the case file established enough to answer.
  answerable: 'reply',
  // The question: the case file named what only the customer can supply, and
  // `MISSING_FIELDS` already holds the sentence that asks for it.
  needs_customer_input: 'question'
};

/**
 * Levels the gate would let send themselves once DRAFT_ONLY is off.
 *
 * L1 is "answerable from the library alone" and L2 adds a suggested action;
 * both were designed to graduate first. L3 is human-approved by definition and
 * L4 is never drafted at all, so neither appears here.
 */
export const AUTO_SEND_LEVELS = [1, 2];

/**
 * The unhappiness at which a reply stops being routine.
 *
 * `happiness` is 1 (happy) to 4 (really unhappy) and is deliberately
 * independent of `level` — level is what WORK a ticket needs, happiness is how
 * the customer feels. A level 1 question asked furiously is still a level 1
 * question, and still the wrong one to answer without a person reading it.
 */
export const AUTO_SEND_MAX_UNHAPPINESS = 2;

/**
 * Whether this case file should produce a draft, and why not when it should not.
 *
 * A REASON RATHER THAN A BOOLEAN, because three of the four "no" answers are
 * normal states and one is a fault, and a caller counting them needs to tell
 * them apart. `needs_human` in particular is the system working: the human
 * brief already exists and is what the dashboard shows.
 */
export function draftDecision({ investigation, ticket } = {}) {
  if (!investigation) {
    return { draft: false, reason: 'no_case_file' };
  }
  const kind = DRAFTABLE_VERDICTS[investigation.verdict];
  if (!kind) {
    return { draft: false, reason: 'needs_human' };
  }
  // Level 4 is a severity judgement, and the tool layer already handed it an
  // empty registry. A case file on one means the level moved after the
  // investigation ran; the draft must not be written even so.
  if (ticket?.level === 4) {
    return { draft: false, reason: 'level_4' };
  }
  // The verdict says to ask, and nothing was named to ask for. `buildCaseFile`
  // downgrades this to needs_human, so reaching here means a row written before
  // that rule existed — draft nothing rather than invent the question.
  if (kind === 'question' && !(investigation.missing?.length > 0)) {
    return { draft: false, reason: 'nothing_to_ask' };
  }
  return { draft: true, kind, reason: null };
}

/**
 * Whether the level gate would have sent this by itself.
 *
 * RECORDED, NEVER ACTED ON, while `DRAFT_ONLY` is true — which is every code
 * path today. It is stored from the first draft onwards because "how often
 * would L1 have been right" is the question graduating auto-send turns on, and
 * asking it retrospectively is impossible: the answer needs a human's verdict
 * on drafts that were produced under the gate, not a re-scoring of old rows.
 *
 * THREE CONDITIONS, ALL REQUIRED. The level must be one that graduates; the
 * customer must not be visibly unhappy; and the mechanical checks must have
 * passed — a draft that failed one is not a candidate for sending itself
 * whatever its level.
 *
 * NOT GATED ON `categorisation_confidence`. That column is only ever written by
 * failure paths, so treating it as a signal would read "the categoriser crashed"
 * as "the categoriser was unsure".
 */
export function autoSendEligible({ level, happiness, checksPassed } = {}) {
  if (!AUTO_SEND_LEVELS.includes(level)) {
    return false;
  }
  // Unknown feeling is not a happy one. The categoriser writes `happiness` on
  // every ticket it reads, so null here means it never read this one.
  if (!Number.isInteger(happiness) || happiness > AUTO_SEND_MAX_UNHAPPINESS) {
    return false;
  }
  return checksPassed === true;
}

/**
 * The language to answer in.
 *
 * Falls back to French rather than to the model's judgement: the corpus, the
 * library and the signature are all French, and a ticket whose language was
 * never recorded is far more likely to be one of those than a missed English
 * email — the categoriser writes the column on every ticket it reads.
 */
export function replyLanguage(ticket) {
  return ticket?.language || 'fr';
}
