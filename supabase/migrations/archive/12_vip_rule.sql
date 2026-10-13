-- ============================================================================
-- 12 — THE VIP RULE BECOMES A SETTING
--
-- WHAT THIS CHANGES. VIP stops meaning "Shopify's RFM group is CHAMPIONS or
-- LOYAL" and becomes a rule the shop sets on the Customers panel: net spend
-- above an amount AND more than a number of orders, both inside a window of
-- months. Three columns on `shops`, and three functions that apply them —
-- plus open_orders(), the Fulfilment list of orders waiting to ship, which
-- marks each buyer VIP or not through the same function.
--
-- THE FUNCTIONS ARE COPIED FROM 06_analytics.sql, NOT RETYPED, and
-- 12_vip_rule.test.mjs holds them byte-identical, as 11 does for its own.
--
-- NO RULE IS SET HERE. The columns arrive null, which means nobody is a VIP
-- until someone chooses the numbers; a default written into a migration would
-- be a business decision nobody made.
--
-- IDEMPOTENT: `add column if not exists`, the constraint dropped and re-added,
-- `create or replace function` — a no-op on a fresh baseline.
--
-- Requires: 01_foundation.sql, 02_shopify.sql, 04_support.sql, 06_analytics.sql.
-- ============================================================================

alter table public.shops
  add column if not exists vip_min_spend numeric(12, 2),
  add column if not exists vip_min_orders integer,
  add column if not exists vip_window_months integer,
  add column if not exists vip_rule_changed_at timestamptz;

alter table public.shops drop constraint if exists shops_vip_rule_check;

alter table public.shops
  add constraint shops_vip_rule_check check (
    (vip_min_spend is null and vip_min_orders is null and vip_window_months is null)
    or (vip_min_spend >= 0 and vip_min_orders >= 0 and vip_window_months between 1 and 120)
  );

comment on column public.shops.vip_min_spend is
  'VIP rule, set on the Customers panel: net spend inside the window must be MORE THAN this (EUR), AND orders more than vip_min_orders. Null with the other two = no rule, nobody is VIP.';

-- ============================================================================
-- THE VIP RULE
-- ============================================================================
--
-- Who counts as a VIP is set by the shop, on the Customers panel: three
-- numbers on `shops` (vip_min_spend, vip_min_orders, vip_window_months), read
-- by scripts/lib/vip-rule.mjs and passed in here. The rule itself — how those
-- three combine — is written ONCE, in vip_customers() below, and every reader
-- (the ticket queue, the Customers panel, the agent's customer lookup) calls it.
--
-- BOTH CONDITIONS, NOT EITHER. A customer is a VIP when, inside the window,
-- their net spend is MORE THAN the minimum AND their order count is MORE THAN
-- the minimum. Strictly greater on both, because that is how the rule is stated
-- on the screen ("more than").
--
-- NET SPEND, UNCANCELLED ORDERS, NO MARKETPLACES. Spend is total_price minus
-- total_refunded, the same net revenue the Sales panel reports. Marketplace
-- channels (p_not_channels) are excluded because they mint one customer per
-- order: no marketplace buyer can ever repeat, and a real customer's Amazon
-- orders never reach their record anyway.
--
-- COMPUTED ON EVERY READ, NEVER STORED. The window rolls forward daily, so a
-- stored flag would be stale by tomorrow; and the rule changes whenever the
-- shop edits it. This replaces the RFM rule (CHAMPIONS + LOYAL) — see
-- DECISIONS.md § Tickets dashboard.

create or replace function public.vip_customers(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_customer_ids uuid[] default null
)
returns table (
  customer_id uuid,
  orders bigint,
  spend numeric
)
language sql
stable
set search_path = public
as $$
  with windowed as (
    select
      o.shopify_customer_id,
      count(*) as orders,
      coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)), 0) as spend
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id is not null
      and o.processed_at >= now() - make_interval(months => p_window_months)
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
    group by 1
  )
  select c.id, w.orders, w.spend
  from windowed w
  join public.customers c
    on c.shop_id = p_shop
   and c.shopify_customer_id = w.shopify_customer_id
   and c.deleted_at is null
  where w.spend > p_min_spend
    and w.orders > p_min_orders
    and (p_customer_ids is null or c.id = any(p_customer_ids));
$$;

revoke all on function public.vip_customers from public, anon, authenticated;
grant execute on function public.vip_customers to service_role;

