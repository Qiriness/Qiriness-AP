-- ============================================================================
-- 95 — ONE DEFINITION OF "THE ORDERS IN THIS RANGE"
--
-- WHY. Ten ranged insights functions each spelled out the same seven
--   conditions on public.orders: this shop, not deleted, not cancelled, placed
--   inside [p_from, p_to) read as wall-clock time in p_tz, on p_channels and not
--   on p_not_channels (a null channel is never excluded). Seven lines repeated
--   ten times is ten places for the rule to drift; now it is written once, in
--   public.orders_in_range(), and each function keeps only its own conditions.
--
-- WHICH. Only functions that read `public.orders o` once AND carried all seven
--   conditions were rewritten, mechanically: the seven removed, the table swapped
--   for the function, nothing else touched. Seven others that differ on purpose
--   are NOT here: orders_summary / orders_series (read order_fulfilment_timing,
--   count cancelled orders), orders_by_channel (no channel filter, cancelled
--   handled per column), fulfilment_buckets / fulfilment_carriers /
--   inventory_exceptions (their own conditions), customer_mix (reads orders
--   twice).
--
-- PROVEN 2026-10-12 against production, inside a rolled-back transaction:
--   · scripts/db-fingerprint.mjs over all 51 analytics functions, 386 calls
--     (3 ranges, grains, channel sets, VIP and country variants): identical
--     before and after. A negative control (the helper without the cancelled
--     condition) changed 45 calls in 8 of the 10 functions, so the check bites.
--   · timing, median of 3, 30 days and all time: 1,244 ms -> 1,248 ms in total.
--     The helper is inlined (SQL, stable, one select, no SET, not definer), so
--     each caller plans as before.
--
-- IDEMPOTENT. Requires: 06, 11 and the files that last defined each function.
-- ============================================================================

-- The live orders of one shop placed inside a wall-clock range in the shop's zone, on the chosen
-- channels, cancelled orders out. The condition the ranged insights functions each spelled out.
-- No SET search_path, no security definer, one SELECT: so Postgres can inline it into the caller
-- and plan it exactly as the condition written in place (an inlined SRF keeps index use).
create or replace function public.orders_in_range(
  p_shop uuid,
  p_from timestamp without time zone,
  p_to timestamp without time zone,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns setof public.orders
language sql
stable
as $$
  select o.*
  from public.orders o
  where o.shop_id = p_shop
    and o.deleted_at is null
    and o.cancelled_at is null
    and o.processed_at >= (p_from at time zone p_tz)
    and o.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or o.sales_channel_handle = any(p_channels))
    and (
      p_not_channels is null
      or o.sales_channel_handle is null
      or not (o.sales_channel_handle = any(p_not_channels))
    )
$$;

comment on function public.orders_in_range(uuid, timestamp without time zone, timestamp without time zone, text, text[], text[]) is
  'The live, uncancelled orders of one shop placed in [p_from, p_to) as wall-clock time in p_tz, on p_channels and not on p_not_channels (a null channel is never excluded). The range condition the insights_* functions share; inlined into each caller.';

revoke all on function public.orders_in_range(uuid, timestamp without time zone, timestamp without time zone, text, text[], text[]) from public, anon, authenticated;
grant execute on function public.orders_in_range(uuid, timestamp without time zone, timestamp without time zone, text, text[], text[]) to service_role;

-- The ten functions, as they are in production with the shared condition swapped
-- in (generated from pg_get_functiondef; CREATE OR REPLACE keeps grants and comments).

CREATE OR REPLACE FUNCTION public.insights_collection_sales(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[], p_limit integer DEFAULT 10, p_handles text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection_id text, title text, handle text, products bigint, orders bigint, units bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ranged_lines as (
    select
      o.id as order_id,
      li.value ->> 'product_id' as product_id,
      coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0) as units,
      (li.value ->> 'discounted_total')::numeric as revenue
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
  ),
  known as (
    select c.shopify_collection_id, c.title, c.handle, c.product_ids
    from public.advice_collections c
    where c.shop_id = p_shop
      and c.deleted_at is null
      and cardinality(c.product_ids) > 0
      and (p_handles is null or c.handle = any(p_handles))
  ),
  per_collection as (
    select
      k.shopify_collection_id as collection_id,
      max(k.title) as title,
      max(k.handle) as handle,
      count(distinct l.product_id) as products,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.units), 0)::bigint as units,
      coalesce(sum(l.revenue), 0) as revenue
    from known k
    join ranged_lines l on l.product_id = any(k.product_ids)
    group by 1
    order by 7 desc, 2
    limit greatest(coalesce(p_limit, 10), 0)
  ),
  uncollected as (
    select
      null::text as collection_id,
      null::text as title,
      null::text as handle,
      count(distinct l.product_id) as products,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.units), 0)::bigint as units,
      coalesce(sum(l.revenue), 0) as revenue
    from ranged_lines l
    where not exists (select 1 from known k where l.product_id = any(k.product_ids))
  )
  select * from per_collection
  union all
  select * from uncollected;
