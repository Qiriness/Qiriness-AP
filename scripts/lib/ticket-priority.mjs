/**
 * What to work on next, as a number.
 *
 * DETERMINISTIC. No model, no stored guess: the score is a pure function of five
 * facts the ticket already carries, so the same queue always sorts the same way
 * and any position in it can be explained by pointing at the inputs.
 *
 * DERIVED AT READ TIME, never stored — the same reasoning as VIP (see
 * DECISIONS.md § Tickets dashboard), and stronger here: wait time changes every
 * minute, so a stored score is stale the moment it is written and a ticket would
 * climb the queue only as often as some pass happened to run.
 *
 * THE WEIGHTS LIVE HERE, IN JAVASCRIPT, and not in the view that supplies the
 * facts. They are judgement rather than a set operation: they will be tuned
 * against how the desk actually works, and tuning them must not mean a migration
 * or a schema re-apply. The database answers "when did the customer last write,
 * and had we replied"; this module answers "and therefore how much does that
 * matter". Same split as `shouldAutoClose` and the evidence rules.
 *
 * FIVE FACTORS:
 *
 *   1. level            25   what work the ticket needs
 *   2. customer wait    35   how long they have been waiting on US
 *   3. times contacted  14   how many times they have had to write
 *   4. awaiting_human    6   the agent looked and concluded a person must act
 *   5. VIP               2   who they are
 *
 * Wait is deliberately the largest ordinary factor: once a customer is waiting,
 * age should move the ticket harder than a single level step. Level still sets
 * the severity baseline, but below level 4 the queue is weighted rather than
 * tiered.
 */

/**
 * LEVEL 4 IS A BAND, NOT A WEIGHT.
 *
 * 1000 against a maximum of 82 for everything else: no combination of waiting,
 * contacting, escalating and being a champion can reach a level 4. That is the
 * one place in this score where a factor is absolute, and it is absolute because
 * level 4 means an explicit legal threat or grave harm to a person — there is no
 * amount of ordinary urgency that should be served first.
 *
 * The other three levels are ordinary weights, so a level 2 on its fifth email
 * after six weeks DOES outrank a level 3 that arrived this morning (18+35+14+2 =
 * 69 against 25). That is what weighting means as opposed to strict tiering, and
 * it is the intended behaviour: the alternative starves the oldest work in the
 * lower band for ever.
 *
 * UNCATEGORISED SCORES AS A LEVEL 2, not as a zero. A ticket the categoriser has
 * not read yet is of UNKNOWN severity, and unknown is not low — parking it at
 * the bottom of the queue is how the one that mattered gets missed.
 */
const LEVEL_POINTS = { 1: 10, 2: 18, 3: 25, 4: 1000 };
const UNCATEGORISED_POINTS = LEVEL_POINTS[2];

/**
 * Customer wait, as a DIMINISHING curve rather than a straight line.
 *
 * The gap between one day and three matters far more than the gap between forty
 * and forty-two: lateness is felt logarithmically, and a linear score lets one
 * ancient thread outrank everything else on age alone.
 *
 * SATURATES AT 14 DAYS — past a fortnight a ticket is simply late, and how late
 * stops being the interesting question. The cap is the "how long is
 * unacceptable" knob and is tuned for the steady state the desk wants, NOT for a
 * backlog: on a queue where most tickets are already months old the factor goes
 * near-binary, which is an argument for clearing the backlog rather than for
 * flattening the curve.
 */
const WAIT_MAX_POINTS = 35;
const WAIT_SATURATES_AFTER_DAYS = 14;

/**
 * How many times the customer has had to write in, counted as INBOUND messages
 * only — a thread where we sent five replies is not five contacts.
 *
 * Diminishing, and capped at four: the difference between one email and two is
 * the customer having to chase, which is the signal; the difference between six
 * and seven is the same conversation continuing.
 */
const CONTACT_POINTS = { 2: 7, 3: 11 };
const CONTACT_MAX_POINTS = 14;

/** The agent examined the ticket and concluded a PERSON must act. */
const AWAITING_HUMAN_POINTS = 6;

/** CHAMPIONS + LOYAL, derived from the live Shopify segment. */
const VIP_POINTS = 2;

export const PRIORITY_BANDS = {
  high: 70,
  medium: 45
};

