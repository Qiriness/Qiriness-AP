-- ============================================================================
-- 99 — WHICH COMPANY POLICIES THE STOREFRONT CHAT MAY READ
--
-- WHAT THIS ADDS.
--   `company_policies.storefront` — true: the storefront chat may read and quote
--     the policy to a shopper. Off by default: most policies are written for the
--     support agent (« Appliquer… », « Ne pas appliquer automatiquement… »: a lost
--     parcel, a reaction, a retailer's order), and the chat sends those cases to
--     customer service instead.
--
-- WHY (owner, 2026-10-20). A policy on the ranges written in the dashboard
-- (« Gamme Qiriness ») never reached the chat: it only read the keys its topics
-- name in code. The chat now reads every active policy switched on here, each
-- one with no topic of its own fetched by its key and its purpose. One switch,
-- set in the dashboard's policy editor, for all of them.
--
-- THE CHAT'S EXISTING POLICIES are switched on below, so nothing it answers
-- changes: the keys scripts/lib/storefront-chat/knowledge-topics.mjs
-- (POLICY_KEYS) names. The support agent ignores the column.
--
-- Requires: nothing. Idempotent.
-- ============================================================================

alter table public.company_policies
  add column if not exists storefront boolean not null default false;

comment on column public.company_policies.storefront is
  'True: the storefront chat may read and quote this policy to a shopper (when active). Set in the dashboard''s policy editor. The support agent ignores it.';

update public.company_policies
set storefront = true
where not storefront
  and policy_key in (
    'delivery_time_policy', 'dispatch_time_policy', 'shipping_cost_policy', 'delivery_location_policy',
    'return_policy', 'refund_policy', 'payment_policy', 'order_cancellation_policy',
    'promotion_discount_policy', 'address_change_policy', 'order_modification_policy'
  );
