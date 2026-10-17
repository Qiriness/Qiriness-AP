/**
 * How long the worker waits before its next timed poll.
 *
 * WHY. New mail wakes the worker through a `sync_mailbox` job (the Graph
 * webhook), and the dashboard's actions enqueue theirs, so the timed poll is
 * the reconciliation, not the way mail arrives. At a fixed 60 s, an idle poll's
 * ~57 requests were ~75k of ~105k PostgREST requests a day, and Supabase logs
 * every request (~1.5 kB each: 164 MB of log ingest on 2026-10-16).
 *
 * THE RULE. After a poll in which something moved (a table the change gate
 * reads, or the poll failed), wait `baseMs`. After an idle one, double the last
 * wait, up to `maxMs`. Due jobs are still checked between polls, so a
 * notification wakes the worker at once whatever the wait.
 */
export function nextPollWait({ active, previousMs, baseMs, maxMs }) {
  if (active || !(previousMs > 0)) return baseMs;
  return Math.max(baseMs, Math.min(maxMs, previousMs * 2));
}
