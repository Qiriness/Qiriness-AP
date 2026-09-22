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
/**
 * Has somebody already replied to the message this case file was written from?
 *
 * MEASURED 2026-09-21: **59 of 138 investigations** sit on a thread where an
 * outbound message is newer than the trigger, and **every one of them produced a
 * draft.** Nearly half the drafting queue was writing a reply to mail a person
 * had already answered — which is exactly what it looks like from the review
 * side: the last message in the thread is ours, and the draft says the same
 * thing again.
 *
 * STRICTLY NEWER THAN THE TRIGGER, not "the thread ends with our reply". The
 * difference is the ordinary case: a customer who writes, gets answered, then
 * writes again has an outbound message in the thread and is owed a reply. What
 * disqualifies a draft is a reply that came AFTER the message being answered.
 *
 * ENVELOPES ONLY — direction and time. No body is read, and none is needed.
 *
 * ON THE CORPUS THIS IS MOSTLY HISTORY, and it is not only history. The mail was
 * imported after a person had worked it, so the human reply is older than the
 * agent's first look. On live mail the same shape appears whenever somebody
 * answers in Outlook before the draft is reviewed — which, with drafting
 * operator-triggered and 120 drafts unread, is the normal case rather than the
 * edge one.
 *
 * ONE INTERACTION TO REMEMBER. `direction` is derived at ingestion from the
 * sender being `SUPPORT_MAILBOX`, so a forward sent from that mailbox would also
 * be outbound. Forwarding has never sent (`ticket_forwards` is empty) and a
 * forward to a colleague is unlikely to land in the customer's conversation, so
 * this is a note rather than a known bug.
 */
export function answeredSince({ conversation = [], triggerMessageId = null } = {}) {
  if (!triggerMessageId) return false;
  const trigger = conversation.find((message) => message?.id === triggerMessageId);
  const triggerAt = stampOf(trigger);
  if (triggerAt === null) return false;

  return conversation.some(
    (message) => message?.direction === 'outbound' && stampOf(message) !== null && stampOf(message) > triggerAt
  );
}

// NOT `timeOf` below, and the difference is load-bearing. That one returns 0 for
// a message with no timestamp, which is right where it is used — ordering a
// thread, where an undated message sorting first is harmless. Here 0 would mean
// an undated TRIGGER compares as older than every reply in the thread, and the
// draft would be suppressed on a ticket nobody has answered.
function stampOf(message) {
  const at = message?.received_at || message?.sent_at;
  if (!at) return null;
  const value = new Date(at).getTime();
  return Number.isNaN(value) ? null : value;
}

/**
 * Is there anything outstanding on OUR side of this case?
 *
 * The code half of closure detection, and it runs first so the model half is
 * never asked a question whose answer could not be acted on. A case with a named
 * question or a point handed to a colleague cannot be closed by the customer
 * saying thank you, however plainly they say it.
 *
 * `d6d0d1c3` IS THE CASE THIS EXISTS FOR. « J'ai bien réceptionné le colis.
 * Merci encore » closes the delivery question; the free mask is still missing
 * and the case file reads `needs_human`. Read on the message alone it is a
 * closure. Read against the dossier it is a customer being gracious about half
 * of their problem.
 *
 * `needs_human` is refused whatever else is true — a handoff means a colleague
 * owes them something — and a `missing` entry means we still asked for a fact.
 */
export function closureAllowed(investigation) {
  if (!investigation) return false;
  if (investigation.verdict !== 'answerable') return false;
  if (investigation.missing?.length > 0) return false;
  return !investigation.handoff;
}

export function draftDecision({ investigation, ticket, conversation = [] } = {}) {
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
  // ALREADY ANSWERED, and checked before the rest because it outranks them: a
  // reply that has been sent cannot be improved by deciding what a second one
  // should have said. Counted like every other skip, because the rate is the
  // thing worth watching — it says how often the queue is behind the people.
  if (answeredSince({ conversation, triggerMessageId: investigation.trigger_message_id })) {
    return { draft: false, reason: 'already_answered' };
  }
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
 *
 * A FOURTH CONDITION SINCE 2026-08-30, and it is a SUBJECT rather than a
 * rollout switch, which is why it belongs in here beside the other three rather
 * than beside `DRAFT_ONLY`. `DRAFT_ONLY` asks "has auto-send graduated"; this
 * asks "is this the kind of mail that may ever send itself", and the honest
 * answer for a reported skin reaction is no — the desk will graduate as a whole
 * long before that subject should, and a wrong reply there is not the same size
 * of mistake as a wrong reply about a promotion code.
 *
 * It also keeps the RECORDED column honest. This value is the measurement
 * auto-send will be graduated on, and a cosmetovigilance draft counted as "would
 * have sent" would inflate exactly the number that decision reads.
 *
 * DEFAULTS TO EXCLUDED, so a caller that has not wired the config still gets the
 * guard. Passing `cosmetovigilanceDraftOnly: false` is the deliberate act of
 * turning it off, and `DRAFT_ONLY` must be off too — the two are a conjunction.
 */
export function autoSendEligible({
  level,
  happiness,
  checksPassed,
  verdict,
  category = null,
  cosmetovigilanceDraftOnly = true
} = {}) {
  if (category === 'cosmetovigilance' && cosmetovigilanceDraftOnly) {
    return false;
  }
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
