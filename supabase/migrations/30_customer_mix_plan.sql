-- 30_customer_mix_plan.sql
--
-- insights_customer_mix() returns the same four numbers, about ten times
-- faster on long ranges. Nothing else changes: same name, same arguments, same
-- columns, same grants, so every caller is untouched.
--
-- WHY. A SQL function's body is planned without its argument values. The first
-- shape -- the range's orders as a CTE, joined back to every customer's first
-- order -- was then planned as a nested loop across both: 10,122,837 row
-- comparisons on a one-year range. Measured 2026-09-18 on the live shop:
-- 961 ms for one year and 1,589 ms for all time, against 80 ms for the very
-- same query run with its values known. It was the slowest read on the Sales
-- panel, and the reason a wider range took seconds longer to load.
--
-- THE FIX groups the range by customer first and then looks up each customer's
-- first order through orders_shopify_customer_id_idx, so no plan is left that
-- could compare every row with every row. Same query, forced onto a generic
-- plan: 68 / 102 / 118 ms for six months / one year / all time.
--
-- CHECKED BEFORE SHIPPING: the old function against the new body over every
-- range preset (current and previous window) and every platform filter, 60
-- combinations, 0 differences.
--
-- Copied byte-for-byte from 06_analytics.sql (30_customer_mix_plan.test.mjs
-- asserts it). `create or replace` on an unchanged signature: idempotent,
-- nothing dropped, no table, no data.

create or replace function public.insights_customer_mix(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  new_customers bigint,
  returning_customers bigint,
  new_customer_orders bigint,
  returning_customer_orders bigint
)
language sql
stable
set search_path = public
as $$
  with ranged as (
    select o.shopify_customer_id as customer, count(*) as orders
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id is not null
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
    group by 1
  ),
  classified as (
    -- The first order is looked for on every channel, as before: "returning"
    -- means any earlier order of ours, whatever the filter shows.
    select
      r.orders,
      (
        select min(o.processed_at)
        from public.orders o
        where o.shop_id = p_shop
          and o.deleted_at is null
          and o.cancelled_at is null
          and o.shopify_customer_id = r.customer
      ) >= (p_from at time zone p_tz) as is_new
    from ranged r
  )
  select
    count(*) filter (where c.is_new),
    count(*) filter (where not c.is_new),
    coalesce(sum(c.orders) filter (where c.is_new), 0)::bigint,
    coalesce(sum(c.orders) filter (where not c.is_new), 0)::bigint
  from classified c;
$$;

revoke all on function public.insights_customer_mix from public, anon, authenticated;
grant execute on function public.insights_customer_mix to service_role;

comment on function public.insights_customer_mix is
  'Customers who ordered in a range, split by whether their earliest synced order is inside it (new) or before it (returning), with their order counts. Never call it over marketplace channels: those mint one customer per order.';
