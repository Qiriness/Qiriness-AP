-- ============================================================================
-- 02 — THE ADDRESS EACH SHOP'S MONTHLY REPORT IS SENT FROM
--
-- WHAT THIS ADDS.
--   `shops.report_sender` — the mailbox the worker sends that shop's monthly
--     sales report from (agent/src/reports/sales-report-mail.mjs), set on
--     Settings → Integrations for the shop on screen. Null: the shop's report
--     is not sent, so it can never go out from another brand's address.
--
-- WHY A COLUMN AND NOT AN ENVIRONMENT VARIABLE (owner, 2026-10-27): the
-- address is the shop's to change from the dashboard, without a deploy. It is
-- ours, not Shopify's, and the shop sync never sends it
-- (scripts/lib/shopify-shop-mapper.mjs), so a nightly cannot reset it.
-- docs/decisions/insights.md § The report is mailed on the 1st….
--
-- The shape check is a guard against a typo, not a validation: Microsoft
-- Graph is the real judge, and its refusal is recorded on the month's
-- integration_events row.
--
-- Requires: nothing. Idempotent.
-- ============================================================================

alter table public.shops add column if not exists report_sender text;

alter table public.shops drop constraint if exists shops_report_sender_shape_check;
alter table public.shops add constraint shops_report_sender_shape_check
  check (report_sender is null or report_sender ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

comment on column public.shops.report_sender is
  'The mailbox this shop''s monthly sales report is sent from (Settings → Integrations). Null: not sent.';
