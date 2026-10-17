-- ============================================================================
-- 98 — THE PERSONALISED ROUTINES THE ADVISOR BUILT, KEPT FOR STATISTICS
--
-- WHAT THIS ADDS.
--   `advisor_routines` — one row per routine the routine builder finished: its
--     number (`id`), the answers to the builder's questions (the main concern,
--     the skin type or the eye routine's other eye concern, the age range, day /
--     night / both, each with how it was given), the products it gave and their
--     total, and when « Ajouter au panier » added it.
--
-- ANONYMOUS BY DESIGN (owner, 2026-10-17: « dont save customer name, it can
-- stay anonymous data that will be used for general stats »). No customer, no
-- session, no words: answers are codes (`dry`, `45_plus`, `day`). The age is the
-- brand's range, never the age said. The chat log holds the row's `ref` only
-- while the session lasts (its retention), so « Oui, ajouter » can mark it.
--
-- WRITTEN BY the storefront chat service (web/lib/server/storefront-chat-
-- service.ts) after the reply, never waited for; `added_to_cart_at` by the same
-- service (« Oui, ajouter ») and the widget's « Ajouter la routine au panier »
-- beacon (/api/storefront/event). Read by: nothing yet (statistics to come).
--
-- Requires: nothing.
-- ============================================================================

create table if not exists public.advisor_routines (
  id bigint generated always as identity primary key,
  ref uuid not null,
  shop_domain text not null,
  channel text not null,
  locale text,
  main_concern text,
  primary_concern text,
  secondary_concerns text[] not null default '{}',
  skin_type text,
  eye_concern text,
  age_band text,
  routine_time text not null,
  answer_sources jsonb not null default '{}'::jsonb,
  product_handles text[] not null default '{}',
  total_price numeric(10, 2),
  currency text,
  added_to_cart_at timestamptz,
  created_at timestamptz not null default now(),

  constraint advisor_routines_ref_unique unique (ref),
  constraint advisor_routines_channel_check check (channel in ('storefront_chat', 'email')),
  constraint advisor_routines_time_check check (routine_time in ('day', 'night', 'both')),
  constraint advisor_routines_sources_check check (jsonb_typeof(answer_sources) = 'object')
);

create index if not exists advisor_routines_shop_idx
  on public.advisor_routines (shop_domain, created_at desc);

alter table public.advisor_routines enable row level security;
revoke all on public.advisor_routines from anon, authenticated;

comment on table public.advisor_routines is
  'One row per personalised routine the storefront advisor built: its number (id), the builder''s answers as codes, the products and total, when it was added to the cart. Anonymous: no customer, no session, no words.';