export const PRIORITY_WEIGHTS = {
  level: LEVEL_POINTS,
  uncategorised: UNCATEGORISED_POINTS,
  waitMax: WAIT_MAX_POINTS,
  waitSaturatesAfterDays: WAIT_SATURATES_AFTER_DAYS,
  contact: CONTACT_POINTS,
  contactMax: CONTACT_MAX_POINTS,
  awaitingHuman: AWAITING_HUMAN_POINTS,
  vip: VIP_POINTS,
  bands: PRIORITY_BANDS
};

/** The status that means the agent handed this to a person and nobody has acted. */
const AWAITING_HUMAN = 'awaiting_human';

export function levelPoints(level) {
  if (level === null || level === undefined) {
    return UNCATEGORISED_POINTS;
  }
  return LEVEL_POINTS[Number(level)] ?? UNCATEGORISED_POINTS;
}

/**
 * Days the customer has been waiting, or 0 if they are not waiting on us.
 *
 * `waitingSince` is null whenever we have replied since their last message —
 * that is the database's job (see the `ticket_message_activity` view), and it is
 * the whole difference between this and `last_message_at`, which advances on our
 * own replies too and would report a ticket answered yesterday as "waiting 40
 * days".
 *
 * A negative interval (a clock skew, a message stamped in the future) is treated
 * as no wait rather than as a negative score.
 */
export function waitDays(waitingSince, now = new Date()) {
  if (!waitingSince) {
    return 0;
  }
  const since = waitingSince instanceof Date ? waitingSince.getTime() : Date.parse(waitingSince);
  if (!Number.isFinite(since)) {
    return 0;
  }
  return Math.max(0, (now.getTime() - since) / 86_400_000);
}

export function waitPoints(waitingSince, now = new Date()) {
  const days = waitDays(waitingSince, now);
  if (days <= 0) {
    return 0;
  }
  // log1p rather than a ratio: 1 day is worth 9 of the 35, 3 days 18, 7 days 27.
  const curve = Math.log1p(days) / Math.log1p(WAIT_SATURATES_AFTER_DAYS);
  return WAIT_MAX_POINTS * Math.min(1, curve);
}

export function contactPoints(inboundCount) {
  const n = Number.isFinite(inboundCount) ? Math.floor(inboundCount) : 0;
  if (n >= 4) {
    return CONTACT_MAX_POINTS;
  }
  return CONTACT_POINTS[n] ?? 0;
}

/**
 * The score. Higher is more urgent.
 *
 * Rounded to one decimal so two tickets that differ only by seconds of wait do
 * not shuffle against each other between renders — the ordering has to be stable
 * enough that the row you were about to click does not move.
 */
export function scorePriority(ticket, now = new Date()) {
  const score =
    levelPoints(ticket.level) +
    waitPoints(ticket.waitingSince, now) +
    contactPoints(ticket.inboundCount) +
    (ticket.status === AWAITING_HUMAN ? AWAITING_HUMAN_POINTS : 0) +
    (ticket.isVip ? VIP_POINTS : 0);

  return Math.round(score * 10) / 10;
}

/**
 * Why a ticket sits where it does, as the contribution of each factor.
 *
 * Exists because a priority nobody can interrogate is a priority nobody trusts:
 * the first question anyone asks of an ordered queue is "why is that above
 * this", and the answer has to be readable without opening a spreadsheet.
 */
export function explainPriority(ticket, now = new Date()) {
  const parts = [
    { factor: 'level', points: levelPoints(ticket.level) },
    { factor: 'wait', points: Math.round(waitPoints(ticket.waitingSince, now) * 10) / 10 },
    { factor: 'contacts', points: contactPoints(ticket.inboundCount) },
    { factor: 'awaiting_human', points: ticket.status === AWAITING_HUMAN ? AWAITING_HUMAN_POINTS : 0 },
    { factor: 'vip', points: ticket.isVip ? VIP_POINTS : 0 }
  ];
  return { score: scorePriority(ticket, now), parts };
}

export function priorityBand(score) {
  if (score >= PRIORITY_BANDS.high) {
    return 'high';
  }
  if (score >= PRIORITY_BANDS.medium) {
    return 'medium';
  }
  return 'low';
}

/**
 * Highest priority first, oldest wait breaking a tie.
 *
 * The tiebreak matters more than it looks: 54 distinct scores over 214 tickets
 * means ties are common, and without a stable second key the order of tied rows
 * depends on the order the database happened to return them.
 */
export function byPriorityDesc(now = new Date()) {
  return (a, b) => {
    const diff = scorePriority(b, now) - scorePriority(a, now);
    if (diff !== 0) {
      return diff;
    }
    return waitDays(b.waitingSince, now) - waitDays(a.waitingSince, now);
  };
}
