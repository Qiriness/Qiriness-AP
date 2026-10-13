-- ============================================================================
-- 54 — SNOOZE
--
-- `ticket_snoozes`: one row per snooze, the open one (woke_at null) being the
-- ticket's current snooze. The queue hides a snoozed ticket until a new
-- message, a change of case or its deadline wakes it. The ticket status is not
-- touched: it still says who acts next.
--
-- Who snoozes and wakes is decided in agent/src/casework/snooze-rule.mjs and
-- scripts/lib/snooze-record.mjs, not here.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (54_ticket_snoozes.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql.
-- ============================================================================

create table if not exists public.ticket_snoozes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- `auto`: the fold, after a message of ours was sent. `manual`: a person.
  source text not null,
  waiting_for text not null,
  reason text,

  -- Every snooze has a deadline: a failed webhook or a partner who never
  -- answers must not hide a case for ever. A new message wakes it sooner.
  wake_at timestamptz not null,

  -- Auto only: the message of ours that was sent, and the case version then.
  trigger_message_id uuid references public.ticket_messages(id) on delete set null,
  case_version integer,

  -- 'agent', or the dashboard user's id. Never a name or an address.
  snoozed_by text,
  snoozed_at timestamptz not null default now(),

  -- Null while the snooze is open.
  woke_at timestamptz,
  wake_reason text,
  woken_by text,

  constraint ticket_snoozes_source_check check (
    source in ('auto', 'manual')
  ),
  constraint ticket_snoozes_waiting_for_check check (
    waiting_for in ('customer', 'colleague', 'partner', 'date')
  ),
  constraint ticket_snoozes_wake_reason_check check (
    wake_reason is null or wake_reason in (
      'customer_message',
      'colleague_message',
      'partner_message',
      'deadline',
      'manual',
      'case_changed',
      'resolved',
      'order_update'
    )
  ),
  constraint ticket_snoozes_woke_check check (
    (woke_at is null) = (wake_reason is null)
  )
);

-- At most one open snooze per ticket.
create unique index if not exists ticket_snoozes_open_key
  on public.ticket_snoozes (ticket_id) where woke_at is null;

-- One automatic snooze per message of ours: a ticket woken by its deadline is
-- not snoozed again until something new happens.
create unique index if not exists ticket_snoozes_auto_trigger_key
  on public.ticket_snoozes (ticket_id, trigger_message_id) where source = 'auto';

-- The deadline sweep.
create index if not exists ticket_snoozes_due_idx
  on public.ticket_snoozes (shop_id, wake_at) where woke_at is null;

alter table public.ticket_snoozes enable row level security;

comment on table public.ticket_snoozes is
  'A case hidden from the queue until something happens: one row per snooze, the open one (woke_at null) being the current. Not a ticket status: the status still says who acts next. Written only by scripts/lib/snooze-record.mjs. History is kept, so an automatic snooze a person undid early stays visible.';
comment on column public.ticket_snoozes.waiting_for is
  'customer | colleague | partner (an operations partner: 3PL or carrier) | date (a person chose a time).';
comment on column public.ticket_snoozes.wake_at is
  'The fallback deadline. The worker wakes the ticket then (wake_reason deadline) without calling a model.';
comment on column public.ticket_snoozes.wake_reason is
  'Why it came back: a new message by actor, the deadline, a person, the case moving to us (case_changed) or to nobody (resolved), or an order update.';
