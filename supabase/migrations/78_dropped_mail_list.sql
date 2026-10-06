-- ============================================================================
-- 78 — CLEARED BLOCKED EMAILS ARE RECORDED, AND THE LIST IS READ IN PAGES
--
-- The Irrelevant list read every blocked decision (1,272 in 22 days, ~800 kB
-- without the text) on every /tickets load, and « clear » only hid rows in one
-- browser's localStorage. `dropped_mail_clears` records a clear for the shop;
-- `dropped_mail_list` leaves cleared and promoted rows out in the database, so
-- the dashboard reads one page at a time with a count.
--
-- COPIED FROM 04_support.sql (78_dropped_mail_list.test.mjs asserts they agree).
-- NO DATA IS WRITTEN. IDEMPOTENT.
-- ============================================================================

-- ---------------------------------------------------------- dropped_mail_clears
-- Blocked emails a person cleared out of the Irrelevant list, for the whole shop.
-- They were hidden per browser, in localStorage, so the server still sent every
-- one. Recorded here, `dropped_mail_list` leaves them out of the read itself.

create table if not exists public.dropped_mail_clears (
  shop_id uuid not null references public.shops(id) on delete cascade,
  spam_audit_id uuid not null references public.spam_audit(id) on delete cascade,
  -- The dashboard user's id. Never a name or an address.
  cleared_by text,
  cleared_at timestamptz not null default now(),
  primary key (shop_id, spam_audit_id)
);

alter table public.dropped_mail_clears enable row level security;

comment on table public.dropped_mail_clears is
  'Blocked emails a person cleared out of the dashboard''s Irrelevant list, shop-wide. The spam_audit row is untouched; « restore » deletes these rows.';

-- ------------------------------------------------------------ dropped_mail_list
-- The Irrelevant list as the dashboard reads it: blocked decisions minus the ones
-- a person cleared and the ones already promoted to a ticket, without the text.
-- `has_body` says whether a text is stored; the dialog reads it on its own.

create or replace view public.dropped_mail_list
with (security_invoker = true) as
  select
    a.id as id,
    a.shop_id as shop_id,
    a.graph_message_id as graph_message_id,
    a.label as label,
    a.decided_by as decided_by,
    a.reason as reason,
    a.from_email as from_email,
    a.subject as subject,
    a.body_captured_at as body_captured_at,
    a.body_expires_at as body_expires_at,
    a.failed_open as failed_open,
    a.decided_at as decided_at,
    (a.body_text is not null) as has_body
  from public.spam_audit a
  where a.outcome = 'blocked'
    and not exists (
      select 1 from public.dropped_mail_clears c
      where c.shop_id = a.shop_id and c.spam_audit_id = a.id
    )
    and not exists (
      select 1 from public.ticket_messages m
      where m.shop_id = a.shop_id and m.graph_message_id = a.graph_message_id
    );

revoke all on public.dropped_mail_list from anon, authenticated;

comment on view public.dropped_mail_list is
  'The Irrelevant list: blocked spam_audit rows not cleared (dropped_mail_clears) and not promoted (a ticket_messages row with the same graph_message_id), with has_body instead of the text.';
