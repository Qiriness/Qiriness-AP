-- 22_segment_finder.sql
--
-- The Customers panel's Segment Finder: customer_segment_find(), customers
-- matching OR-of-AND conditions over orders, spend (last N months) and
-- lifetime spend. Copied byte-for-byte from 06_analytics.sql
-- (22_segment_finder.test.mjs asserts it). A new function, so nothing is
-- dropped; `create or replace` makes a second apply a no-op. No table, no data.

-- ------------------------------------------------ customers: segment finder

-- The Customers panel's Segment Finder: which customers match conditions the
-- operator builds, and the 25 of them with the highest lifetime spend.
--
-- THE CONDITIONS ARRIVE AS OR-OF-AND GROUPS (`p_groups`), already resolved by
-- `segmentGroups` in scripts/lib/segment-finder.mjs: `[[a, b], [c]]` is
-- (a AND b) OR c. A customer matches when EVERY condition of AT LEAST ONE group
-- holds. Each condition is `{metric, op, value}`:
--   metric  orders          uncancelled Shopify orders in the last p_window_months
--           spend           their net spend (total_price - total_refunded)
--           lifetime_spend  net spend over every uncancelled Shopify order
--   op      gt | lt         strictly more than / strictly less than
-- Anything else FAILS CLOSED: an unknown metric or operator makes its condition
-- false rather than true, so a malformed group matches nobody. The caller
-- validates first; this is the second lock.
--
-- EVERY CUSTOMER ON FILE, NOT JUST BUYERS, so "orders < 1" finds the people
-- who signed up and never bought. Except the synthetic ones: a marketplace mints
-- one customer record per order (p_not_channels names those channels), and a
-- customer holding any such order is left out entirely rather than counted as a
-- zero-order person. Their orders are left out of every figure too.
--
-- ONE ROW EVEN WHEN NOTHING MATCHES. The totals are a one-row CTE the members
-- are left-joined onto, so "0 customers" arrives as a figure and not as silence.
-- The members are capped by p_limit; the totals are not.
create or replace function public.customer_segment_find(
  p_shop uuid,
  p_window_months integer,
  p_groups jsonb,
  p_not_channels text[] default null,
  p_limit integer default 25
)
returns table (
  customer_id uuid,
  customer_name text,
  orders bigint,
  spend numeric,
  lifetime_spend numeric,
  last_order_at timestamptz,
  on_marketing_list boolean,
  matched_customers bigint,
  matched_on_marketing_list bigint,
  matched_spend numeric,
  matched_lifetime_spend numeric,
  base_customers bigint,
  base_buyers bigint
)
language sql
stable
set search_path = public
as $$
  with order_facts as (
    select
      o.shopify_customer_id as customer_key,
      count(*) filter (
        where o.processed_at >= now() - make_interval(months => p_window_months)
      ) as orders,
      coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)) filter (
        where o.processed_at >= now() - make_interval(months => p_window_months)
      ), 0) as spend,
      coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)), 0) as lifetime_spend,
      max(o.processed_at) as last_order_at
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id is not null
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
    group by 1
  ),
  marketplace_keys as (
    select distinct o.shopify_customer_id as customer_key
    from public.orders o
    where o.shop_id = p_shop
      and o.shopify_customer_id is not null
      and p_not_channels is not null
      and o.sales_channel_handle = any(p_not_channels)
  ),
  base as (
    select
      c.id as customer_id,
      coalesce(c.display_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as customer_name,
      coalesce(f.orders, 0) as orders,
      coalesce(f.spend, 0) as spend,
      coalesce(f.lifetime_spend, 0) as lifetime_spend,
      f.last_order_at,
      coalesce(c.on_email_marketing_list, false) as on_marketing_list
    from public.customers c
    left join order_facts f on f.customer_key = c.shopify_customer_id
    where c.shop_id = p_shop
      and c.deleted_at is null
      and not exists (
        select 1 from marketplace_keys mk where mk.customer_key = c.shopify_customer_id
      )
  ),
  matched as (
    select b.*
    from base b
    where exists (
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end
      ) as grp(conditions)
      where jsonb_typeof(grp.conditions) = 'array'
        and jsonb_array_length(grp.conditions) > 0
        and not exists (
          select 1
          from jsonb_array_elements(grp.conditions) as cond(rule)
          cross join lateral (
            select case cond.rule ->> 'metric'
              when 'orders' then b.orders::numeric
              when 'spend' then b.spend
              when 'lifetime_spend' then b.lifetime_spend
            end as actual
          ) m
          where not coalesce(
            case cond.rule ->> 'op'
              when 'gt' then m.actual > (cond.rule ->> 'value')::numeric
              when 'lt' then m.actual < (cond.rule ->> 'value')::numeric
            end,
            false
          )
        )
    )
  ),
  totals as (
    select
      (select count(*) from base) as base_customers,
      (select count(*) from base where base.last_order_at is not null) as base_buyers,
      count(*) as matched_customers,
      count(*) filter (where mt.on_marketing_list) as matched_on_marketing_list,
      coalesce(sum(mt.spend), 0) as matched_spend,
      coalesce(sum(mt.lifetime_spend), 0) as matched_lifetime_spend
    from matched mt
  ),
  shown as (
    select mt.*
    from matched mt
    order by mt.lifetime_spend desc, mt.customer_id
    limit greatest(coalesce(p_limit, 25), 0)
  )
  select
    s.customer_id,
    s.customer_name,
    s.orders,
    s.spend,
    s.lifetime_spend,
    s.last_order_at,
    s.on_marketing_list,
    t.matched_customers,
    t.matched_on_marketing_list,
    t.matched_spend,
    t.matched_lifetime_spend,
    t.base_customers,
    t.base_buyers
  from totals t
  left join shown s on true
  order by s.lifetime_spend desc nulls last, s.customer_id;
$$;

revoke all on function public.customer_segment_find from public, anon, authenticated;
grant execute on function public.customer_segment_find to service_role;

comment on function public.customer_segment_find is
  'Segment Finder: customers matching OR-of-AND groups of {metric: orders | spend | lifetime_spend, op: gt | lt, value} conditions, with orders and spend counted over the last p_window_months and lifetime over all uncancelled Shopify orders (net of refunds). Every customer on file except marketplace-synthetic ones. Always one totals row; up to p_limit members by lifetime spend.';
