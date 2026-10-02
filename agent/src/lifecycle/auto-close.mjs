// Auto-close: a ticket nobody has touched for four weeks stops sitting in the
// queue pretending to be live work.
//
// WHY THIS EXISTS. Nothing closed a ticket before this pass, so `status` carried
// no information: all 565 tickets on the measured mailbox read `open`, including
// threads whose last message was seven months old. A queue where everything is
// open is the same as a queue with no status at all.
//
// LEVEL 4 IS EXEMPT AND THAT IS THE WHOLE SAFETY MARGIN. Level 4 is severity,
// not subject — an explicit threat of legal action or public exposure,
// hospitalisation, or grave danger (see 04_support.sql). Closing one
// because nobody replied for four weeks is exactly the case where silence means
// the opposite of "resolved". Every other level closes, including level 3.
//
// Inactivity is measured on `last_message_at`, which ingestion advances for our
// own replies as well as the customer's — so a thread the team is working stays
// open even while the customer is quiet.

export const AUTO_CLOSE_AFTER_DAYS = 28;

/** Already finished: closing these again would rewrite closed_at for nothing. */
const TERMINAL_STATUSES = new Set(['resolved', 'closed']);

/** Severity levels that never auto-close. */
export const AUTO_CLOSE_EXEMPT_LEVELS = new Set([4]);

/**
 * Statuses that never auto-close, whatever the level.
 *
 * `awaiting_human` means the agent examined the ticket and concluded a PERSON
 * must act. Silence on one of those does not mean the conversation resolved
 * itself; it means nobody did the work. Closing it after four weeks files a
 * service failure as a completed ticket, and the queue then looks healthy
 * precisely because the backlog was deleted.
 *
 * This distinction could not be drawn when this pass was written — the
 * investigation did not set a status then, so `level` was the only signal
 * available and level 3 was made closable on queue-hygiene grounds. It now has a
 * better one.
 *
 * The cost is visible rather than silent: unactioned tickets accumulate under
 * one status and `runAutoClose` counts them separately, which is the report a
 * merchant should be looking at. Emptying this set restores the old behaviour in
 * one line if that trade is ever judged wrong.
 */
export const AUTO_CLOSE_EXEMPT_STATUSES = new Set(['awaiting_human']);

/**
 * Pure decision, exported so the policy can be tested without a database.
 * `now` is injected rather than read from the clock so a test can pin it.
 */
export function shouldAutoClose(
  ticket,
  {
    now = new Date(),
    afterDays = AUTO_CLOSE_AFTER_DAYS,
    exemptLevels = AUTO_CLOSE_EXEMPT_LEVELS,
    exemptStatuses = AUTO_CLOSE_EXEMPT_STATUSES,
    snoozed = false,
    // THE CASE, when the thread shares one (61_cases.sql): `held` when another
    // thread of it is exempt (level 4, awaiting a person, snoozed), and
    // `lastActivityAt`, the newest activity on any other thread. A thread is not
    // idle while its case is being worked on another thread.
    caseFacts = null
  } = {}
) {
  if (!ticket || TERMINAL_STATUSES.has(ticket.status)) {
    return false;
  }
  // A snoozed ticket is waiting on purpose, until a date somebody chose. Its
  // deadline brings it back to the queue; silence before then is the plan.
  if (snoozed || caseFacts?.held) {
    return false;
  }
  // Work the agent handed to a person, which nobody did. See the constant.
  if (exemptStatuses.has(ticket.status)) {
    return false;
  }
  // A compliance soft-delete is not ours to touch.
  if (ticket.deleted_at) {
    return false;
  }
  if (ticket.level !== null && ticket.level !== undefined && exemptLevels.has(Number(ticket.level))) {
    return false;
  }

  // Never close a ticket the pipeline has not finished with.
  //
  // The categoriser selects on `status = 'open'` (categorise-runner.mjs), so
  // closing a ticket that is still flagged drops it out of that queue for good
  // and freezes it as uncategorised — a customer reply is then the only thing
  // that could ever label it. The categoriser drains 25 per poll, so this
  // defers a close by a few polls at most, and the flag clears itself either
  // way: a classified ticket loses it, and so does one that can never be
  // classified because the thread holds no customer message at all.
  if (ticket.needs_categorisation) {
    return false;
  }

  // No activity timestamp at all: leave it. A ticket with no last_message_at is
  // malformed, and treating "unknown" as "infinitely stale" would close it on
  // the first pass with no way to tell that apart from a genuinely old thread.
  const own = ticket.last_message_at ? Date.parse(ticket.last_message_at) : NaN;
  if (Number.isNaN(own)) {
    return false;
  }
  const sibling = caseFacts?.lastActivityAt ? Date.parse(caseFacts.lastActivityAt) : NaN;
  const last = Number.isNaN(sibling) ? own : Math.max(own, sibling);

  return now.getTime() - last >= afterDays * 24 * 60 * 60 * 1000;
}

