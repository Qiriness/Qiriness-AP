-- ============================================================================
-- 73 — AN AUTOMATIC REPLY IS STORED AS NOBODY'S MESSAGE
--
-- `ticket_messages.actor` gains `automated`: an out-of-office or vacation
-- responder answering our reply. Ingestion recognises it from its headers
-- (Auto-Submitted: auto-replied, X-Autoreply, X-Apple-Action: VACATION…) and,
-- failing those, its subject (agent/src/ingestion/auto-reply.mjs). The message
-- stays in the thread; it does not reopen the ticket, wake a snooze or count as
-- who spoke last.
--
-- MESSAGES ONLY. `ticket_case_state.actor` and `case_current.last_actor` /
-- `next_actor` are unchanged: an automatic reply is never read by the Case
-- Manager and never folded, so neither table can receive it.
--
-- DECISIONS.md § An automatic reply is nobody. NO DATA IS WRITTEN:
-- `npm run actors:backfill` re-files the stored ones. COPIED FROM
-- 04_support.sql (73_automated_actor.test.mjs asserts they agree). IDEMPOTENT.
--
-- Requires: 04_support.sql, 41_case_current.sql.
-- ============================================================================

alter table public.ticket_messages
  drop constraint if exists ticket_messages_actor_check;

alter table public.ticket_messages
  add constraint ticket_messages_actor_check check (
    actor is null or actor in ('customer', 'support', 'colleague', 'partner', 'automated')
  );
