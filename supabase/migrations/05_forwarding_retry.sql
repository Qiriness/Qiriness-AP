-- ============================================================================
-- 05 — FORWARDING RETRY
-- Makes a failed forward genuinely retryable, which 04 claimed but did not
-- deliver.
--
-- WHAT WENT WRONG. 04 records every attempt in ticket_forwards and relies on
-- `unique (ticket_message_id)` for idempotency. The selection step then skipped
-- any message with a row — regardless of status — so a *failed* attempt
-- permanently excluded that message from ever being forwarded. Found by running
-- it: Exchange was mid-mailbox-move, all 42 sends came back
-- ErrorMailboxMoveInProgress (a transient condition that clears itself), and the
-- next pass found nothing to do. The mail would never have gone out.
--
-- THE FIX IS IN TWO HALVES. The selection now excludes only `sent` rows, and
-- recording upserts on ticket_message_id so a retry updates the existing row
-- instead of colliding with the unique constraint. `attempts` is what stops that
-- becoming an infinite retry: a genuinely undeliverable message (a mistyped
-- address, a mailbox that no longer exists) would otherwise be re-sent on every
-- poll forever. After MAX_FORWARD_ATTEMPTS the row is left alone and stays
-- visible as a failure for a human to look at.
-- ============================================================================

alter table public.ticket_forwards
  add column attempts integer not null default 1;

-- Lets the selection step find "failed but still worth retrying" without a
-- full scan of the ledger.
create index ticket_forwards_retry_idx
  on public.ticket_forwards (shop_id, status, attempts);

comment on column public.ticket_forwards.attempts is
  'How many times this message has been attempted. Retry stops at the cap in agent/src/routing/forwarding-store.mjs, so a permanently undeliverable address fails a bounded number of times and then stays visible instead of being re-sent on every poll.';

comment on column public.ticket_forwards.status is
  'sent | failed. `sent` is final and excludes the message from future passes; `failed` is retried until attempts hits the cap. Recording upserts on ticket_message_id, so a retry updates this row rather than colliding with its unique constraint.';
