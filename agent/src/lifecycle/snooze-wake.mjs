// The deadline sweep: every snooze whose `wake_at` has passed comes back to
// the queue. Each poll, whatever `--stop-after` says: a snooze a person set
// must end even on the sync-only worker, and this costs one query and no model.
//
// NOTHING ELSE MOVES. No status, no investigation, no draft: a deadline brings
// no new information, so there is nothing for a model to read. The ticket
// returns with « deadline » as the reason and a person decides (chase, close,
// or snooze again). New information wakes a ticket elsewhere, through the
// pipeline: new mail at ingestion, a case that came back to us in the fold.
//
// A CLOSED TICKET DOES NOT COME BACK. Closing ends the snooze where the ticket
// is closed (dashboard, fold); this is the backstop for one closed some other
// way: its due snooze ends as `resolved`, never as « snooze time reached ».

/**
 * @param snoozes the snooze record (scripts/lib/snooze-record.mjs)
 * @returns `{ due, woken, failed }`
 */
export async function runWakeDue({ snoozes, shopId, logger, now = new Date(), limit = 200 }) {
  const totals = { due: 0, woken: 0, failed: 0 };
  const due = await snoozes.due({ now, limit });
  totals.due = due.length;
  const closed = due.length > 0 && snoozes.closedAmong ? await snoozes.closedAmong(due.map((row) => row.ticket_id)) : new Set();
  for (const row of due) {
    try {
      // Conditional on the snooze still being open: a message that woke it
      // since the read keeps its own reason.
      const reason = closed.has(row.ticket_id) ? 'resolved' : 'deadline';
      if (await snoozes.wake(row.ticket_id, reason, { wokenBy: 'agent', at: now })) totals.woken += 1;
    } catch (error) {
      totals.failed += 1;
      logger?.warn?.('lifecycle.snooze_wake_failed', { shopId, ticketId: row.ticket_id, message: error.message });
    }
  }
  return totals;
}
