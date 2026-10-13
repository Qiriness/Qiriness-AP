-- 16_orders_search.sql
--
-- The Orders page gains a search box and a Delay column: orders_list() takes
-- p_search and returns awaiting_fulfilment. Copied byte-for-byte from
-- 06_analytics.sql (16_orders_search.test.mjs asserts it); supersedes 15's
-- copy of that one function. orders_list_facets() is unchanged and stays in 15.
--
-- THE OLD SIGNATURE IS DROPPED FIRST. `create or replace` cannot add an
-- argument or a return column, and adding the argument without the drop would
-- leave two overloads that PostgREST cannot choose between. Both statements are
-- idempotent, so applying this twice is a no-op. Creates no table, writes no data.

drop function if exists public.orders_list(uuid, numeric, integer, integer, text[], text, text, boolean, uuid[], integer, integer);

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
--
-- `awaiting` is open_orders()'s rule, condition for condition -- not
-- fulfilled or restocked, not cancelled, NOT CLOSED (a refunded order can read
-- UNFULFILLED for ever) -- so the Delay column and the waiting-orders list on
-- Fulfilment count the same orders. The caller turns it into days.
--
-- `p_search` matches the order name, the buyer's name or email, or a tracking
-- number compared in its stored normalised form. The caller strips LIKE
-- wildcards before it arrives.
create or replace function public.orders_list(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_vip_not_channels text[] default null,
  p_fulfillment_status text default null,
  p_country text default null,
  p_vip_only boolean default false,
  p_search text default null,
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
  awaiting_fulfilment boolean,
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
      and (p_fulfillment_status is null or coalesce(o.fulfillment_status, 'UNKNOWN') = p_fulfillment_status)
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
  'The Orders page: every live order, newest first, one page at a time, with the buyer''s name, VIP under vip_customers(), units, normalised carrier and destination. total_count is the filtered set before the page is cut. awaiting_fulfilment is open_orders()''s waiting rule. Filters: fulfilment status, destination country, VIP only, order ids, and a search over order name, buyer name, buyer email and tracking number.';
