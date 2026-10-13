-- 19_product_mix_filters.sql
--
-- The Sales panel's "Who buys this product" card gains a country filter and a
-- VIP-only filter: insights_product_customer_mix() takes p_country, p_vip_only
-- and the shop's VIP rule arguments. Copied byte-for-byte from 06_analytics.sql
-- (19_product_mix_filters.test.mjs asserts it); supersedes 18's copy.
--
-- THE SEVEN-ARGUMENT VERSION FROM 18 IS DROPPED FIRST: `create or replace`
-- cannot add arguments, and leaving both would give PostgREST two overloads to
-- choose between. Both statements are idempotent. No table, no data.

drop function if exists public.insights_product_customer_mix(uuid, timestamp, timestamp, text, text, text[], text[]);

-- -------------------------------------------------- sales: product customers

-- The Sales panel's product card: for ONE product, how the range's customers
-- split around it, and what else its buyers bought.
--
-- PEOPLE, NOT ORDERS. Every figure counts distinct Shopify customers who ordered
-- in the range, so the three buckets partition them: bought only this product,
-- bought it and something else, did not buy it. The caller removes marketplace
-- channels, which mint one customer per order and would make every buyer a
-- single-product customer.
--
-- FREE LINES ARE NOT PURCHASES. A line with a zero discounted total (a sample,
-- a promotional masque) is ignored on both sides: it neither makes a buyer
-- "with something else" nor appears in the ordered-with list, and a free unit
-- of the product itself does not make someone its buyer.
--
-- "ORDERED WITH" IS ACROSS THE RANGE, not within one order: the buckets have to
-- partition people, and a person with two orders cannot be split between them.
-- Top 7 other products by distinct buyers, product id breaking ties so the list
-- is stable between renders.
--
-- THE TWO FILTERS NARROW THE POPULATION, not just the buyers, because they sit
-- in `ranged_orders`: every figure -- the customer total included -- is then
-- about that group, and the three buckets still sum to it.
--   p_country  keeps orders delivered to that country, on the same expression
--              orders_list_facets() and insights_orders_by_country() group on
--              ('??' = no destination). A customer who ordered to two countries
--              is counted in each, on that country's orders only.
--   p_vip_only keeps customers vip_customers() admits under the shop's rule,
--              which looks back over its OWN window, not over this range. No
--              threshold is compared here.
--
-- ONE PRODUCT PER CALL, so the result is at most 7 rows. The first draft
-- returned every product's split at once -- up to 8 rows a product -- which
-- PostgREST's 1,000-row cap would have cut silently (DECISIONS.md § Insights).
create or replace function public.insights_product_customer_mix(
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
  customers bigint,
  only_customers bigint,
  with_other_customers bigint,
  without_customers bigint,
  other_product_id text,
  other_title text,
  other_customers bigint,
  other_rank bigint
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
  paid_lines as (
    select
      ro.customer_key,
      li.value ->> 'product_id' as product_id,
      li.value ->> 'title' as line_title
    from ranged_orders ro
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(ro.line_items) = 'array' then ro.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
  ),
  buyers as (
    select distinct pl.customer_key
    from paid_lines pl
    where pl.product_id = p_product_id
  ),
  buyer_sets as (
    select
      b.customer_key,
      count(distinct pl.product_id) filter (where pl.product_id <> p_product_id) as other_products
    from buyers b
    join paid_lines pl on pl.customer_key = b.customer_key
    group by 1
  ),
  split as (
    select
      (select count(distinct ro.customer_key) from ranged_orders ro) as customers,
      count(*) filter (where bs.other_products = 0) as only_customers,
      count(*) filter (where bs.other_products > 0) as with_other_customers
    from buyer_sets bs
  ),
  others as (
    select
      pl.product_id as other_product_id,
      max(pl.line_title) as line_title,
      count(distinct pl.customer_key) as other_customers
    from buyers b
    join paid_lines pl
      on pl.customer_key = b.customer_key
     and pl.product_id <> p_product_id
    group by 1
  ),
  ranked as (
    select
      ot.other_product_id,
      ot.line_title,
      ot.other_customers,
      row_number() over (order by ot.other_customers desc, ot.other_product_id) as other_rank
    from others ot
  )
  select
    s.customers,
    s.only_customers,
    s.with_other_customers,
    greatest(s.customers - s.only_customers - s.with_other_customers, 0)::bigint as without_customers,
    r.other_product_id,
    coalesce(p.title, r.line_title) as other_title,
    r.other_customers,
    r.other_rank
  from split s
  left join ranked r on r.other_rank <= 7
  left join public.products p
    on p.shop_id = p_shop
   and p.shopify_product_id = r.other_product_id
  order by r.other_rank nulls last;
$$;

revoke all on function public.insights_product_customer_mix from public, anon, authenticated;
grant execute on function public.insights_product_customer_mix to service_role;

comment on function public.insights_product_customer_mix is
  'For one product over a date range: distinct Shopify customers who bought only that paid product, bought it with other paid products, or did not buy it (the three sum to customers), plus the top 7 other paid products its buyers bought, by distinct customer. Optional filters narrow the whole population: delivery country, and VIP only under vip_customers(). Zero-value lines are ignored; the caller excludes marketplace channels.';
