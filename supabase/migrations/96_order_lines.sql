-- ============================================================================
-- 96 — ORDER LINES AS A TABLE
--
-- WHY. Eleven analytics functions and chat.order_lines each unnested
--   orders.line_items with the same guarded jsonb_array_elements and read keys
--   out of it. The lines are now rows in public.order_lines, derived from
--   line_items by trigger, and those readers join them.
--
-- EXACTNESS, BY CONSTRUCTION. One row per JSON element, in order (line_index =
--   WITH ORDINALITY), none when line_items is not an array. Scalar columns hold
--   exactly what `line_items ->> key` returned (text), so `(li.value ->>
--   'quantity')::int` became `li.quantity::int`, the same value; and an odd
--   value from Shopify cannot fail an order write on a cast. Typed columns, if
--   wanted, are a separate, fingerprinted step. line_items stays the snapshot.
--
-- KEPT CURRENT. AFTER INSERT on orders, and AFTER UPDATE only when line_items
--   changed (92 already drops no-op nightly updates). Deleting an order deletes
--   its lines (FK cascade).
--
-- THE READERS were rewritten mechanically from pg_get_functiondef: the unnest
--   became `join public.order_lines li on li.order_id = <order id>` (or, in a
--   scalar subquery, `from public.order_lines li where …`), and `li.value ->>
--   'key'` became `li.key`. insights_product_customer_mix's CTE gained the order
--   id it needed for the join. Nothing else changed.
--
-- PROVEN 2026-10-12 on production, inside rolled-back transactions:
--   · scripts/db-fingerprint.mjs, 51 functions / 386 calls: identical.
--     Controls: a backfill missing each order's first line changed 71 calls (9
--     functions); a wrong product_id changed 108 (8, incl. both per-product
--     functions) — every rewritten function moved under at least one.
--   · chat.order_lines: all 19,126 rows identical, same columns and types.
--   · backfill 19,126 lines = 19,126 JSON elements; triggers: unchanged save
--     touches nothing, an edit rewrites, insert adds, delete cascades.
--   · timing, all-time ranges: product_sales 281 -> 179 ms, promotions 226 ->
--     164, sales_overview 112 -> 81; 30-day ranges unchanged.
--
-- IDEMPOTENT (re-running rebuilds order_lines from line_items).
-- Requires: 02_shopify.sql, 17_management_chat.sql, 95_orders_in_range.sql.
-- ============================================================================

create table if not exists public.order_lines (
  order_id uuid not null references public.orders(id) on delete cascade,
  shop_id uuid not null,
  line_index integer not null,
  product_id text,
  variant_id text,
  title text,
  variant_title text,
  sku text,
  quantity text,
  current_quantity text,
  original_total text,
  discounted_total text,
  discounts jsonb,
  primary key (order_id, line_index)
);

create index if not exists order_lines_shop_product_idx on public.order_lines (shop_id, product_id);

alter table public.order_lines enable row level security;

comment on table public.order_lines is
  'One row per element of orders.line_items, derived and kept current by trigger (orders_order_lines_insert / _update); orders.line_items stays the snapshot. Scalar columns hold exactly what line_items ->> key returns (text, cast where read), so a reader gets the same values the JSON gave; discounts is the element''s discounts array.';
comment on column public.order_lines.line_index is
  'The element''s 1-based position in orders.line_items (WITH ORDINALITY).';
comment on column public.order_lines.quantity is
  'Text as in the JSON; cast ::int where read. current_quantity, original_total and discounted_total likewise (::int / ::numeric).';

