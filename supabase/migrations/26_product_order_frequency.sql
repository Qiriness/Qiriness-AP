-- 26_product_order_frequency.sql
--
-- The Sales panel's "Who buys this product" card gains the Customers panel's
-- orders-per-customer chart, for one product: how many of its buyers bought it
-- once, twice, three times... inside the range.
--
-- One new function, insights_product_orders_per_customer(), copied
-- byte-for-byte from 06_analytics.sql (26_product_order_frequency.test.mjs
-- asserts it). A new name, so nothing is dropped and `create or replace` is
-- idempotent. No table, no data.

-- -------------------------------------- sales: product orders per customer

-- The product card's distribution: among the customers who BOUGHT one product
-- in the range, how many bought it once, twice, three times…
--
-- THE POPULATION IS ITS BUYERS, not the range's customers. The split above
-- partitions everyone who ordered, and "did not order it" is its third bucket;
-- repeating that group here as a zero column would dwarf every other one and
-- say nothing the split has not already said. The columns therefore start at 1.
--
-- ORDERS CARRYING IT, NOT UNITS. Two jars in one order is one order, which is
-- what "orders" means on Customers -> Customers by number of orders, so the two
-- charts can be read side by side.
--
-- FREE LINES ARE NOT PURCHASES, as everywhere else in this card: an order that
-- carried the product only as a zero-value sample is not an order of it.
--
-- THE FILTERS ARE THE CARD'S, applied in `ranged_orders` exactly as the split
-- applies them, so both figures describe the same group of people. The caller
-- removes marketplace channels: one synthetic customer per order would put
-- every marketplace buyer in the "1" column.
--
-- One row per distinct order count, so at most as many rows as the busiest
-- buyer has orders; the caller folds the long tail into one "N or more" column.
create or replace function public.insights_product_orders_per_customer(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_product_id text,
  p_country text default null,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  order_count integer,
  customers bigint
)
language sql
stable
set search_path = public
as $$
  with vip_keys as (
    select c.shopify_customer_id as customer_key
    from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels) v
    join public.customers c
      on c.id = v.customer_id
    where coalesce(p_vip_only, false)
  ),
  ranged_orders as (
    select
      o.id as order_id,
      o.shopify_customer_id as customer_key,
      o.line_items
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
      and (p_country is null or coalesce(o.shipping_destination ->> 'country_code', '??') = p_country)
      and (
        not coalesce(p_vip_only, false)
        or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
      )
  ),
  product_orders as (
    select distinct
      ro.customer_key,
      ro.order_id
    from ranged_orders ro
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(ro.line_items) = 'array' then ro.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' = p_product_id
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
  ),
  per_customer as (
    select po.customer_key, count(*) as n
    from product_orders po
    group by 1
  )
  select pc.n::integer, count(*)
  from per_customer pc
  group by 1
  order by 1;
$$;

revoke all on function public.insights_product_orders_per_customer from public, anon, authenticated;
grant execute on function public.insights_product_orders_per_customer to service_role;

comment on function public.insights_product_orders_per_customer is
  'For one product over a date range: how many distinct Shopify customers placed 1, 2, 3... orders carrying a PAID line of it. One row per order count, buyers only (never-bought is the customer mix''s third bucket). Takes the same country and VIP-only filters as insights_product_customer_mix, so both describe the same group; the caller excludes marketplace channels.';
