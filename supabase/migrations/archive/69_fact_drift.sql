-- ============================================================================
-- 69 — WHAT MOVED UNDER A CASE FILE
--
-- `tickets.fact_drift` is the change router's record (agent/src/casework/
-- change-router.mjs): which order states now read otherwise than the case file
-- was decided on, and what the router did about it --
-- { changed: { state: { from, to } }, outcome, reason, case_file_at, checked_at }.
--
-- WHY A COLUMN. The fold hashes it (case-fold.mjs), so a drift raises the case
-- version once: open drafts go stale, the pre-send check refuses an approval
-- written for the old facts, and the drafting pass writes the new version. The
-- drafting pass reads it to leave out the case file's order claims that the
-- order has since contradicted. DECISIONS.md § Change router.
--
-- NULL UNTIL SOMETHING MOVES, and the fold adds it to the hash only when
-- present: no existing ticket changes version when this is applied.
--
-- AND ONE MORE CANCEL REASON. `outbound_actions.cancel_reason` gains
-- `facts_pending`: the pre-send check refused because the order moved in a way
-- the customer would notice and the pipeline has not read it yet. The column
-- has no check on its values; the comment is the list (47's test holds it to
-- CANCEL_REASONS), so only the comment changes.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (69_fact_drift.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql, 47_outbound_actions.sql.
-- ============================================================================

alter table public.tickets
  add column if not exists fact_drift jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tickets_fact_drift_object_check'
  ) then
    alter table public.tickets
      add constraint tickets_fact_drift_object_check check (fact_drift is null or jsonb_typeof(fact_drift) = 'object');
  end if;
end $$;

comment on column public.tickets.fact_drift is
  'The change router''s record of order states that moved since the latest case file: { changed: { state: { from, to } }, outcome (redraft | reinvestigate), reason, case_file_at, checked_at }. Null until something moves. The fold hashes it, so a drift raises the case version once.';

comment on column public.outbound_actions.cancel_reason is
  'Which pre-send check refused: case_moved, customer_wrote_again, already_answered, draft_withdrawn, auto_send_off, facts_pending (the order moved materially and the pipeline has not read it yet; 69_fact_drift.sql). Present exactly when state is cancelled.';
