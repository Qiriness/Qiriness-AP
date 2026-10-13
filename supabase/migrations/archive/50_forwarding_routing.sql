-- ============================================================================
-- 50 — FORWARDING ROUTES ON DESTINATIONS
--
-- `forwarding_settings.forward_since`: the master switch. Null forwards
-- nothing; a date forwards only mail RECEIVED from then on, so switching it on
-- never sends the backlog to a colleague, and a delta re-enumeration replaying
-- old mail (re-delivery is not arrival) cannot either.
--
-- `ticket_routing`: the router's decision per ticket — where it goes, or that
-- it stays — kept so the model is asked once, not every poll, and so a
-- follow-up goes where the first message went. Re-decided when the category or
-- kind changes. Also the once-per-ticket record of the acknowledgement.
--
-- `ticket_forwards.destination_label`: which destination a forward went to,
-- snapshotted beside the address it already snapshots.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (50_forwarding_routing.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql, 49_forwarding_destinations.sql.
-- ============================================================================

alter table public.forwarding_settings
  add column if not exists forward_since timestamptz;

comment on column public.forwarding_settings.forward_since is
  'The master switch. Null forwards nothing. Otherwise only inbound mail received at or after this instant is forwarded, so turning forwarding on never sends the backlog.';

alter table public.ticket_forwards
  add column if not exists destination_label text;

comment on column public.ticket_forwards.destination_label is
  'The destination this forward went to, as named when it was sent. Null on rows written before destinations existed.';

create table if not exists public.ticket_routing (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null unique references public.tickets(id) on delete cascade,

  -- What the decision was made on. A different category or kind on the ticket
  -- means the decision is stale and is taken again.
  category text not null,
  request_kind text,

  outcome text not null,
  method text not null,
  -- Null when the ticket stays, or when the destination was deleted since.
  destination_id uuid references public.forwarding_destinations(id) on delete set null,
  destination_label text,
  -- The model's one line; null on a fixed route.
  reason text,
  model text,
  decided_at timestamptz not null default now(),

  -- The acknowledgement, at most once per ticket. `requested` is written BEFORE
  -- the send, so a crash between the two is never retried into a second mail.
  ack_state text,
  ack_at timestamptz,
  ack_error text,
  ack_attempts integer not null default 0,

  constraint ticket_routing_outcome_check check (outcome in ('forward', 'keep')),
  constraint ticket_routing_method_check check (method in ('fixed', 'model')),
  constraint ticket_routing_destination_check check (outcome = 'keep' or destination_label is not null),
  constraint ticket_routing_ack_state_check check (
    ack_state is null or ack_state in ('requested', 'sent', 'failed', 'skipped')
  )
);

create index if not exists ticket_routing_shop_idx on public.ticket_routing (shop_id);

alter table public.ticket_routing enable row level security;

comment on table public.ticket_routing is
  'The forwarding router''s decision per ticket (forward to a destination, or keep), taken once and re-taken when the category or kind changes; and the once-per-ticket acknowledgement state.';

comment on column public.ticket_routing.ack_state is
  'requested (written before sending; never retried) | sent | failed (retried up to the cap) | skipped (automated or internal sender, or acknowledgements off). Null until the first forward.';
