-- ============================================================================
-- 48 — A PERSON CORRECTS A TICKET
--
-- `tickets.overrides` holds the active corrections per field (situation,
-- category, level, status, team, priority band), each with the pipeline's own
-- value beside it. `ticket_overrides` is the append-only audit of every set and
-- every reset. `ticket_queue` gains the column, appended last.
--
-- What a correction triggers (a new investigation, a new case version, a held
-- status) is decided in scripts/lib/ticket-overrides.mjs, not here.
--
-- NO DATA IS WRITTEN: every existing ticket reads '{}', which the fold treats as
-- « nothing overridden », so no case version moves. COPIED FROM 04_support.sql
-- (48_ticket_overrides.test.mjs asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql.
-- ============================================================================

alter table public.tickets
  add column if not exists overrides jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tickets_overrides_object_check'
  ) then
    alter table public.tickets
      add constraint tickets_overrides_object_check check (jsonb_typeof(overrides) = 'object');
  end if;
end $$;

comment on column public.tickets.overrides is
  'A person''s corrections, per field: { value, ai_value, set_by, set_at, source }. The column of an overridden field holds the person''s value; ai_value keeps the pipeline''s, and the categoriser keeps it current. Empty object when nothing is overridden.';

create table if not exists public.ticket_overrides (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  field text not null,
  action text not null,
  -- Null on a reset. Text whatever the field: a level is stored as '3'.
  value text,
  -- What the pipeline said at the time, so a correction can be measured against it.
  ai_value text,
  source text,

  -- The dashboard user's id, never a name or an address.
  set_by text,
  set_at timestamptz not null default now(),

  constraint ticket_overrides_field_check check (
    field in ('situation', 'category', 'level', 'status', 'responsible_team', 'priority')
  ),
  constraint ticket_overrides_action_check check (action in ('set', 'cleared')),
  constraint ticket_overrides_value_check check ((action = 'set') = (value is not null))
);

create index if not exists ticket_overrides_ticket_idx
  on public.ticket_overrides (ticket_id, set_at);

alter table public.ticket_overrides enable row level security;

comment on table public.ticket_overrides is
  'Every correction a person made to a ticket from the dashboard, and every reset to automatic. Append-only audit: the active values live in tickets.overrides.';

-- `create or replace` may only APPEND a column, which is why `overrides` is last.
create or replace view public.ticket_queue
with (security_invoker = true) as
  select
    t.id as id,
    t.shop_id as shop_id,
    t.subject as subject,
    t.status as status,
    t.category as category,
    t.secondary_category as secondary_category,
    t.level as level,
    t.happiness as happiness,
    t.responsible_team as responsible_team,
    t.requester_name as requester_name,
    t.shopify_order_number as shopify_order_number,
    t.first_message_at as first_message_at,
    t.last_message_at as last_message_at,
    t.archived_at as archived_at,
    t.duplicate_of_ticket_id as duplicate_of_ticket_id,
    t.duplicate_reason as duplicate_reason,
    c.display_name as customer_display_name,
    c.first_name as customer_first_name,
    c.last_name as customer_last_name,
    c.rfm_group as customer_rfm_group,
    f.from_email as requester_email,
    coalesce(n.message_count, 0) as message_count,
    coalesce(n.inbound_count, 0) as inbound_count,
    case
      when n.latest_inbound_at is not null
        and (n.latest_outbound_at is null or n.latest_inbound_at > n.latest_outbound_at)
      then n.latest_inbound_at
      else null
    end as waiting_since,
    t.sender_label as sender_label,
    t.overrides as overrides
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  left join public.ticket_message_counts n on n.ticket_id = t.id
  left join public.ticket_first_inbound f on f.ticket_id = t.id
  where t.deleted_at is null;