comment on function public.vip_customers is
  'THE VIP RULE: customers whose net spend AND order count inside the last p_window_months are both strictly greater than the minimums, uncancelled orders only, marketplace channels excluded. With their windowed orders and spend. Pass p_customer_ids to ask about specific customers.';

-- Which tickets belong to a VIP — the queue asks this once for the whole list,
-- because `ticket_queue` carries no customer id and the rule should not have to
-- be restated to ask it.
create or replace function public.vip_tickets(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_ticket_ids uuid[] default null
)
returns table (
  ticket_id uuid,
  customer_id uuid
)
language sql
stable
set search_path = public
as $$
  select t.id, t.customer_id
  from public.tickets t
  join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
    on v.customer_id = t.customer_id
  where t.shop_id = p_shop
    and t.deleted_at is null
    and (p_ticket_ids is null or t.id = any(p_ticket_ids));
$$;

revoke all on function public.vip_tickets from public, anon, authenticated;
grant execute on function public.vip_tickets to service_role;

comment on function public.vip_tickets is
  'Live tickets whose linked customer is a VIP under vip_customers(). One call marks a whole queue.';

-- How many customers the rule admits, beside how many ordered at all in the
-- same window — the denominator a VIP share is quoted against.
create or replace function public.vip_summary(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null
)
returns table (
  vip_customers bigint,
  buyers_in_window bigint
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*) from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels)),
    (
      select count(distinct o.shopify_customer_id)
      from public.orders o
      where o.shop_id = p_shop
        and o.deleted_at is null
        and o.cancelled_at is null
        and o.shopify_customer_id is not null
        and o.processed_at >= now() - make_interval(months => p_window_months)
        and (
          p_not_channels is null
          or o.sales_channel_handle is null
          or not (o.sales_channel_handle = any(p_not_channels))
        )
    );
$$;

revoke all on function public.vip_summary from public, anon, authenticated;
grant execute on function public.vip_summary to service_role;

comment on function public.vip_summary is
  'How many customers vip_customers() admits, and how many ordered at all in the same window.';

-- Orders still waiting to ship, oldest first, each marked VIP or not under the
-- shop's rule — the Fulfilment panel's list.
--
-- WAITING TO SHIP means Shopify has not called it FULFILLED (or RESTOCKED), and
-- the order is neither cancelled nor closed. Closed matters: six orders read
-- UNFULFILLED forever because they were refunded instead of shipped, and they
-- are not waiting for anything (measured 2026-09-11).
--
-- VIP COMES FROM vip_customers(), never restated here. With the thresholds null
-- (no rule set) it admits nobody and every row reads is_vip = false.
--
-- NOT RANGED. An order placed two months ago and still unshipped is the one
-- that matters most; the list is "now", as of the last order sync.
create or replace function public.open_orders(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  order_id uuid,
  order_name text,
  legacy_resource_id text,
  processed_at timestamptz,
  channel text,
  channel_label text,
  fulfillment_status text,
  total_price numeric,
  units bigint,
  customer_id uuid,
  customer_name text,
  customer_email text,
  is_vip boolean
)
language sql
stable
set search_path = public
as $$
  select
    o.id,
    o.name,
    o.legacy_resource_id,
    o.processed_at,
    o.sales_channel_handle,
    o.sales_channel,
    o.fulfillment_status,
    o.total_price,
    (
      select coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)
      from jsonb_array_elements(
        case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
      ) as li
    )::bigint,
    c.id,
    coalesce(c.display_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')),
    c.email,
    v.customer_id is not null
  from public.orders o
  left join public.customers c
    on c.shop_id = o.shop_id
   and c.shopify_customer_id = o.shopify_customer_id
   and c.deleted_at is null
  left join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels) v
    on v.customer_id = c.id
  where o.shop_id = p_shop
    and o.deleted_at is null
    and o.cancelled_at is null
    and o.closed_at is null
    and o.fulfillment_status is not null
    and o.fulfillment_status not in ('FULFILLED', 'RESTOCKED')
    and (p_channels is null or o.sales_channel_handle = any(p_channels))
    and (
      p_not_channels is null
      or o.sales_channel_handle is null
      or not (o.sales_channel_handle = any(p_not_channels))
    )
  order by o.processed_at asc;
$$;

revoke all on function public.open_orders from public, anon, authenticated;
grant execute on function public.open_orders to service_role;

comment on function public.open_orders is
  'Orders not yet fulfilled (not cancelled, not closed), oldest first, with the buyer''s name and email and whether they are a VIP under vip_customers(). Current state as of the last order sync, not ranged.';
