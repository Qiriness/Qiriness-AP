// What may be drafted, and what would have been allowed to send itself.
//
// PURE, and separate from the runner for the same reason `investigation-rules`
// is separate from its own: these are the decisions worth testing exhaustively,
// and a rule reachable only through a model call is a rule nobody tests.
//
// NOTHING HERE SENDS OR DRAFTS. It answers two questions about a case file and
// a ticket, and the caller does the work.

/**
 * What each verdict's reply is FOR. All three produce customer-facing text.
 *
 * `needs_human` used to produce none, and that was wrong in three ways a person
 * answering this mailbox notices immediately: the customer hears nothing at all
 * while a colleague works on it; the colleague starts from a blank page instead
 * of an editable draft; and a wait that turns out to be long looks like being
 * ignored rather than like being handled. An acknowledgement fixes all three and
 * risks nothing, because of what it is forbidden to contain — see
 * `INTENT_RULES` in brand-voice.mjs.
 *
 * What the verdict decides is therefore not WHETHER a reply is drafted but what
 * it may do, and separately whether sending it ends the exchange.
 */
export const DRAFTABLE_VERDICTS = {
  // A reply: the case file established enough to answer.
  answerable: 'reply',
  // The question: the case file named what only the customer can supply, and
  // `MISSING_FIELDS` already holds the sentence that asks for it.
  needs_customer_input: 'question',
  // An acknowledgement: the case file could not resolve this, so the reply says
  // so and claims nothing. `REPLY_INTENTS.needs_human` has read 'acknowledge'
  // since the case file was designed, with a note that Phase 5 would decide
  // whether it meant sending one. This is that decision.
  needs_human: 'acknowledgement'
};

/**
 * Whether sending a draft ends the thread.
 *
 *   terminal      nothing is expected back and nothing is left to do.
 *   intermediary  the customer owes us an answer, or a colleague owes them one.
 *
 * THE POINT OF THE DISTINCTION is what happens on send: a terminal reply is what
 * closes the ticket, and an intermediary one must close nothing. Getting it
 * backwards closes a thread somebody still owes work on, which is the one
 * mistake here a customer would feel.
 */
export const DISPOSITIONS = ['terminal', 'intermediary'];

/**
 * Which of the two this draft is.
 *
 * DERIVED, NEVER ASKED OF THE MODEL. "Is this exchange finished" decides whether
 * a ticket closes, and it is the judgement a drafting model has the least
 * evidence for — it sees the reply it just wrote, not the work behind it.
 *
 * TWO CONDITIONS, AND THE SECOND IS THE ONE THAT WILL MATTER LATER. An answer is
 * the end of the exchange only if nobody has to do anything afterwards, and what
 * records that is the case file's `handoff` — "what a human must do, and why".
 * Measured on the live corpus (2026-08-18): all 49 `needs_human` case files carry
 * a handoff and none of the 15 `answerable` ones do, so today the two conditions
 * agree and the verdict alone would give the same answer. They are both checked
 * anyway, because the direction they would disagree in is the dangerous one — an
 * answerable case file that also names an action is a ticket that must not close
 * on send.
 */
export function draftDisposition({ verdict, handoff } = {}) {
  const finished = verdict === 'answerable' && !handoff;
  return finished ? 'terminal' : 'intermediary';
}

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
 * A REASON RATHER THAN A BOOLEAN, because the "no" answers mean different
 * things and a caller counting them needs to tell them apart: `no_case_file` is
 * a ticket nothing has read yet, `level_4` is deliberate silence, and
 * `unknown_verdict` is a row written by something that is not the investigation.
 * Only the last is a fault.
 *
 * Every verdict the investigation issues now produces a draft, so the reasons
 * are all about the ticket or the row — never about what was concluded.
 */
