-- ============================================================================
-- 97 — THE STOREFRONT ADVISOR'S KNOWLEDGE: PRODUCTS AND ROUTINES, ONE VERSION PER LOAD
--
-- WHAT THIS ADDS.
--   `advisor_knowledge` — what the foundation engine runs for a shop: the
--     product knowledge (the spreadsheet's Products tab, as the rules keep it:
--     type, concerns, skin types, texture, sensitivity, kit contents…) and the
--     routines assembled from its Routines and Rules tabs with the brand's
--     routine settings. One row per load, numbered; exactly one `active` per
--     shop, the one the advisor reads. Older versions stay, `archived`, so a
--     load can be compared with the last and rolled back.
--
-- WHO READS IT. The storefront chat service (web/lib/server/storefront-chat-
-- service.ts), once per agent build. Nothing else.
--
-- WRITTEN BY `npm run advisor:load`, from data/advisor/<brand>-knowledge.json
-- (the spreadsheet's transcription) and data/advisor/<brand>-routine-settings.json.
-- Products are named by handle, never by id: the same knowledge serves a dev
-- store that shares the handles.
--
-- Owner's go-ahead: 2026-10-16 (« you can make the spreadsheet live »).
-- Requires: shops, set_updated_at().
-- ============================================================================

create table if not exists public.advisor_knowledge (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  version integer not null,
  status text not null default 'active',
  source text not null,
  products jsonb not null,
  routines jsonb not null,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint advisor_knowledge_status_check check (status in ('active', 'archived')),
  constraint advisor_knowledge_version_check check (version > 0),
  constraint advisor_knowledge_products_check check (jsonb_typeof(products) = 'array'),
  constraint advisor_knowledge_routines_check check (jsonb_typeof(routines) = 'object'),
  constraint advisor_knowledge_unique unique (shop_id, version)
);

create unique index if not exists advisor_knowledge_one_active
  on public.advisor_knowledge (shop_id)
  where status = 'active';

drop trigger if exists advisor_knowledge_set_updated_at on public.advisor_knowledge;
create trigger advisor_knowledge_set_updated_at
before update on public.advisor_knowledge
for each row
execute function public.set_updated_at();

alter table public.advisor_knowledge enable row level security;
revoke all on public.advisor_knowledge from anon, authenticated;

comment on table public.advisor_knowledge is
  'The storefront advisor''s product knowledge and assembled routines, one version per npm run advisor:load; one active per shop. Products by handle. Read by the storefront advisor only.';
