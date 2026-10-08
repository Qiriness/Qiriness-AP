-- ============================================================================
-- 80 — THE STOREFRONT ADVISOR'S ADVICE: PLAYBOOKS, MAPPINGS, PRIORITIES, EVENTS
--
-- WHAT THIS ADDS.
--   `advisor_playbooks` — the brand's routine playbooks (« face_hydration »,
--     « face_global_anti_age »…), one row each, the definition as the brand
--     authored it: concerns, preferred family, slots per scope, texture rules,
--     notes. Status `active` is what the advisor reads.
--   `advisor_mappings` — what makes a playbook executable WITHOUT product ids:
--     families → range collections, slots → collections / care types / name
--     words, concerns / skin types / textures / areas → tags and collections,
--     chip labels. One row per entry (kind + key); `_` for a whole section.
--   `advisor_merchandising` — the brand's priority products (neutral, preferred,
--     hero, strategic_launch), by product handle, collection or family,
--     optionally per concern or slot, between dates. Applied AFTER suitability
--     and only within a tie window of the best fit: it reorders suitable
--     products and can never make an unsuitable one recommended.
--   `advisory_events` — channel-aware analytics: conversation and routine
--     builder started/completed, profile fields collected (field + source,
--     never the words), questions asked, products considered/recommended with
--     reason codes, product clicked. `channel` is `storefront_chat` today;
--     `email` is reserved for the support agent later.
--   One function, service role only: the events retention purge.
--
-- WHO READS THEM. The storefront advisor only (scripts/lib/advisory/,
-- scripts/lib/storefront-chat/). The support agent and the dashboard read
-- none of these tables; extracting the advisory core for email is a separate,
-- future change.
--
-- WRITTEN BY `npm run advisor:load` from data/advisor/<brand>.json (the three
-- config tables) and by the storefront chat service (events). Nothing here is
-- edited by the sync.
--
-- NO FOREIGN KEY FROM EVENTS TO `shops` OR TO CHAT SESSIONS. Like 76, the
-- widget may run on a dev store without a `shops` row, and an email event's
-- conversation is a ticket: `conversation_ref` is the session id or the ticket
-- id, as text, and `shop_domain` says which store.
--
-- IDEMPOTENT: `if not exists` and `create or replace`. No data is written.
--
-- Requires: 01_foundation.sql (set_updated_at, shops).
-- ============================================================================

create table if not exists public.advisor_playbooks (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  key text not null,
  position integer not null default 0,
  status text not null default 'active',
  version integer not null default 1,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint advisor_playbooks_key_check check (key ~ '^[a-z0-9_]{1,80}$'),
  constraint advisor_playbooks_status_check check (status in ('active', 'draft', 'archived')),
  constraint advisor_playbooks_unique unique (shop_id, key)
);

drop trigger if exists advisor_playbooks_set_updated_at on public.advisor_playbooks;
create trigger advisor_playbooks_set_updated_at
before update on public.advisor_playbooks
for each row
execute function public.set_updated_at();

alter table public.advisor_playbooks enable row level security;
revoke all on public.advisor_playbooks from anon, authenticated;

comment on table public.advisor_playbooks is
  'The brand''s advisory routine playbooks, as authored (data/advisor/<brand>.json via npm run advisor:load). Read by the storefront advisor only. Products are never named by id here.';

create table if not exists public.advisor_mappings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  kind text not null,
  key text not null,
  position integer not null default 0,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint advisor_mappings_kind_check check (kind in (
    'families', 'slots', 'slot_overrides', 'areas', 'targets', 'skin_types', 'skin_type_groups', 'textures', 'concerns', 'labels',
    'bundles', 'sensitivity', 'maturity', 'merchandising_settings', 'document'
  )),
  constraint advisor_mappings_unique unique (shop_id, kind, key)
);

drop trigger if exists advisor_mappings_set_updated_at on public.advisor_mappings;
create trigger advisor_mappings_set_updated_at
before update on public.advisor_mappings
for each row
execute function public.set_updated_at();

alter table public.advisor_mappings enable row level security;
revoke all on public.advisor_mappings from anon, authenticated;

comment on table public.advisor_mappings is
  'How playbooks resolve against the catalogue without product ids: families, slots, concerns, skin types, textures, areas -> collections, tags, care types, name words; plus chip labels. One row per entry; key _ for a whole section.';

create table if not exists public.advisor_merchandising (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  target_kind text not null,
  target text not null,
  tier text not null,
  concern text,
  slot text,
  starts_at timestamptz,
  ends_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint advisor_merchandising_target_kind_check check (target_kind in ('product', 'collection', 'family')),
  constraint advisor_merchandising_tier_check check (tier in ('neutral', 'preferred', 'hero', 'strategic_launch')),
  constraint advisor_merchandising_dates_check check (starts_at is null or ends_at is null or starts_at < ends_at)
);

drop trigger if exists advisor_merchandising_set_updated_at on public.advisor_merchandising;
create trigger advisor_merchandising_set_updated_at
before update on public.advisor_merchandising
for each row
execute function public.set_updated_at();

alter table public.advisor_merchandising enable row level security;
revoke all on public.advisor_merchandising from anon, authenticated;

comment on table public.advisor_merchandising is
  'The brand''s priority products for advice, by product handle, collection or family, optionally per concern/slot and dates. Applied after suitability, within a tie window: reorders suitable products, never makes an unsuitable one recommended.';

create table if not exists public.advisory_events (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null,
  channel text not null,
  conversation_ref text not null,
  event_type text not null,
  playbook_key text,
  product_ids text[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint advisory_events_channel_check check (channel in ('storefront_chat', 'email')),
  constraint advisory_events_type_check check (event_type in (
    'conversation_started', 'advisory_started', 'routine_builder_started', 'routine_builder_completed',
    'profile_field_collected', 'clarification_asked', 'products_considered', 'products_recommended',
    'product_clicked', 'added_to_cart', 'recommendation_abandoned', 'unresolved_question', 'support_handoff', 'purchase'
  ))
);

create index if not exists advisory_events_shop_idx
  on public.advisory_events (shop_domain, created_at desc);
create index if not exists advisory_events_conversation_idx
  on public.advisory_events (conversation_ref, created_at);
create index if not exists advisory_events_type_idx
  on public.advisory_events (event_type, created_at desc);

alter table public.advisory_events enable row level security;
revoke all on public.advisory_events from anon, authenticated;

comment on table public.advisory_events is
  'Advisory analytics events, channel-aware (storefront_chat now, email reserved). Codes, counts and ids only; never the customer''s words. Purged with advisory_events_purge.';

create or replace function public.advisory_events_purge(p_before timestamptz)
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.advisory_events e
    where e.created_at < p_before
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.advisory_events_purge(timestamptz) from public, anon, authenticated;
grant execute on function public.advisory_events_purge(timestamptz) to service_role;
