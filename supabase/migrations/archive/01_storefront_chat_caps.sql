-- ============================================================================
-- 01 — THE STOREFRONT CHAT'S CAPS, A NUMBER EACH ON THE SHOP
--
-- WHAT THIS ADDS.
--   `shops.storefront_chat_daily_cap` — customer messages the whole shop's
--     storefront chat may receive over the last 24 hours (rolling). Past it
--     nobody is answered until older messages leave the window.
--   `shops.storefront_chat_session_cap` — customer messages one conversation
--     may send. Past it that conversation stops; a new one can start.
--   Null: the default in scripts/lib/storefront-chat/chat-caps.mjs
--   (CHAT_CAP_DEFAULTS). Set on Storefront Agent → Dashboard, read by the chat
--   service at most once a minute per instance.
--
-- WHY COLUMNS AND NOT ENVIRONMENT VARIABLES (owner, 2026-11-02: « make these
-- internal … a number that can be changed »): the caps are the shop's to change
-- from the dashboard, without a deploy. They are ours, not Shopify's, and the
-- shop sync never sends them (scripts/lib/shopify-shop-mapper.mjs), so a
-- nightly cannot reset them.
--
-- The bounds mirror CHAT_CAP_BOUNDS. Two nullable columns with no default:
-- a catalogue change only, no table rewrite. The lock timeout makes it fail
-- fast rather than queue behind traffic on `shops`.
--
-- Requires: nothing. Idempotent.
-- ============================================================================

set lock_timeout = '5s';

alter table public.shops add column if not exists storefront_chat_daily_cap integer;
alter table public.shops add column if not exists storefront_chat_session_cap integer;

alter table public.shops drop constraint if exists shops_storefront_chat_daily_cap_check;
alter table public.shops add constraint shops_storefront_chat_daily_cap_check
  check (storefront_chat_daily_cap is null or storefront_chat_daily_cap between 1 and 100000);

alter table public.shops drop constraint if exists shops_storefront_chat_session_cap_check;
alter table public.shops add constraint shops_storefront_chat_session_cap_check
  check (storefront_chat_session_cap is null or storefront_chat_session_cap between 1 and 500);

comment on column public.shops.storefront_chat_daily_cap is
  'Storefront chat: customer messages the shop may receive over the last 24 hours (Storefront Agent → Dashboard). Null: the default.';
comment on column public.shops.storefront_chat_session_cap is
  'Storefront chat: customer messages one conversation may send (Storefront Agent → Dashboard). Null: the default.';
