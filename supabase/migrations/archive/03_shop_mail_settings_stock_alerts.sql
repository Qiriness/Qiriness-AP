-- ============================================================================
-- 03 — WHO EACH SHOP'S MAIL GOES TO, AND THE STOCK ALERT
--
-- WHAT THIS ADDS.
--   `shops.report_recipients` — who the shop's monthly sales report goes to: a
--     JSON array of `{"role": "<dashboard role>"}` (every active account with
--     that role, resolved at send time) and `{"email": "<address>"}` (anyone).
--     Defaults to the management role, which is who it went to before.
--   `shops.stock_alert_sender`, `shops.stock_alert_recipients` — the same pair
--     for the stock alert: a mail with an Excel file of every product out of
--     stock or critical, sent when a product newly becomes one of them.
--     Null sender or an empty list: no alert for that shop.
--   `stock_alerts` — one row per check that changed something: the products out
--     of stock / critical at that moment. The latest `baseline` or `sent` row is
--     what "newly" is measured against; a `failed` row leaves it unchanged, so
--     the next check sends again.
--
-- WHY ON THE SHOP (owner, 2026-10-27): each shop's sender and recipients are
-- different and set from Settings → Integrations, without a deploy. The shop
-- sync never sends these columns (scripts/lib/shopify-shop-mapper.mjs).
-- docs/decisions/insights.md § The stock alert.
--
-- Requires: 02_shop_report_sender.sql. Idempotent.
-- ============================================================================

alter table public.shops add column if not exists report_recipients jsonb not null default '[{"role": "management"}]'::jsonb;
alter table public.shops add column if not exists stock_alert_sender text;
alter table public.shops add column if not exists stock_alert_recipients jsonb not null default '[]'::jsonb;

alter table public.shops drop constraint if exists shops_report_recipients_array_check;
alter table public.shops add constraint shops_report_recipients_array_check
  check (jsonb_typeof(report_recipients) = 'array');
alter table public.shops drop constraint if exists shops_stock_alert_recipients_array_check;
alter table public.shops add constraint shops_stock_alert_recipients_array_check
  check (jsonb_typeof(stock_alert_recipients) = 'array');
alter table public.shops drop constraint if exists shops_stock_alert_sender_shape_check;
alter table public.shops add constraint shops_stock_alert_sender_shape_check
  check (stock_alert_sender is null or stock_alert_sender ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

comment on column public.shops.report_recipients is
  'Who this shop''s monthly sales report goes to: [{"role": …} | {"email": …}] (Settings → Integrations).';
comment on column public.shops.stock_alert_sender is
  'The mailbox this shop''s stock alert is sent from (Settings → Integrations). Null: no alert.';
comment on column public.shops.stock_alert_recipients is
  'Who this shop''s stock alert goes to: [{"role": …} | {"email": …}]. Empty: no alert.';

create table if not exists public.stock_alerts (
  id uuid default gen_random_uuid() not null,
  shop_id uuid not null,
  status text not null,
  -- Shopify product ids out of stock, and critical, at the check.
  out_product_ids text[] default '{}'::text[] not null,
  critical_product_ids text[] default '{}'::text[] not null,
  -- The ones that made this check send (empty for a baseline).
  new_product_ids text[] default '{}'::text[] not null,
  recipients integer,
  error_summary text,
  created_at timestamp with time zone default now() not null,
  constraint stock_alerts_pkey primary key (id),
  constraint stock_alerts_shop_id_fkey foreign key (shop_id) references public.shops(id) on delete cascade,
  constraint stock_alerts_status_check check (status = any (array['baseline'::text, 'sent'::text, 'failed'::text]))
);

create index if not exists stock_alerts_shop_created_idx on public.stock_alerts (shop_id, created_at desc);

alter table public.stock_alerts enable row level security;
revoke all on public.stock_alerts from anon, authenticated;

comment on table public.stock_alerts is
  'The stock alert''s record: each check that changed the set of out-of-stock / critical products. The latest baseline or sent row is the state "newly" is measured against.';
