-- ============================================================================
-- 14_fulfilment_waiting.sql -- orders that never shipped stop vanishing from
-- the dispatch histogram.
--
-- THE BUG THIS FIXES, found on the dashboard 2026-09-12: for 1-12 September the
-- ">96h" bar read zero while the list directly below it showed an order that had
-- been waiting eight days. Both were right about their own set and neither was
-- right about the question a reader asks. The six buckets measure a DURATION,
-- which only a shipped order has, so five unshipped orders -- one at eight days,
-- one at ten -- were counted nowhere.
--
-- insights_fulfilment_buckets() now returns a seventh bucket, "Not shipped yet",
-- counted by the same rule as open_orders(), so the bar and the list beneath it
-- cannot disagree.
--
-- THE FUNCTION IS COPIED FROM 06_analytics.sql, NOT RETYPED, and
-- 14_fulfilment_waiting.test.mjs holds the two byte-identical. It supersedes the
-- copy carried by 11_insights_ranges.sql, which is left as the historical step
-- it was.
--
-- IDEMPOTENT: `create or replace function` -- a no-op on a fresh baseline.
--
-- Requires: 01_foundation.sql, 02_shopify.sql, 06_analytics.sql.
-- ============================================================================

create or replace function public.insights_fulfilment_buckets(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  bucket text,
  bucket_order integer,
  orders bigint
)
language sql
stable
set search_path = public
as $$
  select
    case
      when t.fulfilment_hours < 12 then '<12h'
      when t.fulfilment_hours < 24 then '12-24h'
      when t.fulfilment_hours < 48 then '24-48h'
      when t.fulfilment_hours < 72 then '48-72h'
      when t.fulfilment_hours < 96 then '72-96h'
      else '>96h'
    end,
    case
      when t.fulfilment_hours < 12 then 1
      when t.fulfilment_hours < 24 then 2
      when t.fulfilment_hours < 48 then 3
      when t.fulfilment_hours < 72 then 4
      when t.fulfilment_hours < 96 then 5
      else 6
    end,
    count(*)
  from public.order_fulfilment_timing t
  where t.shop_id = p_shop
    and t.fulfilment_hours is not null
    and t.processed_at >= (p_from at time zone p_tz)
    and t.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or t.channel = any(p_channels))
    and (p_not_channels is null or t.channel is null or not (t.channel = any(p_not_channels)))
  group by 1, 2

  union all

  -- THE ORDERS THAT HAVE NOT SHIPPED AT ALL, which the six duration buckets
  -- cannot hold: an order still waiting has no duration to bucket, so without
  -- this row a shop with nothing over 96h reads as "everything went out inside
  -- four days" while an order sits unshipped on day ten. Same rule as
  -- open_orders(): not cancelled, not closed, nothing dispatched yet -- so the
  -- bar and the "Orders waiting to ship" list below it agree by construction.
  select 'Not shipped yet', 7, count(*)
  from public.orders o
  join public.order_fulfilment_timing t on t.order_id = o.id
  where o.shop_id = p_shop
    and t.first_fulfilled_at is null
    and o.cancelled_at is null
    and o.closed_at is null
    and o.fulfillment_status is not null
    and o.fulfillment_status not in ('FULFILLED', 'RESTOCKED')
    and o.processed_at >= (p_from at time zone p_tz)
    and o.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or o.sales_channel_handle = any(p_channels))
    and (
      p_not_channels is null
      or o.sales_channel_handle is null
      or not (o.sales_channel_handle = any(p_not_channels))
    )
  having count(*) > 0

  order by 2;
$$;

revoke all on function public.insights_fulfilment_buckets from public, anon, authenticated;
grant execute on function public.insights_fulfilment_buckets to service_role;

comment on function public.insights_fulfilment_buckets is
  'The dispatch-time histogram for a date range: the six duration buckets of fulfilment_by_bucket, plus "Not shipped yet" (bucket_order 7) for orders placed in the range that are still waiting, counted exactly as open_orders() counts them. Empty buckets are absent; the caller draws all seven.';
