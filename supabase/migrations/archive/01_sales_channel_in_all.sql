-- ============================================================================
-- 01 — A MARKETPLACE CAN STAY OUT OF "ALL PLATFORMS"
--
-- `sales_channels.in_all`: false for a channel whose orders carry no money in
-- Shopify. The Bradery (via Garnet, handle `garnet-seller`) arrived 2026-11-05:
-- 150 orders in ten days, every one at €0. November to the 16th, "All
-- platforms" read 386 orders at a €53.83 basket; without them, 236 at €88.05.
-- Its orders keep their own platform in
-- the filter; "All" leaves them out through the `p_not_channels` argument every
-- ranged function already takes, so no function changes here.
--
-- A merchant's judgement, edited in Setup -> Sales channels. Default true:
-- every existing marketplace keeps counting. IDEMPOTENT. Touches only a
-- three-row table.
-- ============================================================================

alter table public.sales_channels
  add column if not exists in_all boolean not null default true;

comment on column public.sales_channels.in_all is
  'False when this marketplace''s orders carry no money in Shopify (every order €0): they stay under its own platform and are left out of "All platforms" figures. Edited in Setup -> Sales channels.';
