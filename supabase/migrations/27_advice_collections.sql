-- 27_advice_collections.sql
--
-- Product advice gains a curation surface: `advice_collections`, one row per
-- Shopify collection, carrying whether support may answer from it, which axis it
-- is, and which products it holds.
--
-- Copied byte-for-byte from 02_shopify.sql (27_advice_collections.test.mjs
-- asserts it). One new table, no column added to an existing one, so nothing is
-- dropped and nothing is rewritten. No data.
--
-- NOT IDEMPOTENT BY GUARD, idempotent by being new: `create table` is the
-- baseline's own style (see the _shared invariant forbidding IF NOT EXISTS), and
-- this file has not been applied anywhere before.

-- ---------------------------------------------------------------- advice_collections

-- The Shopify collections support may answer advice from, and what the team has
-- decided about each.
--
-- WHY A TABLE AND NOT A COLUMN ON products. Membership alone would fit on the
-- product — but none of the rest would. The shop has 175 collections and a
-- product sits in 18 to 30 of them, so the question is never "which collections
-- is this product in" (Black Friday, Singles day, soldes hiver, the OrderlyEmails
-- plugin's index, sixty-two numbered diagnostic-quiz buckets) but "which
-- collections may answer a customer at all", which is a judgement about the
-- COLLECTION. That judgement needs somewhere to live, and this is it.
--
-- READ FROM THE COLLECTION SIDE, and that is forced rather than chosen. The
-- obvious build is `products { collections(first: 50) }` on the existing product
-- query; Shopify prices a query before running it and refuses over 1000 points,
-- and that query is already at the ceiling (see PRODUCT_MAX_PAGE_SIZE: 30 passed,
-- 40 refused). Asking each 33-point product node for fifty collections is not
-- available at any page size worth having. One request per ACTIVATED collection
-- is, and it fetches only what somebody has decided is worth fetching.
--
-- THREE COLUMNS ARE OURS AND THE SYNC MUST NEVER WRITE THEM: is_active, axis and
-- note. Same mechanism as promotions.offerable_in_replies and
-- products.recommended_for_concerns — the mapper returns a fixed column set and
-- the upsert merges duplicates, so a column absent from the payload is left
-- alone. The mapper's own test asserts it.
create table public.advice_collections (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_collection_id text not null,
  handle text not null,
  title text not null,
  products_count integer,

  -- --- ours, never the sync's ---------------------------------------------
  is_active boolean not null default false,
  axis text,
  note text,

  -- --- membership, refreshed for ACTIVE collections only -------------------
  product_ids text[] not null default '{}',
  products_synced_at timestamptz,

  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint advice_collections_shopify_unique unique (shop_id, shopify_collection_id),
  -- TWO AXES, BECAUSE THE INTERSECTION NEEDS BOTH. « un serum pour mes rides »
  -- is one requirement of each kind, and a tool that could not tell them apart
  -- could not relax the right one when nothing sits in both.
  constraint advice_collections_axis_check check (
    axis is null or axis in ('concern', 'category')
  )
);

create index advice_collections_active_idx
on public.advice_collections (shop_id, is_active)
where deleted_at is null;

create index advice_collections_product_ids_gin_idx
on public.advice_collections using gin (product_ids);

create trigger advice_collections_set_updated_at
before update on public.advice_collections
for each row
execute function public.set_updated_at();

alter table public.advice_collections enable row level security;

comment on table public.advice_collections is
  'Shopify collections as a curation surface for product advice: every collection the shop has, plus whether support may answer from it, which axis it is, and the products it holds. Membership is refreshed for active collections only.';

comment on column public.advice_collections.is_active is
  'Local, never written by the sync: whether support may answer advice from this collection. False for every collection until somebody switches it on — 175 exist and most are seasonal merchandising or diagnostic-quiz output.';

comment on column public.advice_collections.axis is
  'Local: concern (rides, taches, cernes) or category (serums, cremes de nuit). The two are intersected and relaxed differently.';

comment on column public.advice_collections.note is
  'Local: why the team switched this collection on, for whoever reads the list next.';

comment on column public.advice_collections.product_ids is
  'Shopify product GIDs in this collection, refreshed only while is_active. Joins to products.shopify_product_id; liveness is decided against products.status at read time, never frozen here.';

comment on column public.advice_collections.products_synced_at is
  'When product_ids was last refreshed. Null on a collection nobody has activated, which is the ordinary case.';
