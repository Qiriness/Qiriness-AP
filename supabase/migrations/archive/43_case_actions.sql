-- ============================================================================
-- 43 — A PERSON MARKS A CHECK DONE OR CANCELLED
--
-- Stage 5 of codex_plans/Case_State_Plan.md: `ticket_case_actions`, one row per
-- dashboard action on an open check. A check a colleague settled by phone, or
-- that became moot, otherwise stays owed forever.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (43_case_actions.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql.
-- ============================================================================

create table if not exists public.ticket_case_actions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- The obligation it settles, by the id the fold gives it (`o-<message>-<n>`).
  obligation_id text not null,
  action text not null,
  note text,

  -- The dashboard user's id, never a name or an address.
  acted_by text,
  acted_at timestamptz not null default now(),

  constraint ticket_case_actions_action_check check (
    action in ('fulfilled', 'cancelled')
  )
);

create index if not exists ticket_case_actions_ticket_idx
  on public.ticket_case_actions (ticket_id, acted_at);

alter table public.ticket_case_actions enable row level security;

comment on table public.ticket_case_actions is
  'What a person did to a case from the dashboard: an open check marked done or cancelled. The fold (agent/src/casework/case-fold.mjs) applies these after the readings, so a check that was settled by phone or in Shopify stops being owed. Append-only.';
