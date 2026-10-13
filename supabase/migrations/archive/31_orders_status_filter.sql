-- 31_orders_status_filter.sql
--
-- The Orders page's status filter now selects what the status pill shows.
-- Cancelling or refunding every line of an order leaves Shopify's
-- fulfillment_status at UNFULFILLED for ever; the pill already reads Cancelled
-- or Refunded for those (fulfillmentDisplay in scripts/lib/order-list-query.mjs),
-- but the filter still offered "Unfulfilled" and returned them.
--
-- Measured 2026-09-18: all 14 UNFULFILLED orders have 0 items left (7
-- cancelled, 7 refunded without a cancel). After this the facets read
-- Fulfilled 6,013 / Cancelled 7 / Refunded 7, and Unfulfilled is offered only
-- when an order is genuinely waiting to ship.
--
-- order_fulfilment_display() is new; orders_list() filters on it and
-- orders_list_facets() groups on it. Same names, arguments and columns, so
-- `create or replace` is enough: idempotent, nothing dropped, no table, no
-- data. Copied byte-for-byte from 06_analytics.sql
-- (31_orders_status_filter.test.mjs asserts it); supersedes 16's orders_list
-- and 15's orders_list_facets.

create or replace function public.order_fulfilment_display(
  p_fulfillment_status text,
  p_line_items jsonb,
  p_cancelled_at timestamptz,
  p_financial_status text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_fulfillment_status, 'UNKNOWN') in ('FULFILLED', 'RESTOCKED')
      then p_fulfillment_status
    when (
      select coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)
      from jsonb_array_elements(
        case when jsonb_typeof(p_line_items) = 'array' then p_line_items else '[]'::jsonb end
      ) as li
    ) <> 0
      then coalesce(p_fulfillment_status, 'UNKNOWN')
    when p_cancelled_at is not null then 'CANCELLED'
    when p_financial_status = 'REFUNDED' then 'REFUNDED'
    else coalesce(p_fulfillment_status, 'UNKNOWN')
  end;
$$;

revoke all on function public.order_fulfilment_display from public, anon, authenticated;
grant execute on function public.order_fulfilment_display to service_role;

comment on function public.order_fulfilment_display is
  'The Orders page fulfilment status: Shopify''s, or CANCELLED / REFUNDED for an order not fulfilled or restocked with 0 items left. UNKNOWN when Shopify gave none. The rule fulfillmentDisplay() in scripts/lib/order-list-query.mjs labels the pill with.';

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
  'The Orders page: every live order, newest first, one page at a time, with the buyer''s name, VIP under vip_customers(), units, normalised carrier and destination. total_count is the filtered set before the page is cut. awaiting_fulfilment is open_orders()''s waiting rule. Filters: fulfilment status as order_fulfilment_display() derives it, destination country, VIP only, order ids, and a search over order name, buyer name, buyer email and tracking number.';

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
  select 'fulfillment_status', public.order_fulfilment_display(o.fulfillment_status, o.line_items, o.cancelled_at, o.financial_status), null::text, count(*)
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
  'Filter options for the Orders page: each fulfilment status (as order_fulfilment_display() derives it) and destination country among live orders, with its order count. Grouped on the same expressions orders_list() filters on.';
