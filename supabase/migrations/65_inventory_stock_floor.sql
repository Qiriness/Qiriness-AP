-- ============================================================================
-- 65 — THE STOCK CARD ALSO LISTS EVERY ACTIVE PRODUCT UNDER 30 UNITS
--
-- `insights_inventory_exceptions()` listed a product only when it was out, or
-- had at most 30 days of cover at the last 30 days' rate. A slow seller with a
-- handful of units therefore never showed: on 2026-10-04 three active products
-- held 3, 17 and 19 units and were missing from the card, which listed only
-- the five out of stock.
--
-- So the function takes `p_max_stock_units`: under it a product is listed
-- whatever its rate. HOW MANY UNITS is the caller's judgement and stays in
-- scripts/lib/sales-overview.mjs, like the cover cut-off.
--
-- Drops 35's five-argument version and recreates it with the sixth argument,
-- copied byte-for-byte from 06_analytics.sql (65_inventory_stock_floor.test.mjs
-- asserts it). Supersedes 35's copy of this one function. No table, no data.
-- APPLY BEFORE deploying the web that passes `p_max_stock_units`: the other way
-- round, PostgREST finds no function with that argument and the card fails.
--
-- Requires: 01, 02, 06.
-- ============================================================================

drop function if exists public.insights_inventory_exceptions(uuid, timestamp, timestamp, text, numeric);

-- ----------------------------------------------- fulfilment: stock at risk

-- Active products that are out of stock, will be within p_max_cover_days at
-- the rate they left the warehouse over [p_from, p_to), or hold fewer than
-- p_max_stock_units whatever the rate.
--
-- STOCK IS NOW, THE RATE IS A WINDOW. `products.available_stock` is the sum of
-- the variants' inventory at the last product sync; the rate is every unit that
-- went out in the window, FREE LINES INCLUDED -- a sample leaves the shelf like
-- a sale does. All channels: it is one warehouse. Which window, and where
-- "low" starts, are the caller's judgement.
--
-- Bounded by the catalogue. A product that sold nothing has no cover to
-- compute, so it appears only when it is out of stock or under the unit floor;
-- a slow seller with months of cover still appears under the floor, because a
-- handful of units is one order away from out.
create or replace function public.insights_inventory_exceptions(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_max_cover_days numeric,
  p_max_stock_units integer
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
     or m.available_stock < p_max_stock_units
  order by m.available_stock > 0, m.cover nulls last, m.available_stock, m.units desc, m.title;
$$;

revoke all on function public.insights_inventory_exceptions from public, anon, authenticated;
grant execute on function public.insights_inventory_exceptions to service_role;

comment on function public.insights_inventory_exceptions is
  'Active products out of stock, with at most p_max_cover_days of cover at the rate units (free lines included, all channels) left over [p_from, p_to), or with fewer than p_max_stock_units in stock. Stock is products.available_stock as of the last product sync.';