/**
 * Closes every stale ticket. Returns totals rather than the rows, so the caller
 * logs one line per poll instead of one per ticket.
 *
 * ONE FAILURE DOES NOT STOP THE PASS, for the same reason forwarding works that
 * way: a single row that will not update must not block the other 500.
 *
 * `dryRun` decides everything and writes nothing. The first real run closes the
 * entire backlog at once — 510 of 565 tickets on the measured mailbox — so being
 * able to read that list first is worth the flag.
 */
export async function runAutoClose({
  record,
  shopId,
  logger,
  now = new Date(),
  afterDays = AUTO_CLOSE_AFTER_DAYS,
  dryRun = false,
  onPreview,
  // The snooze record: its open snoozes are spared. Optional, as before it existed.
  snoozes = null,
  // The case record: a thread is judged with its case's other threads.
  // Optional; without it each thread is judged alone, as before cases.
  cases = null
} = {}) {
  const cutoff = new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000);
  const candidates = await record.findInactive(cutoff);
  const snoozed = candidates.length > 0 && snoozes ? new Set((await snoozes.allOpen()).map((row) => row.ticket_id)) : new Set();
  const caseIds = [...new Set(candidates.map((ticket) => ticket?.case_id).filter(Boolean))];
  const threadsByCase = new Map();
  if (cases && caseIds.length > 0) {
    for (const row of await cases.threadsOfCases(caseIds, 'id,case_id,status,level,last_message_at')) {
      const list = threadsByCase.get(row.case_id) ?? [];
      list.push(row);
      threadsByCase.set(row.case_id, list);
    }
  }

  // `awaitingHuman` is counted apart from `exempt` because it is the only figure
  // here that is a BACKLOG rather than a policy. Level 4s being spared is the
  // rule working; unactioned human work piling up is the thing to look at, and
  // folded into one number nobody would ever see it.
  const totals = {
    considered: candidates.length,
    closed: 0,
    exempt: 0,
    awaitingHuman: 0,
    snoozed: 0,
    failed: 0
  };

  for (const ticket of candidates) {
    const caseFacts = caseFactsFor(ticket, threadsByCase.get(ticket?.case_id), snoozed);
    if (!shouldAutoClose(ticket, { now, afterDays, snoozed: snoozed.has(ticket?.id), caseFacts })) {
      if (AUTO_CLOSE_EXEMPT_STATUSES.has(ticket?.status)) {
        totals.awaitingHuman += 1;
      } else if (snoozed.has(ticket?.id)) {
        totals.snoozed += 1;
      }
      totals.exempt += 1;
      continue;
    }

    onPreview?.(ticket);
    if (dryRun) {
      totals.closed += 1;
      continue;
    }

    try {
      await record.close(ticket, now);
      totals.closed += 1;
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('lifecycle.auto_close_failed', {
        shopId,
        ticketId: ticket.id,
        message: error.message
      });
    }
  }

  return totals;
}

/**
 * What a thread's case says about closing it: the newest activity on its OTHER
 * threads, and whether one of them holds the case open (level 4, a person's
 * work, a snooze). Null for a thread alone in its case.
 */
export function caseFactsFor(ticket, threads = [], snoozed = new Set(), { exemptLevels = AUTO_CLOSE_EXEMPT_LEVELS, exemptStatuses = AUTO_CLOSE_EXEMPT_STATUSES } = {}) {
  const others = (threads ?? []).filter((row) => row.id !== ticket?.id);
  if (others.length === 0) return null;
  const live = others.filter((row) => !TERMINAL_STATUSES.has(row.status));
  const held = live.some(
    (row) => exemptStatuses.has(row.status) || (row.level !== null && row.level !== undefined && exemptLevels.has(Number(row.level))) || snoozed.has(row.id)
  );
  let lastActivityAt = null;
  for (const row of others) {
    const at = Date.parse(row.last_message_at ?? '');
    if (!Number.isNaN(at) && (lastActivityAt === null || at > Date.parse(lastActivityAt))) lastActivityAt = row.last_message_at;
  }
  return { held, lastActivityAt };
}

// The store this file used to define now lives in scripts/lib/ticket-record.mjs
// with the other seven that wrote the same table: `findInactive` and `close` are
// methods on the ticket record. The one thing that stayed here is the thing that
// was never a query — `shouldAutoClose`, above, which is policy and is tested
// without a database.