create or replace function public.order_lines_refresh()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    delete from public.order_lines where order_id = new.id;
  end if;
  insert into public.order_lines (
    order_id, shop_id, line_index, product_id, variant_id, title, variant_title, sku,
    quantity, current_quantity, original_total, discounted_total, discounts
  )
  select
    new.id, new.shop_id, e.ordinality::integer,
    e.value ->> 'product_id', e.value ->> 'variant_id', e.value ->> 'title', e.value ->> 'variant_title', e.value ->> 'sku',
    e.value ->> 'quantity', e.value ->> 'current_quantity', e.value ->> 'original_total', e.value ->> 'discounted_total',
    e.value -> 'discounts'
  from jsonb_array_elements(
    case when jsonb_typeof(new.line_items) = 'array' then new.line_items else '[]'::jsonb end
  ) with ordinality as e(value, ordinality);
  return null;
end;
$$;

comment on function public.order_lines_refresh() is
  'AFTER trigger on orders: rewrites the order''s rows in order_lines from line_items. On update it fires only when line_items changed.';

revoke all on function public.order_lines_refresh() from public, anon, authenticated;

drop trigger if exists orders_order_lines_insert on public.orders;
create trigger orders_order_lines_insert
after insert on public.orders
for each row
execute function public.order_lines_refresh();

drop trigger if exists orders_order_lines_update on public.orders;
create trigger orders_order_lines_update
after update of line_items on public.orders
for each row
when (old.line_items is distinct from new.line_items)
execute function public.order_lines_refresh();

-- Backfill: every existing order. Re-running rebuilds the table from line_items.
delete from public.order_lines;
insert into public.order_lines (
  order_id, shop_id, line_index, product_id, variant_id, title, variant_title, sku,
  quantity, current_quantity, original_total, discounted_total, discounts
)
select
  o.id, o.shop_id, e.ordinality::integer,
  e.value ->> 'product_id', e.value ->> 'variant_id', e.value ->> 'title', e.value ->> 'variant_title', e.value ->> 'sku',
  e.value ->> 'quantity', e.value ->> 'current_quantity', e.value ->> 'original_total', e.value ->> 'discounted_total',
  e.value -> 'discounts'
from public.orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
) with ordinality as e(value, ordinality);

-- The eleven readers, as in production with the unnest swapped for the table.

