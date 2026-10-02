-- ============================================================================
-- 63 — DRAFTS THAT MAY NEVER SEND THEMSELVES, AND WHY
--
-- `support_exemplars.never_auto_send`: a per-situation switch on the Rules page.
-- A draft answering a marked situation is written and never auto-sent, whatever
-- the ticket's level or category.
--
-- `ticket_drafts.auto_send_blockers`: every reason a draft may not send itself,
-- including the new health_topic one (the customer names a health condition).
-- Shown to the reviewer.
--
-- Ticket ba09c1ae is why: a glaucoma question filed `product`, level 1, that the
-- cosmetovigilance gate never saw. DECISIONS.md § A health condition never
-- sends itself.
--
-- NO DATA IS WRITTEN: which situations are held is the business's choice, set
-- on the Rules page (or one update) after.
-- COPIED FROM 05_exemplars.sql AND 07_drafting.sql (63_never_auto_send.test.mjs
-- asserts it). IDEMPOTENT.
--
-- Requires: 05_exemplars.sql, 07_drafting.sql.
-- ============================================================================

alter table public.support_exemplars
  add column if not exists never_auto_send boolean not null default false;

comment on column public.support_exemplars.never_auto_send is
  'Set by a person on the Rules page: a draft answering this situation is written but never sends itself, whatever the ticket''s level or category. The drafting pass records it as an auto_send_blockers entry (reason situation).';

alter table public.ticket_drafts
  add column if not exists auto_send_blockers jsonb not null default '[]'::jsonb;

comment on column public.ticket_drafts.auto_send_blockers is
  'Why this draft may not send itself, as [{ reason, detail }]: health_topic (the customer names a health condition; detail lists the words), situation (a never_auto_send situation; detail lists the keys), cosmetovigilance, needs_human, level, unhappy, checks_failed. Empty exactly when auto_send_eligible is true.';
