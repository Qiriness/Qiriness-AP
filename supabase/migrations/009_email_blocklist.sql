-- Deterministic first-pass spam filter for the agent email workflow
-- (Phase 2, see AGENT_INTEGRATION_PLAN.md). Senders listed here are dropped at
-- ingestion *before* anything is written to tickets/ticket_messages, so blocked
-- spam never consumes storage. This is a cheap, no-LLM gate; a fuzzy LLM pass
-- comes later for what a blocklist can't catch.
--
-- A rule matches by exact sender email or by sender domain. Adding a rule also
-- purges any already-stored mail from that sender (the worker's add-rule flow),
-- so "blacklist this address" removes their spam past and future.

create table public.email_blocklist (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  pattern_type text not null,
  pattern text not null,
  reason text,
  created_by text not null default 'system',

  -- Observability: how often this rule has blocked something.
  hit_count integer not null default 0,
  last_hit_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint email_blocklist_shop_pattern_unique unique (shop_id, pattern_type, pattern),
  constraint email_blocklist_pattern_type_check check (pattern_type in ('email', 'domain')),
  constraint email_blocklist_hit_count_check check (hit_count >= 0)
);

create index email_blocklist_shop_pattern_idx on public.email_blocklist (shop_id, pattern_type, pattern);

create trigger email_blocklist_set_updated_at
before update on public.email_blocklist
for each row
execute function public.set_updated_at();

alter table public.email_blocklist enable row level security;

comment on table public.email_blocklist is
  'Deterministic sender blocklist for the agent email workflow. Matched senders are dropped at ingestion before any ticket/message is stored, so blocked spam never consumes storage. Service-role worker only until dashboard roles and policies exist.';

comment on column public.email_blocklist.pattern_type is
  'email (exact sender address) or domain (sender domain, e.g. spammer.example). Patterns are stored normalised (trimmed, lowercased; domain without a leading @).';

comment on column public.email_blocklist.pattern is
  'The normalised sender email or domain to block. Matched case-insensitively against the inbound sender at ingestion.';

comment on column public.email_blocklist.hit_count is
  'Number of inbound messages this rule has blocked. Bumped by the ingestion worker; last_hit_at records the most recent block.';
