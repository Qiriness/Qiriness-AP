-- ============================================================================
-- 41 — WHO WROTE EACH MESSAGE, AND THE CURRENT STATE OF EACH CASE
--
-- Stage 4 of codex_plans/Case_State_Plan.md.
--
-- WHAT THIS ADDS.
--   1. `ticket_messages.actor`: customer | support | colleague | partner. Stored
--      at arrival, like sender_label, so relabelling the sender directory never
--      rewrites history. Null on rows written before; `npm run actors:backfill`.
--   2. `case_current`: one row per ticket, the fold of its messages, readings
--      and latest case file. Overwritten in place; ticket_case_state stays the
--      per-message trajectory.
--
-- NO DATA IS WRITTEN. The column starts null and the table empty; the worker's
-- fold pass fills the table and the backfill fills the column.
--
-- COPIED FROM 04_support.sql, NOT RETYPED (41_case_current.test.mjs asserts
-- the two agree).
--
-- IDEMPOTENT: every statement is guarded.
--
-- Requires: 04_support.sql.
-- ============================================================================

alter table public.ticket_messages
  add column if not exists actor text;

alter table public.ticket_messages
  drop constraint if exists ticket_messages_actor_check;

alter table public.ticket_messages
  add constraint ticket_messages_actor_check check (
    actor is null or actor in ('customer', 'support', 'colleague', 'partner')
  );

create table if not exists public.case_current (
  ticket_id uuid primary key references public.tickets(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,

  version integer not null default 1,
  as_of_message_id uuid references public.ticket_messages(id) on delete set null,
  as_of_at timestamptz,
  last_actor text,

  pending_customer_inputs jsonb not null default '[]'::jsonb,
  commitments jsonb not null default '[]'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,
  obligations jsonb not null default '[]'::jsonb,

  next_actor text,
  resolved boolean not null default false,

  material_hash text not null,
  folded_at timestamptz not null default now(),

  constraint case_current_last_actor_check check (
    last_actor is null or last_actor in ('customer', 'support', 'colleague', 'partner')
  ),
  constraint case_current_next_actor_check check (
    next_actor is null or next_actor in ('customer', 'support', 'colleague', 'partner', 'nobody')
  ),
  constraint case_current_pending_inputs_array_check check (
    jsonb_typeof(pending_customer_inputs) = 'array'
  ),
  constraint case_current_commitments_array_check check (
    jsonb_typeof(commitments) = 'array'
  ),
  constraint case_current_contradictions_array_check check (
    jsonb_typeof(contradictions) = 'array'
  ),
  constraint case_current_obligations_array_check check (
    jsonb_typeof(obligations) = 'array'
  )
);

create index if not exists case_current_shop_next_actor_idx
  on public.case_current (shop_id, next_actor);

alter table public.case_current enable row level security;

comment on table public.case_current is
  'The current state of each case, one row per ticket, overwritten in place like resolved_context: folded in code (agent/src/casework/case-fold.mjs) from the ticket''s messages, its Case Manager readings and its latest case file. No model writes it. ticket_case_state stays the per-message trajectory.';

comment on column public.case_current.version is
  'Raised only when material_hash changes, so a thank-you that changes nothing does not make a draft stale (codex_plans/Case_State_Plan.md, stage 6).';

comment on column public.case_current.next_actor is
  'Who owes the next step: customer | support | colleague | partner | nobody. Derived by the fold; nothing reads it to change a ticket''s status yet (stage 5).';

comment on column public.case_current.obligations is
  'Checks owed by support, a colleague or an operations partner. Empty until stage 5 creates them.';
