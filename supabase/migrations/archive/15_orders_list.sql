-- 15_orders_list.sql
--
-- The Orders page (/orders): orders_list() pages every order with the columns
-- the Shopify admin list shows, and orders_list_facets() gives its filter
-- options with their counts.
--
-- COPIED BYTE-FOR-BYTE FROM 06_analytics.sql, the baseline's copy;
-- 15_orders_list.test.mjs asserts it. Creates no table and writes no data, and
-- every statement replaces, so applying it twice is a no-op.

-- ---------------------------------------------------------------- orders_list

-- The Orders page: every order, newest first, one page at a time, with the
-- columns the Shopify admin's order list shows.
--
-- PAGED HERE, NOT BY THE CALLER. Six thousand orders is past PostgREST's
-- 1,000-row cap, and paging an unordered read overlaps (DECISIONS.md §
-- Insights). The order is total -- processed_at, then id -- and `total_count`
-- is the filtered set counted before the page is cut, so the pager and the rows
-- come from one statement and cannot disagree.
--
-- VIP COMES FROM vip_customers(), as in open_orders(); a null rule admits
-- nobody. The carrier is order_fulfilment_timing's derivation (the lowest
-- tracking company, normalised), so a row here and the carrier table on
-- Fulfilment name the same carrier. The two filter expressions are the ones
-- orders_list_facets() groups on, so a facet selects exactly what it counts.
create or replace function public.orders_list(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_vip_not_channels text[] default null,
  p_fulfillment_status text default null,
  p_country text default null,
  p_vip_only boolean default false,
  p_order_ids uuid[] default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  order_id uuid,
  order_name text,
  order_number integer,
  processed_at timestamptz,
  cancelled_at timestamptz,
  channel text,
  channel_label text,
  financial_status text,
  fulfillment_status text,
  total_price numeric,
  currency_code text,
  units bigint,
  carrier text,
  country_code text,
  country text,
  city text,
  customer_id uuid,
  customer_name text,
  is_vip boolean,
  total_count bigint
)
language sql
stable
set search_path = public
as $$
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
      and (p_fulfillment_status is null or coalesce(o.fulfillment_status, 'UNKNOWN') = p_fulfillment_status)
      and (p_country is null or coalesce(o.shipping_destination ->> 'country_code', '??') = p_country)
      and (not coalesce(p_vip_only, false) or vip.customer_id is not null)
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
    p.total_price,
    p.currency_code,
    (
      select coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)
      from jsonb_array_elements(
        case when jsonb_typeof(p.line_items) = 'array' then p.line_items else '[]'::jsonb end
      ) as li
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
$$;

revoke all on function public.orders_list from public, anon, authenticated;
grant execute on function public.orders_list to service_role;

comment on function public.orders_list is
  'The Orders page: every live order, newest first, one page at a time, with the buyer''s name, VIP under vip_customers(), units, normalised carrier and destination. total_count is the filtered set before the page is cut. Filters: fulfilment status, destination country, VIP only, order ids.';

-- --------------------------------------------------------- orders_list_facets

-- The Orders page's filter options, each with how many orders it selects.
-- Grouped on exactly the expressions orders_list() filters on, so a facet's
-- count is the row count its selection returns. Values come from the data, not
-- a list: Shopify owns the status enum and can add to it.
create or replace function public.orders_list_facets(p_shop uuid)
returns table (
  facet text,
  value text,
  label text,
  orders bigint
)
language sql
stable
set search_path = public
as $$
  select 'fulfillment_status', coalesce(o.fulfillment_status, 'UNKNOWN'), null::text, count(*)
  from public.orders o
  where o.shop_id = p_shop
    and o.deleted_at is null
  group by 2
  union all
  select 'country', coalesce(o.shipping_destination ->> 'country_code', '??'), max(o.shipping_destination ->> 'country'), count(*)
  from public.orders o
  where o.shop_id = p_shop
    and o.deleted_at is null
  group by 2
  order by 1, 4 desc, 2;
$$;

revoke all on function public.orders_list_facets from public, anon, authenticated;
grant execute on function public.orders_list_facets to service_role;

comment on function public.orders_list_facets is
  'Filter options for the Orders page: each fulfilment status and destination country among live orders, with its order count. Grouped on the same expressions orders_list() filters on.';