CREATE OR REPLACE FUNCTION public.insights_collection_sales(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[], p_limit integer DEFAULT 10, p_handles text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection_id text, title text, handle text, products bigint, orders bigint, units bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ranged_lines as (
    select
      o.id as order_id,
      li.product_id as product_id,
      coalesce((li.current_quantity)::int, (li.quantity)::int, 0) as units,
      (li.discounted_total)::numeric as revenue
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    join public.order_lines li on li.order_id = o.id
    where li.product_id is not null
      and coalesce((li.discounted_total)::numeric, 0) > 0
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
      li.product_id as product_id,
      li.title as line_title,
      coalesce((li.current_quantity)::int, (li.quantity)::int, 0) as units,
      coalesce((li.discounted_total)::numeric, 0) as line_revenue
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    join public.order_lines li on li.order_id = o.id
    where li.product_id is not null
      and coalesce((li.discounted_total)::numeric, 0) > 0
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

CREATE OR REPLACE FUNCTION public.insights_inventory_exceptions(p_shop uuid, p_from timestamp without time zone, p_to timestamp without time zone, p_tz text, p_max_cover_days numeric, p_max_stock_units integer)
 RETURNS TABLE(product_id text, title text, product_type text, stock integer, units_out bigint, window_days numeric, cover_days numeric, synced_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with window_span as (
    select greatest(extract(epoch from (p_to - p_from)) / 86400.0, 1)::numeric as days
  ),
  shipped as (
    select
      li.product_id as product_id,
      sum(coalesce((li.current_quantity)::int, (li.quantity)::int, 0))::bigint as units
    from public.orders o
    join public.order_lines li on li.order_id = o.id
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.product_id is not null
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
    group by 1
  ),
  measured as (
    select
      p.shopify_product_id,
      p.title,
      p.product_type,
      p.available_stock,
      coalesce(s.units, 0) as units,
      w.days,
      case
        when coalesce(s.units, 0) > 0 then round(greatest(p.available_stock, 0) * w.days / s.units, 1)
      end as cover,
      p.synced_at
    from public.products p
    cross join window_span w
    left join shipped s on s.product_id = p.shopify_product_id
    where p.shop_id = p_shop
      and p.deleted_at is null
      and p.status = 'active'
      and p.available_stock is not null
  )
  select m.shopify_product_id, m.title, m.product_type, m.available_stock, m.units, round(m.days, 1), m.cover, m.synced_at
  from measured m
  where m.available_stock <= 0
     or (m.cover is not null and m.cover <= p_max_cover_days)
     or m.available_stock < p_max_stock_units
  order by m.available_stock > 0, m.cover nulls last, m.available_stock, m.units desc, m.title;
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
  paid_lines as (
    select
      ro.customer_key,
      li.product_id as product_id,
      li.title as line_title
    from ranged_orders ro
    join public.order_lines li on li.order_id = ro.order_id
    where li.product_id is not null
      and coalesce((li.discounted_total)::numeric, 0) > 0
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
    join public.order_lines li on li.order_id = ro.order_id
    where li.product_id = p_product_id
      and coalesce((li.discounted_total)::numeric, 0) > 0
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
      li.product_id as product_id,
      max(li.title) as line_title,
      sum(coalesce((li.discounted_total)::numeric, 0)) as revenue
    from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
    join public.order_lines li on li.order_id = o.id
    where li.product_id is not null
      and coalesce((li.discounted_total)::numeric, 0) > 0
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
    li.product_id,
    coalesce(max(p.title), max(li.title)),
    max(p.tags),
    count(distinct o.id),
    coalesce(sum(coalesce((li.current_quantity)::int, (li.quantity)::int, 0)), 0)::bigint,
    coalesce(sum((li.discounted_total)::numeric), 0)
  from public.orders_in_range(p_shop, p_from, p_to, p_tz, p_channels, p_not_channels) o
  join public.order_lines li on li.order_id = o.id
  left join public.products p
    on p.shop_id = o.shop_id
   and p.shopify_product_id = li.product_id
  where li.product_id is not null
    and coalesce((li.discounted_total)::numeric, 0) > 0
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
    join public.order_lines li on li.order_id = r.id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(li.discounts) = 'array' then li.discounts else '[]'::jsonb end
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
    select coalesce(sum(coalesce((li.current_quantity)::int, (li.quantity)::int, 0)), 0)::bigint as units
    from ranged r
    join public.order_lines li on li.order_id = r.id
    where li.product_id is not null
      and coalesce((li.discounted_total)::numeric, 0) > 0
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

CREATE OR REPLACE FUNCTION public.open_orders(p_shop uuid, p_min_spend numeric, p_min_orders integer, p_window_months integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[], p_not_channels text[] DEFAULT NULL::text[])
 RETURNS TABLE(order_id uuid, order_name text, legacy_resource_id text, processed_at timestamp with time zone, channel text, channel_label text, fulfillment_status text, total_price numeric, units bigint, customer_id uuid, customer_name text, customer_email text, is_vip boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
      select coalesce(sum(coalesce((li.current_quantity)::int, (li.quantity)::int, 0)), 0)
      from public.order_lines li where li.order_id = o.id
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
$function$;

CREATE OR REPLACE FUNCTION public.orders_list(p_shop uuid, p_min_spend numeric, p_min_orders integer, p_window_months integer, p_vip_not_channels text[] DEFAULT NULL::text[], p_fulfillment_status text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_vip_only boolean DEFAULT false, p_search text DEFAULT NULL::text, p_order_ids uuid[] DEFAULT NULL::uuid[], p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(order_id uuid, order_name text, order_number integer, processed_at timestamp with time zone, cancelled_at timestamp with time zone, channel text, channel_label text, financial_status text, fulfillment_status text, awaiting_fulfilment boolean, total_price numeric, currency_code text, units bigint, carrier text, country_code text, country text, city text, customer_id uuid, customer_name text, is_vip boolean, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with vip as (
    select v.customer_id
    from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels) v
  ),
  page as (
    select
      o.id,
      o.name,
      o.order_number,
      o.processed_at,
      o.cancelled_at,
      o.sales_channel_handle,
      o.sales_channel,
      o.financial_status,
      o.fulfillment_status,
      (
        o.cancelled_at is null
        and o.closed_at is null
        and o.fulfillment_status is not null
        and o.fulfillment_status not in ('FULFILLED', 'RESTOCKED')
      ) as awaiting,
      o.total_price,
      o.currency_code,
      o.line_items,
      o.fulfillments,
      o.shipping_destination,
      c.id as buyer_id,
      coalesce(c.display_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as buyer_name,
      vip.customer_id is not null as buyer_is_vip,
      count(*) over () as matched
    from public.orders o
    left join public.customers c
      on c.shop_id = o.shop_id
     and c.shopify_customer_id = o.shopify_customer_id
     and c.deleted_at is null
    left join vip on vip.customer_id = c.id
    where o.shop_id = p_shop
      and o.deleted_at is null
      and (
        p_fulfillment_status is null
        or public.order_fulfilment_display(o.fulfillment_status, o.line_items, o.cancelled_at, o.financial_status) = p_fulfillment_status
      )
      and (p_country is null or coalesce(o.shipping_destination ->> 'country_code', '??') = p_country)
      and (not coalesce(p_vip_only, false) or vip.customer_id is not null)
      and (
        p_search is null
        or o.name ilike ('%' || p_search || '%')
        or coalesce(c.display_name, concat_ws(' ', c.first_name, c.last_name)) ilike ('%' || p_search || '%')
        or c.email ilike ('%' || p_search || '%')
        or upper(regexp_replace(p_search, '[[:space:].-]', '', 'g')) = any(o.tracking_numbers)
      )
      and (p_order_ids is null or o.id = any(p_order_ids))
    order by o.processed_at desc nulls last, o.id desc
    limit greatest(coalesce(p_limit, 50), 0)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    p.id,
    p.name,
    p.order_number,
    p.processed_at,
    p.cancelled_at,
    p.sales_channel_handle,
    p.sales_channel,
    p.financial_status,
    p.fulfillment_status,
    p.awaiting,
    p.total_price,
    p.currency_code,
    (
      select coalesce(sum(coalesce((li.current_quantity)::int, (li.quantity)::int, 0)), 0)
      from public.order_lines li where li.order_id = p.id
    )::bigint,
    (
      select public.normalise_carrier(min(t.value ->> 'company'))
      from jsonb_array_elements(
        case when jsonb_typeof(p.fulfillments) = 'array' then p.fulfillments else '[]'::jsonb end
      ) as e
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(e.value -> 'tracking_info') = 'array'
          then e.value -> 'tracking_info'
          else '[]'::jsonb
        end
      ) as t
    ),
    nullif(p.shipping_destination ->> 'country_code', ''),
    nullif(p.shipping_destination ->> 'country', ''),
    nullif(p.shipping_destination ->> 'city', ''),
    p.buyer_id,
    p.buyer_name,
    p.buyer_is_vip,
    p.matched
  from page p
  order by p.processed_at desc nulls last, p.id desc;
$function$;

-- chat.order_lines reads the derived table: same columns, same types, same rows.
create or replace view chat.order_lines as
  select
    o.id as order_id,
    l.line_index as line_index,
    o.processed_at as processed_at,
    o.sales_channel_handle as channel,
    o.cancelled_at as cancelled_at,
    l.title as product_title,
    l.variant_title as variant_title,
    l.sku as sku,
    l.product_id as shopify_product_id,
    l.quantity::integer as quantity,
    l.current_quantity::integer as current_quantity,
    l.original_total::numeric as original_total,
    l.discounted_total::numeric as discounted_total
  from public.orders o
  join public.order_lines l on l.order_id = o.id
  where o.deleted_at is null;
