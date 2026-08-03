// Auto-close: a ticket nobody has touched for three weeks stops sitting in the
// queue pretending to be live work.
//
// WHY THIS EXISTS. Nothing closed a ticket before this pass, so `status` carried
// no information: all 565 tickets on the measured mailbox read `open`, including
// threads whose last message was seven months old. A queue where everything is
// open is the same as a queue with no status at all.
//
// LEVEL 4 IS EXEMPT AND THAT IS THE WHOLE SAFETY MARGIN. Level 4 is severity,
// not subject — an explicit threat of legal action or public exposure,
// hospitalisation, or grave danger (see 03_categorisation.sql). Closing one
// because nobody replied for three weeks is exactly the case where silence means
// the opposite of "resolved". Every other level closes, including level 3.
//
// Inactivity is measured on `last_message_at`, which ingestion advances for our
// own replies as well as the customer's — so a thread the team is working stays
// open even while the customer is quiet.

export const AUTO_CLOSE_AFTER_DAYS = 21;

/** Already finished: closing these again would rewrite closed_at for nothing. */
const TERMINAL_STATUSES = new Set(['resolved', 'closed']);

/** Severity levels that never auto-close. */
export const AUTO_CLOSE_EXEMPT_LEVELS = new Set([4]);

/**
 * Pure decision, exported so the policy can be tested without a database.
 * `now` is injected rather than read from the clock so a test can pin it.
 */
export function shouldAutoClose(
  ticket,
  { now = new Date(), afterDays = AUTO_CLOSE_AFTER_DAYS, exemptLevels = AUTO_CLOSE_EXEMPT_LEVELS } = {}
) {
  if (!ticket || TERMINAL_STATUSES.has(ticket.status)) {
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
  const last = ticket.last_message_at ? Date.parse(ticket.last_message_at) : NaN;
  if (Number.isNaN(last)) {
    return false;
  }

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
  store,
  shopId,
  logger,
  now = new Date(),
  afterDays = AUTO_CLOSE_AFTER_DAYS,
  dryRun = false,
  onPreview
} = {}) {
  const cutoff = new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000);
  const candidates = await store.findInactive(shopId, cutoff);

  const totals = { considered: candidates.length, closed: 0, exempt: 0, failed: 0 };

  for (const ticket of candidates) {
    if (!shouldAutoClose(ticket, { now, afterDays })) {
      totals.exempt += 1;
      continue;
    }

    onPreview?.(ticket);
    if (dryRun) {
      totals.closed += 1;
      continue;
    }

    try {
      await store.closeTicket(ticket, now);
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
 * Supabase-backed store.
 *
 * The status/date narrowing happens in the query and the level exemption in
 * `shouldAutoClose`: PostgREST's `not.eq` on a nullable column drops the NULL
 * rows too, which would silently spare every uncategorised ticket — the largest
 * group of all. Filtering level in JS keeps that policy in one readable place.
 */
export function createAutoCloseStore(supabase, { supabaseSelectAll, supabaseUpdateById }) {
  return {
    async findInactive(shopId, cutoff) {
      return supabaseSelectAll(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          deleted_at: { operator: 'is', value: null },
          status: { operator: 'not.in', value: '(resolved,closed)' },
          last_message_at: { operator: 'lt', value: cutoff.toISOString() }
        },
        // needs_categorisation is read so a ticket still queued for the
        // categoriser is not closed out of that queue — see shouldAutoClose.
        'id,status,level,last_message_at,subject,deleted_at,metadata,needs_categorisation'
      );
    },

    async closeTicket(ticket, now) {
      const iso = now.toISOString();
      return supabaseUpdateById(supabase, 'tickets', ticket.id, {
        status: 'closed',
        closed_at: iso,
        updated_at: iso,
        // Stamped so an auto-close is distinguishable from one an operator made
        // by hand — otherwise the queue's history cannot explain itself. Merged
        // rather than replaced: metadata belongs to whoever else writes it.
        metadata: { ...(ticket.metadata || {}), closed_reason: 'inactivity' }
      });
    }
  };
}
