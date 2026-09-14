-- 20_best_products_vip.sql
--
-- The Sales panel's Best products card gains a VIP-only filter:
-- insights_product_sales() and insights_country_product_sales() take p_vip_only
-- and the shop's VIP rule arguments. Copied byte-for-byte from 06_analytics.sql
-- (20_best_products_vip.test.mjs asserts it); supersedes 11's copies.
--
-- THE OLD SIGNATURES ARE DROPPED FIRST: `create or replace` cannot add arguments,
-- and leaving both would give PostgREST two overloads to choose between. Every
-- statement is idempotent. Creates no table, writes no data.

drop function if exists public.insights_product_sales(uuid, timestamp, timestamp, text, text[], text[]);
drop function if exists public.insights_country_product_sales(uuid, timestamp, timestamp, text, text, integer, text[], text[]);

-- --------------------------------------------------------- sales: products

-- What sold, per product, for a range: distinct orders, units and net line
-- revenue, with the product's tags so the caller can fold products into the
-- groups it needs (gender is read off the catalogue tags in TypeScript -- a
-- judgement, so not here).
--
-- FREE LINES ARE NOT SALES. A line whose discounted total is zero is a sample or
-- a gift, and on this catalogue samples ride along on most orders: counted, they
-- would top every "best product by orders" list without a cent changing hands.
--
-- VIP ONLY. p_vip_only keeps orders from customers vip_customers() admits under
-- the shop's rule -- whose window is its own, not this range -- with the rule
-- passed by the caller; no threshold is compared here. Off by default, so every
-- caller that does not ask is unchanged.
create or replace function public.insights_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  product_id text,
  title text,
  tags text[],
  orders bigint,
  units bigint,
  revenue numeric
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
  )
  select
    li.value ->> 'product_id',
    coalesce(max(p.title), max(li.value ->> 'title')),
    max(p.tags),
    count(distinct o.id),
    coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)::bigint,
    coalesce(sum((li.value ->> 'discounted_total')::numeric), 0)
  from public.orders o
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
  ) as li
  left join public.products p
    on p.shop_id = o.shop_id
   and p.shopify_product_id = li.value ->> 'product_id'
  where o.shop_id = p_shop
    and o.deleted_at is null
    and o.cancelled_at is null
    and li.value ->> 'product_id' is not null
    and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
    and o.processed_at >= (p_from at time zone p_tz)
    and o.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or o.sales_channel_handle = any(p_channels))
    and (
      p_not_channels is null
      or o.sales_channel_handle is null
      or not (o.sales_channel_handle = any(p_not_channels))
    )
    and (
      not coalesce(p_vip_only, false)
      or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
    )
  group by 1
  order by 6 desc;
$$;

revoke all on function public.insights_product_sales from public, anon, authenticated;
grant execute on function public.insights_product_sales to service_role;

comment on function public.insights_product_sales is
  'Per product for a date range: distinct orders, units and net line revenue, with catalogue tags. Zero-value lines (samples, gifts) are excluded. One row per product, so bounded by the catalogue. p_vip_only limits it to customers vip_customers() admits.';

-- ------------------------------------------------ sales: products by country

-- The same measure per destination country, top p_limit products per country by
-- p_metric ('revenue' or 'orders'). Ranked here because country x product is
-- thousands of rows before the cut, which is exactly the shape readView refuses.
--
-- VIP ONLY as in insights_product_sales: vip_customers() decides, the caller
-- passes the rule, and it is off by default.
create or replace function public.insights_country_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_metric text,
  p_limit integer,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  country_code text,
  country_orders bigint,
  country_revenue numeric,
  product_id text,
  title text,
  orders bigint,
  units bigint,
  revenue numeric,
  rank bigint
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
  lines as (
    select
      coalesce(o.shipping_destination ->> 'country_code', '??') as country_code,
      o.id as order_id,
      o.total_price - coalesce(o.total_refunded, 0) as order_revenue,
      li.value ->> 'product_id' as product_id,
      li.value ->> 'title' as line_title,
      coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0) as units,
      coalesce((li.value ->> 'discounted_total')::numeric, 0) as line_revenue
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
      and (
        not coalesce(p_vip_only, false)
        or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
      )
  ),
  countries as (
    select
      c.country_code,
      count(distinct c.order_id) as country_orders,
      sum(c.order_revenue) as country_revenue
    from (select distinct l.country_code, l.order_id, l.order_revenue from lines l) c
    group by 1
  ),
  per_product as (
    select
      l.country_code,
      l.product_id,
      max(l.line_title) as line_title,
      count(distinct l.order_id) as orders,
      sum(l.units)::bigint as units,
      sum(l.line_revenue) as revenue
    from lines l
    group by 1, 2
  ),
  ranked as (
    select
      pp.*,
      row_number() over (
        partition by pp.country_code
        order by case when p_metric = 'orders' then pp.orders::numeric else pp.revenue end desc, pp.product_id
      ) as rank
    from per_product pp
  )
  select
    r.country_code,
    c.country_orders,
    c.country_revenue,
    r.product_id,
    coalesce(p.title, r.line_title),
    r.orders,
    r.units,
    r.revenue,
    r.rank
  from ranked r
  join countries c on c.country_code = r.country_code
  left join public.products p
    on p.shop_id = p_shop
   and p.shopify_product_id = r.product_id
  where r.rank <= p_limit
  order by c.country_revenue desc, r.country_code, r.rank;
$$;

revoke all on function public.insights_country_product_sales from public, anon, authenticated;
grant execute on function public.insights_country_product_sales to service_role;

comment on function public.insights_country_product_sales is
  'Top p_limit products per destination country for a date range, ranked by revenue or orders, with each country''s own order count and net revenue. Zero-value lines excluded, as in insights_product_sales, and so is p_vip_only.';
