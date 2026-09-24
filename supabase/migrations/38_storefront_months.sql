-- ============================================================================
-- 38 — CLOSED MONTHS OF SHOPIFY ANALYTICS, KEPT SO A LONG RANGE IS NOT LIVE
--
-- WHAT THIS ADDS. `storefront_session_months`: one row per shop and closed
-- month of human sessions and the funnel counts. Written by the nightly sync
-- (scripts/lib/storefront-months-sync.mjs), read by
-- web/lib/server/insights/analytics.ts.
--
-- WHY. ShopifyQL is rate-limited on a bucket of its own: 1,000 points a
-- minute, charged per ~30-day slice of the range (measured 2026-09-24). One
-- year of the Overview cost 1,353 points and could never be answered in one
-- render; a 6-month attempt drained the bucket and made the 7-day range fail
-- after it. A closed month is read from here instead, and only the last two
-- months and the stray days at a range's edges are asked live.
--
-- SESSIONS ONLY. MONEY STAYS LIVE. Net sales and AOV are the figures the
-- owner reads first, so they are always Shopify's answer for the exact range,
-- at every length (the owner's call, 2026-09-24). The ladder fits the budget
-- on its own: a year and its comparison year cost 425 points.
--
-- COUNTS ONLY, BECAUSE ONLY THOSE ADD UP. Conversion is rebuilt as
-- converted ÷ sessions, which is Shopify's own definition. Unique visitors and
-- bounce rate cannot be summed across months and are not stored.
--
-- `month` is the first day of the month ON THE SHOP'S CLOCK, which is the
-- clock ShopifyQL's TIMESERIES month buckets on.
--
-- IDEMPOTENT: `create table if not exists`. No data is written here; the
-- nightly sync backfills.
--
-- Requires: 01_foundation.sql (shops).
-- ============================================================================

create table if not exists public.storefront_session_months (
  shop_id uuid not null references public.shops(id) on delete cascade,
  month date not null,
  sessions bigint not null,
  pageviews bigint not null,
  cart_sessions bigint not null,
  checkout_sessions bigint not null,
  converted_sessions bigint not null,
  fetched_at timestamptz not null default now(),
  primary key (shop_id, month),
  constraint storefront_session_months_first_day_check check (extract(day from month) = 1)
);

alter table public.storefront_session_months enable row level security;
revoke all on public.storefront_session_months from anon, authenticated;

comment on table public.storefront_session_months is
  'Closed months of Shopify Analytics human sessions and funnel counts, on the shop clock. Rewritten nightly; the last two months are always read live.';
