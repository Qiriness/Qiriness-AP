-- 21_chat_vip.sql
--
-- VIP STATUS FOR THE MANAGEMENT CHAT.
--
-- INCREMENTAL and idempotent, on top of 17.
--
-- WHY A FUNCTION AND NOT A VIEW OVER THE TABLES. The VIP rule is written once,
-- in public.vip_customers() (06 / 12), and copying its SQL into a chat view is
-- how two definitions of "VIP" would start to disagree. But a view cannot simply
-- call it: a view checks TABLES as its owner and FUNCTION CALLS as the querying
-- role, and vip_customers() is an ordinary function reading `orders` and
-- `customers`, which mgmt_chat_ro cannot read (DECISIONS.md § Management chat).
--
-- So chat.vip_customer_rows() is SECURITY DEFINER — it runs as its owner — and
-- is safe to be for three reasons the test asserts:
--   - it takes NO arguments: the chat cannot steer it, only call it;
--   - its search_path is fixed, so no object the caller creates can shadow the
--     ones it names (and mgmt_chat_ro cannot create objects anyway);
--   - it returns ids and two numbers, no personal data.
--
-- It passes vip_customers() exactly what scripts/lib/vip-rule.mjs#vipArgs does:
-- the shop's three thresholds and the marketplace channels excluded. The handles
-- are a literal here because SQL cannot import insights-range.mjs; the test
-- compares them with ALL_MARKETPLACE_HANDLES so the two cannot drift.

create or replace function chat.vip_customer_rows()
returns table (
  customer_id uuid,
  orders_in_window bigint,
  net_spend_in_window numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.customer_id, v.orders, v.spend
  from public.shops s
  cross join lateral public.vip_customers(
    s.id,
    s.vip_min_spend,
    s.vip_min_orders,
    s.vip_window_months,
    array['amazon', 'connect-dev-1']
  ) v
  where s.vip_min_spend is not null
    and s.vip_min_orders is not null
    and s.vip_window_months is not null;
$$;

revoke all on function chat.vip_customer_rows() from public, anon, authenticated;
grant execute on function chat.vip_customer_rows() to mgmt_chat_ro;

comment on function chat.vip_customer_rows() is
  'The shop''s VIP customers, through public.vip_customers() with the shop''s own thresholds and marketplaces excluded. Security definer, no arguments. Read it through chat.vip_customers.';

create or replace view chat.vip_customers as
  select
    v.customer_id as customer_id,
    v.orders_in_window as orders_in_window,
    v.net_spend_in_window as net_spend_in_window
  from chat.vip_customer_rows() v;

revoke all on chat.vip_customers from public, anon, authenticated;
grant select on chat.vip_customers to mgmt_chat_ro;

comment on view chat.vip_customers is
  'One row per customer who is a VIP RIGHT NOW under the shop''s VIP rule (see chat.shop: net spend strictly above vip_min_spend AND strictly more than vip_min_orders orders, both inside the last vip_window_months; uncancelled orders; Amazon and Yves Rocher orders do not count). Empty when no rule is set. Join chat.customers on customer_id for country, lifetime spend or RFM group, and chat.orders / chat.tickets on customer_id. Current status only: who was a VIP in the past cannot be reconstructed.';
comment on column chat.vip_customers.orders_in_window is
  'Uncancelled, non-marketplace orders inside the rule''s window.';
comment on column chat.vip_customers.net_spend_in_window is
  'Sum of total_price minus refunds on those orders (EUR).';

comment on view chat.shop is
  'One row: the shop. iana_timezone is where a day starts for reporting. The VIP rule is net spend above vip_min_spend AND more than vip_min_orders orders inside the last vip_window_months (all null = no VIP rule set). The customers it admits are listed in chat.vip_customers.';