$function$;

CREATE OR REPLACE FUNCTION public.insights_country_product_sales(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_metric text, p_limit integer, p_vip_only boolean DEFAULT false, p_min_spend numeric DEFAULT NULL::numeric, p_min_orders integer DEFAULT NULL::integer, p_window_months integer DEFAULT NULL::integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(country_code text, country_orders bigint, country_revenue numeric, product_id text, title text, orders bigint, units bigint, revenue numeric, rank bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
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
$function$;

CREATE OR REPLACE FUNCTION public.insights_orders_by_country(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(country_code text, orders bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    coalesce(o.shipping_destination ->> 'country_code', '??'),
    count(*),
    coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)), 0)
  from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
  group by 1
  order by 3 desc;
$function$;

CREATE OR REPLACE FUNCTION public.insights_orders_per_customer(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(order_count integer, customers bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select per.n::integer, count(*)
  from (
    select o.shopify_customer_id, count(*) as n
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    where o.shopify_customer_id is not null
    group by 1
  ) per
  group by 1
  order by 1;
$function$;

CREATE OR REPLACE FUNCTION public.insights_product_customer_mix(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_product_id text, p_country text DEFAULT NULL::text, p_vip_only boolean DEFAULT false, p_min_spend numeric DEFAULT NULL::numeric, p_min_orders integer DEFAULT NULL::integer, p_window_months integer DEFAULT NULL::integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(customers bigint, only_customers bigint, with_other_customers bigint, without_customers bigint, other_product_id text, other_title text, other_customers bigint, other_rank bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    where o.shopify_customer_id is not null
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
$function$;

CREATE OR REPLACE FUNCTION public.insights_product_orders_per_customer(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_product_id text, p_country text DEFAULT NULL::text, p_vip_only boolean DEFAULT false, p_min_spend numeric DEFAULT NULL::numeric, p_min_orders integer DEFAULT NULL::integer, p_window_months integer DEFAULT NULL::integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(order_count integer, customers bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    where o.shopify_customer_id is not null
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
$function$;

CREATE OR REPLACE FUNCTION public.insights_product_pairs(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_limit integer, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(country_code text, product_a text, title_a text, product_b text, title_b text, orders bigint, revenue numeric, rank_by_orders bigint, rank_by_revenue bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with per_line as (
    select
      o.id as order_id,
      coalesce(o.shipping_destination ->> 'country_code', '??') as country_code,
      li.value ->> 'product_id' as product_id,
      max(li.value ->> 'title') as line_title,
      sum(coalesce((li.value ->> 'discounted_total')::numeric, 0)) as revenue
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
    group by 1, 2, 3
  ),
  pairs as (
    select
      a.country_code,
      a.product_id as product_a,
      a.line_title as line_title_a,
      b.product_id as product_b,
      b.line_title as line_title_b,
      a.revenue + b.revenue as revenue
    from per_line a
    join per_line b
      on b.order_id = a.order_id
     and a.product_id < b.product_id
  ),
  grouped as (
    select
      p.country_code,
      p.product_a,
      max(p.line_title_a) as line_title_a,
      p.product_b,
      max(p.line_title_b) as line_title_b,
      count(*) as orders,
      sum(p.revenue) as revenue
    from pairs p
    group by grouping sets ((p.product_a, p.product_b), (p.country_code, p.product_a, p.product_b))
  ),
  ranked as (
    select
      g.*,
      row_number() over (
        partition by g.country_code order by g.orders desc, g.revenue desc, g.product_a, g.product_b
      ) as rank_by_orders,
      row_number() over (
        partition by g.country_code order by g.revenue desc, g.orders desc, g.product_a, g.product_b
      ) as rank_by_revenue
    from grouped g
  )
  select
    r.country_code,
    r.product_a,
    coalesce(pa.title, r.line_title_a),
    r.product_b,
    coalesce(pb.title, r.line_title_b),
    r.orders,
    r.revenue,
    r.rank_by_orders,
    r.rank_by_revenue
  from ranked r
  left join public.products pa on pa.shop_id = p_shop and pa.shopify_product_id = r.product_a
  left join public.products pb on pb.shop_id = p_shop and pb.shopify_product_id = r.product_b
  where r.rank_by_orders <= p_limit
     or r.rank_by_revenue <= p_limit
  order by r.country_code nulls first, r.rank_by_orders;
$function$;

CREATE OR REPLACE FUNCTION public.insights_product_sales(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_vip_only boolean DEFAULT false, p_min_spend numeric DEFAULT NULL::numeric, p_min_orders integer DEFAULT NULL::integer, p_window_months integer DEFAULT NULL::integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(product_id text, title text, tags text[], orders bigint, units bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
  from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
  ) as li
  left join public.products p
    on p.shop_id = o.shop_id
   and p.shopify_product_id = li.value ->> 'product_id'
  where li.value ->> 'product_id' is not null
    and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
    and (
      not coalesce(p_vip_only, false)
      or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
    )
  group by 1
  order by 6 desc;
$function$;

CREATE OR REPLACE FUNCTION public.insights_promotions(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[], p_people_not_channels text[] DEFAULT NULL::text[], p_limit integer DEFAULT 12)
 RETURNS TABLE(promotion text, kind text, target text, orders bigint, revenue numeric, discount numeric, new_customer_orders bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ranged as (
    select
      o.id,
      o.shopify_customer_id,
      o.sales_channel_handle,
      o.processed_at,
      coalesce(o.total_price, 0) - coalesce(o.total_refunded, 0) as net,
      o.discount_applications,
      o.line_items
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
  ),
  flagged as (
    select
      r.id,
      r.net,
      r.shopify_customer_id is not null
        and (
          p_people_not_channels is null
          or r.sales_channel_handle is null
          or not (r.sales_channel_handle = any(p_people_not_channels))
        )
        and not exists (
          select 1
          from public.orders e
          where e.shop_id = p_shop
            and e.deleted_at is null
            and e.cancelled_at is null
            and e.shopify_customer_id = r.shopify_customer_id
            and e.processed_at < r.processed_at
        ) as is_new
    from ranged r
  ),
  applied as (
    select r.id, a.value ->> 'name' as promotion, max(a.value ->> 'kind') as kind, max(a.value ->> 'target_type') as target
    from ranged r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.discount_applications) = 'array' then r.discount_applications else '[]'::jsonb end
    ) as a
    where nullif(a.value ->> 'name', '') is not null
    group by 1, 2
  ),
  line_discounts as (
    select r.id, d.value ->> 'name' as promotion, sum(coalesce((d.value ->> 'amount')::numeric, 0)) as amount
    from ranged r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.line_items) = 'array' then r.line_items else '[]'::jsonb end
    ) as li
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(li.value -> 'discounts') = 'array' then li.value -> 'discounts' else '[]'::jsonb end
    ) as d
    group by 1, 2
  ),
  per_promotion as (
    select
      a.promotion,
      max(a.kind) as kind,
      max(a.target) as target,
      count(*) as orders,
      coalesce(sum(f.net), 0) as revenue,
      coalesce(sum(ld.amount), 0) as discount,
      count(*) filter (where f.is_new) as new_customer_orders
    from applied a
    join flagged f on f.id = a.id
    left join line_discounts ld on ld.id = a.id and ld.promotion = a.promotion
    group by a.promotion
    order by 4 desc, 1
    limit greatest(coalesce(p_limit, 12), 0)
  ),
  full_price as (
    select
      null::text as promotion,
      null::text as kind,
      null::text as target,
      count(*) as orders,
      coalesce(sum(f.net), 0) as revenue,
      0::numeric as discount,
      count(*) filter (where f.is_new) as new_customer_orders
    from flagged f
    where not exists (select 1 from applied a where a.id = f.id)
  )
  select * from per_promotion
  union all
  select * from full_price;
$function$;

CREATE OR REPLACE FUNCTION public.insights_sales_overview(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(paid_orders bigint, units bigint, discounts numeric, discounted_orders bigint, discounted_revenue numeric, full_price_revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ranged as (
    select o.id, o.total_price, o.total_refunded, o.total_discounts, o.line_items
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
  ),
  paid_units as (
    select coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)::bigint as units
    from ranged r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.line_items) = 'array' then r.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
  )
  select
    count(*),
    (select pu.units from paid_units pu),
    coalesce(sum(coalesce(r.total_discounts, 0)), 0),
    count(*) filter (where coalesce(r.total_discounts, 0) > 0),
    coalesce(sum(coalesce(r.total_price, 0) - coalesce(r.total_refunded, 0)) filter (where coalesce(r.total_discounts, 0) > 0), 0),
    coalesce(sum(coalesce(r.total_price, 0) - coalesce(r.total_refunded, 0)) filter (where coalesce(r.total_discounts, 0) = 0), 0)
  from ranged r;
$function$;