export function draftDecision({ investigation, ticket } = {}) {
  if (!investigation) {
    return { draft: false, reason: 'no_case_file' };
  }
  const kind = DRAFTABLE_VERDICTS[investigation.verdict];
  if (!kind) {
    // Not a verdict this codebase issues. Drafting nothing is the only safe
    // reading of a row written by something that is not the investigation.
    return { draft: false, reason: 'unknown_verdict' };
  }
  // A TICKET LINKED AS A DUPLICATE IS NEVER DRAFTED, and this is the entire
  // purpose of the link. Both threads stay whole and a person can unlink either
  // one; what must not happen is that a customer who wrote once receives two
  // replies because their mail arrived under two conversation ids.
  //
  // Checked here rather than filtered in the query so the skip is COUNTED —
  // `skippedBy.duplicate` is how anybody finds out the detection is firing, or
  // firing too much.
  // A THREAD ONE OF US OPENED. `sender_label` is set at ingestion from the
  // address, so this is the colleague who forwarded a customer's problem in —
  // and a reply written in the brand's customer voice, opening "Bonjour Madame"
  // and closing with the signature, is never the right thing to put in front of
  // them. The investigation still runs: whoever picks this up wants the order
  // facts gathered, they just do not want a drafted customer email.
  if (ticket?.sender_label) {
    return { draft: false, reason: 'internal_sender' };
  }
  if (ticket?.duplicate_of_ticket_id) {
    return { draft: false, reason: 'duplicate' };
  }
  // Level 4 is a severity judgement, and the tool layer already handed it an
  // empty registry. It is the one case where silence is deliberate: a level 4
  // reaches a person untouched, and an automated « nous avons bien reçu votre
  // message » on the three triggers that define it (see the taxonomy) is worse
  // than no reply at all.
  if (ticket?.level === 4) {
    return { draft: false, reason: 'level_4' };
  }
  // The verdict says to ask, and nothing was named to ask for. `buildCaseFile`
  // downgrades this to needs_human, so reaching here means a row written before
  // that rule existed — draft nothing rather than invent the question.
  if (kind === 'question' && !(investigation.missing?.length > 0)) {
    return { draft: false, reason: 'nothing_to_ask' };
  }
  return {
    draft: true,
    kind,
    disposition: draftDisposition({
      verdict: investigation.verdict,
      handoff: investigation.handoff
    }),
    reason: null
  };
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
export function autoSendEligible({ level, happiness, checksPassed, verdict } = {}) {
  // AN ACKNOWLEDGEMENT IS NEVER AUTO-SENT, whatever its level. The verdict says
  // a person owns the next move, and the first thing that person needs is the
  // chance to answer properly rather than to follow an automated holding note
  // the customer has already read. It is also the draft written from the least
  // evidence — 7 of the 49 rest on no established fact at all.
  if (verdict === 'needs_human') {
    return false;
  }
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
 * Did the customer write again before we answered?
 *
 * TWO SIGNALS EXIST AND NEITHER IS ENOUGH ALONE. Measured across the 81 drafted
 * tickets: 12 threads hold consecutive inbound messages with no reply between
 * them — a chase we can PROVE — while only 4 say so in words. The overlap is 2.
 * A prompt instruction alone would miss 10; this function alone would miss 2.
 * So this supplies the fact, and the prompt carries the rule for the cases only
 * the customer's own words reveal.
 *
 * CONSECUTIVE INBOUND, NOT A MESSAGE COUNT. A thread where the customer replied
 * to our question has two inbound messages and is a normal exchange, not a
 * chase. What makes it a chase is that they wrote again while nothing had come
 * back — so the run has to be uninterrupted by an outbound.
 *
 * IT DESCRIBES OUR CONDUCT, NOT THE CUSTOMER'S MOOD. `happiness` already
 * records how they sound; this records that we left them waiting, which is true
 * whether they complained about it or not.
 */
export function describesChase(messages = []) {
  const ordered = [...messages].sort(
    (a, b) => timeOf(a) - timeOf(b)
  );

  let run = 0;
  let longestRun = 0;
  for (const message of ordered) {
    if (message?.direction === 'inbound') {
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }

  return { chased: longestRun > 1, unanswered: longestRun };
}

/** Inbound carries `received_at`, our own replies carry `sent_at`. */
function timeOf(message) {
  return Date.parse(message?.received_at || message?.sent_at || '') || 0;
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
