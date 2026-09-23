-- 35_sales_overview.sql
--
-- Insights gains an Overview, a Marketing & funnel panel, a stock card on
-- Fulfilment and a monthly sales report. Three read-only functions feed them:
--
--   insights_sales_overview()       units, discounts, discounted vs full-price revenue
--   insights_promotions()           each promotion applied in a range, and full price
--   insights_inventory_exceptions() active products out of stock or running low
--
-- All three copied byte-for-byte from 06_analytics.sql (35_sales_overview.test.mjs
-- asserts it). New names, so nothing is dropped and `create or replace` is
-- idempotent. No table, no data.

-- ---------------------------------------------------- overview: the basket

-- What the Overview and the monthly report need beside insights_orders_summary:
-- units, and how much of the range's revenue carried a promotion.
--
-- DISCOUNTS ARE SHOPIFY'S `total_discounts`, and on this shop that is mostly
-- GIFTS: the automatic promotions give a product away (a 100% line discount)
-- or waive shipping, so the figure is the list value of what was given, not
-- money knocked off a price. The panels label it "Discounts & gifts".
--
-- UNITS ARE PAID UNITS, counted as insights_product_sales counts them: a line
-- with a zero discounted total is a sample or a gift, not a sale.
--
-- Same filters and the same revenue rule as insights_orders_summary (net of
-- refunds, cancelled excluded), so `discounted_revenue + full_price_revenue`
-- is that function's `revenue`.
create or replace function public.insights_sales_overview(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  paid_orders bigint,
  units bigint,
  discounts numeric,
  discounted_orders bigint,
  discounted_revenue numeric,
  full_price_revenue numeric
)
language sql
stable
set search_path = public
as $$
  with ranged as (
    select o.id, o.total_price, o.total_refunded, o.total_discounts, o.line_items
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
$$;

revoke all on function public.insights_sales_overview from public, anon, authenticated;
grant execute on function public.insights_sales_overview to service_role;

comment on function public.insights_sales_overview is
  'One row for a date range: paid (uncancelled) orders, paid units, total_discounts (gifts and free shipping included), and net revenue split between orders that carried a discount and orders that did not. Same filters and revenue rule as insights_orders_summary.';

-- ------------------------------------------------ marketing: promotions

-- Each promotion applied in the range, by the name the order recorded it under
-- (orders.discount_applications), plus one row with a null name for the orders
-- that carried none -- full-price revenue.
--
-- AN ORDER WITH TWO PROMOTIONS IS IN BOTH ROWS, so the rows do not sum to the
-- range. `discount` is what that promotion took off the LINES (each line's
-- `discounts[]` names its promotion); a shipping promotion takes nothing off a
-- line, so its row reads 0 there and the caller shows `target` instead of a
-- misleading zero.
--
-- NEW CUSTOMERS are orders that were the buyer's first uncancelled order in our
-- data, looked for on every channel as insights_customer_mix does. Orders on
-- p_people_not_channels (the marketplaces, which mint a customer per order)
-- are never counted as new.
--
-- The top p_limit promotions by orders; the no-promotion row always comes back.
create or replace function public.insights_promotions(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null,
  p_people_not_channels text[] default null,
  p_limit integer default 12
)
returns table (
  promotion text,
  kind text,
  target text,
  orders bigint,
  revenue numeric,
  discount numeric,
  new_customer_orders bigint
)
language sql
stable
set search_path = public
as $$
  with ranged as (
    select
      o.id,
      o.shopify_customer_id,
      o.sales_channel_handle,
      o.processed_at,
      coalesce(o.total_price, 0) - coalesce(o.total_refunded, 0) as net,
      o.discount_applications,
      o.line_items
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
$$;

revoke all on function public.insights_promotions from public, anon, authenticated;
grant execute on function public.insights_promotions to service_role;

comment on function public.insights_promotions is
  'Per promotion applied in a date range (by the name on orders.discount_applications): orders, their net revenue, what it took off the lines, and orders that were a first purchase. Plus one null-named row for orders with no promotion. An order with two promotions is in both rows.';

-- ----------------------------------------------- fulfilment: stock at risk

-- Active products that are out of stock, or will be within p_max_cover_days at
-- the rate they left the warehouse over [p_from, p_to).
--
-- STOCK IS NOW, THE RATE IS A WINDOW. `products.available_stock` is the sum of
-- the variants' inventory at the last product sync; the rate is every unit that
-- went out in the window, FREE LINES INCLUDED -- a sample leaves the shelf like
-- a sale does. All channels: it is one warehouse. Which window, and where
-- "low" starts, are the caller's judgement.
--
-- Bounded by the catalogue. A product that sold nothing has no cover to
-- compute, so it appears only when it is out of stock.
create or replace function public.insights_inventory_exceptions(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_max_cover_days numeric
)
returns table (
  product_id text,
  title text,
  product_type text,
  stock integer,
  units_out bigint,
  window_days numeric,
  cover_days numeric,
  synced_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with window_span as (
    select greatest(extract(epoch from (p_to - p_from)) / 86400.0, 1)::numeric as days
  ),
  shipped as (
    select
      li.value ->> 'product_id' as product_id,
      sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0))::bigint as units
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.value ->> 'product_id' is not null
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
  order by coalesce(m.cover, 0), m.units desc, m.title;
$$;

revoke all on function public.insights_inventory_exceptions from public, anon, authenticated;
grant execute on function public.insights_inventory_exceptions to service_role;

comment on function public.insights_inventory_exceptions is
  'Active products out of stock, or with at most p_max_cover_days of cover at the rate units (free lines included, all channels) left over [p_from, p_to). Stock is products.available_stock as of the last product sync.';
