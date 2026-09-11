-- ============================================================================
-- 11 — INSIGHTS OVER A DATE RANGE
--
-- WHAT THIS CHANGES. The Insights panels stop being all-time: every figure is
-- read over a range the reader picks (last 24 hours to last year, or custom),
-- bucketed in the shop's own timezone. Two things were missing for that:
--
--   shops.iana_timezone   where a day starts. The database runs in UTC, so a
--                         `date_trunc` there puts an order placed at 00:30 in
--                         Paris on the previous day.
--   the ranged functions  one per figure, because a median cannot be summed out
--                         of daily rows.
--
-- THE FUNCTIONS ARE COPIED FROM 06_analytics.sql, NOT RETYPED. 06 is the
-- baseline and declares them; this file brings an existing database up to it.
-- 11_insights_ranges.test.mjs asserts every function here is byte-identical to
-- its definition in 06, so the two cannot drift.
--
-- IDEMPOTENT: `add column if not exists` and `create or replace function`, so on
-- a fresh baseline every statement is a no-op.
--
-- Requires: 01_foundation.sql, 02_shopify.sql, 04_support.sql, 06_analytics.sql.
-- ============================================================================

alter table public.shops add column if not exists iana_timezone text;

comment on column public.shops.iana_timezone is
  'The shop''s IANA timezone from Shopify''s ianaTimezone (Europe/Paris). Where a day starts on the Insights charts. Null until the next shop sync; the reader falls back to UTC and says so.';

-- ============================================================================
-- RANGED READS
-- ============================================================================
--
-- The views above answer "all time". The panels are now read over a date range
-- the reader picks -- the last 24 hours up to the last year, or a custom span --
-- and a median cannot be summed out of daily rows, so each ranged figure is its
-- own function rather than a filter over a finer view.
--
-- ONE CONVENTION FOR EVERY FUNCTION BELOW:
--
--   p_from, p_to    the range as WALL-CLOCK timestamps in the shop's timezone,
--                   half-open [p_from, p_to). Converted here with `at time zone`,
--                   so a DST day is 23 or 25 hours without the caller knowing.
--   p_tz            the shop's IANA zone (shops.iana_timezone; UTC when unset).
--   p_grain         series only: hour | day | week | month. A bucket is the
--                   wall-clock `date_trunc` of the event in p_tz.
--   p_channels      orders only: sales channel HANDLES to keep, or null for all.
--   p_not_channels  orders only: handles to drop, or null. Which handles make up
--                   "Amazon" or "Shopify" is a business judgement and lives in
--                   scripts/lib/insights-range.mjs, as AMAZON_CHANNEL did.
--
-- SERIES RETURN ONLY NON-EMPTY BUCKETS. Filling the gaps is the caller's job,
-- because only the caller knows which empty bucket is a measured zero and which
-- falls outside what a source covers: a day after the last mail sync is not a
-- day with no mail.
--
-- Security invoker (the default), so the RLS on every table underneath still
-- applies; a pinned search_path; revoked from the anon roles like the views.

-- ---------------------------------------------------------- orders: summary

-- The headline figures for a range: volume and money, dispatch timing, and what
-- came back -- the same columns as fulfilment_summary, plus revenue.
--
-- REVENUE IS NET OF REFUNDS AND EXCLUDES CANCELLED ORDERS: `total_price` minus
-- `total_refunded`. A cancelled order that was never paid carries no refund, so
-- subtracting refunds alone would still count it. `orders` keeps every live order
-- in the range, cancelled included, because dispatch timing is measured on them
-- all; `cancelled_orders` is what separates the two.
create or replace function public.insights_orders_summary(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  orders bigint,
  cancelled_orders bigint,
  revenue numeric,
  gross_revenue numeric,
  measured bigint,
  p50_hours double precision,
  p90_hours double precision,
  mean_hours double precision,
  over_72h bigint,
  shipped_without_tracking bigint,
  with_delivery_event bigint,
  refunded_orders bigint,
  fully_refunded_orders bigint,
  returns_opened bigint,
  refunded_amount numeric
)
language sql
stable
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where o.cancelled_at is not null),
    coalesce(sum(t.total_price - coalesce(t.total_refunded, 0)) filter (where o.cancelled_at is null), 0),
    coalesce(sum(t.total_price) filter (where o.cancelled_at is null), 0),
    count(*) filter (where t.fulfilment_hours is not null),
    percentile_cont(0.5) within group (order by t.fulfilment_hours),
    percentile_cont(0.9) within group (order by t.fulfilment_hours),
    avg(t.fulfilment_hours)::double precision,
    count(*) filter (where t.fulfilment_hours > 72),
    count(*) filter (where t.fulfilment_count > 0 and t.tracking_count = 0),
    count(*) filter (where t.delivered_at is not null),
    count(*) filter (where t.total_refunded > 0),
    count(*) filter (
      where t.total_refunded > 0 and t.total_price > 0 and t.total_refunded >= t.total_price
    ),
    count(*) filter (where t.return_status is not null and t.return_status <> 'NO_RETURN'),
    coalesce(sum(t.total_refunded), 0)
  from public.order_fulfilment_timing t
  join public.orders o on o.id = t.order_id
  where t.shop_id = p_shop
    and t.processed_at >= (p_from at time zone p_tz)
    and t.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or t.channel = any(p_channels))
    and (p_not_channels is null or t.channel is null or not (t.channel = any(p_not_channels)));
$$;

revoke all on function public.insights_orders_summary from public, anon, authenticated;
grant execute on function public.insights_orders_summary to service_role;

comment on function public.insights_orders_summary is
  'One row for a date range: orders, net revenue (cancelled excluded, refunds subtracted), dispatch timing and what came back. The ranged twin of fulfilment_summary. Always one row -- an empty range is counts of 0 and null percentiles, never no row.';

-- ----------------------------------------------------------- orders: series

create or replace function public.insights_orders_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  bucket timestamp,
  orders bigint,
  revenue numeric,
  measured bigint,
  over_72h bigint,
  p50_hours double precision
)
language sql
stable
set search_path = public
as $$
  select
    date_trunc(p_grain, t.processed_at at time zone p_tz),
    count(*),
    coalesce(sum(t.total_price - coalesce(t.total_refunded, 0)) filter (where o.cancelled_at is null), 0),
    count(*) filter (where t.fulfilment_hours is not null),
    count(*) filter (where t.fulfilment_hours > 72),
    percentile_cont(0.5) within group (order by t.fulfilment_hours)
  from public.order_fulfilment_timing t
  join public.orders o on o.id = t.order_id
  where t.shop_id = p_shop
    and t.processed_at >= (p_from at time zone p_tz)
    and t.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or t.channel = any(p_channels))
    and (p_not_channels is null or t.channel is null or not (t.channel = any(p_not_channels)))
  group by 1
  order by 1;
$$;

revoke all on function public.insights_orders_series from public, anon, authenticated;
grant execute on function public.insights_orders_series to service_role;

comment on function public.insights_orders_series is
  'Orders, net revenue and dispatch timing per wall-clock bucket (hour/day/week/month in the shop timezone). Non-empty buckets only; the caller fills the rest and decides which empty ones are zero.';

-- ------------------------------------------------------ orders: by channel

-- The platform split. Takes no channel filter: it IS the split across channels.
create or replace function public.insights_orders_by_channel(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  channel text,
  channel_label text,
  orders bigint,
  revenue numeric
)
language sql
stable
set search_path = public
as $$
  select
    o.sales_channel_handle,
    max(o.sales_channel),
    count(*) filter (where o.cancelled_at is null),
    coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)) filter (where o.cancelled_at is null), 0)
  from public.orders o
  where o.shop_id = p_shop
    and o.deleted_at is null
    and o.processed_at >= (p_from at time zone p_tz)
    and o.processed_at < (p_to at time zone p_tz)
  group by 1
  order by 4 desc;
$$;

revoke all on function public.insights_orders_by_channel from public, anon, authenticated;
grant execute on function public.insights_orders_by_channel to service_role;

comment on function public.insights_orders_by_channel is
  'Orders and net revenue per sales channel handle for a date range, cancelled orders excluded. Handles are folded into platforms (Shopify / Amazon / Yves Rocher) in TypeScript.';

-- ------------------------------------------------------ orders: customer mix

-- New against returning customers, for a range.
--
-- NEW means the customer's earliest synced order falls inside the range. That
-- is "no earlier order in our data", and the data starts where the order sync's
-- history does -- so on a range near that horizon some returning customers read
-- as new. The caller must not pass marketplace channels: a marketplace mints a
-- customer record per order, so every one of those buyers would read as new.
create or replace function public.insights_customer_mix(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  new_customers bigint,
  returning_customers bigint,
  new_customer_orders bigint,
  returning_customer_orders bigint
)
language sql
stable
set search_path = public
as $$
  with ranged as (
    select o.shopify_customer_id as customer
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
  ),
  firsts as (
    select o.shopify_customer_id as customer, min(o.processed_at) as first_at
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id in (select r.customer from ranged r)
    group by 1
  )
  select
    count(distinct r.customer) filter (where f.first_at >= (p_from at time zone p_tz)),
    count(distinct r.customer) filter (where f.first_at < (p_from at time zone p_tz)),
    count(*) filter (where f.first_at >= (p_from at time zone p_tz)),
    count(*) filter (where f.first_at < (p_from at time zone p_tz))
  from ranged r
  join firsts f on f.customer = r.customer;
$$;

revoke all on function public.insights_customer_mix from public, anon, authenticated;
grant execute on function public.insights_customer_mix to service_role;

comment on function public.insights_customer_mix is
  'Customers who ordered in a range, split by whether their earliest synced order is inside it (new) or before it (returning), with their order counts. Never call it over marketplace channels: those mint one customer per order.';

-- ------------------------------------------------------- fulfilment: buckets

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
  order by 2;
$$;

revoke all on function public.insights_fulfilment_buckets from public, anon, authenticated;
grant execute on function public.insights_fulfilment_buckets to service_role;

comment on function public.insights_fulfilment_buckets is
  'The dispatch-time histogram for a date range, in the same six buckets as fulfilment_by_bucket. Empty buckets are absent; the caller draws all six.';

-- ------------------------------------------------------ fulfilment: carriers

-- Contact rate counts orders, not threads, exactly as fulfilment_by_carrier.
create or replace function public.insights_fulfilment_carriers(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  carrier text,
  shipments bigint,
  p50_hours double precision,
  over_72h bigint,
  without_tracking bigint,
  orders_with_ticket bigint,
  tickets bigint
)
language sql
stable
set search_path = public
as $$
  select
    t.carrier,
    count(*),
    percentile_cont(0.5) within group (order by t.fulfilment_hours),
    count(*) filter (where t.fulfilment_hours > 72),
    count(*) filter (where t.tracking_count = 0),
    count(*) filter (where k.tickets > 0),
    coalesce(sum(k.tickets), 0)::bigint
  from public.order_fulfilment_timing t
  left join lateral (
    select count(*) as tickets
    from public.tickets tk
    where tk.shop_id = t.shop_id
      and tk.deleted_at is null
      and tk.shopify_order_number = t.order_name
  ) k on true
  where t.shop_id = p_shop
    and t.carrier is not null
    and t.processed_at >= (p_from at time zone p_tz)
    and t.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or t.channel = any(p_channels))
    and (p_not_channels is null or t.channel is null or not (t.channel = any(p_not_channels)))
  group by 1
  order by 2 desc;
$$;

revoke all on function public.insights_fulfilment_carriers from public, anon, authenticated;
grant execute on function public.insights_fulfilment_carriers to service_role;

comment on function public.insights_fulfilment_carriers is
  'Shipments, dispatch timing and support contact per normalised carrier for a date range. orders_with_ticket counts orders, not threads -- see fulfilment_by_carrier.';

-- --------------------------------------------------------- sales: products

-- What sold, per product, for a range: distinct orders, units and net line
-- revenue, with the product's tags so the caller can fold products into the
-- groups it needs (gender is read off the catalogue tags in TypeScript -- a
-- judgement, so not here).
--
-- FREE LINES ARE NOT SALES. A line whose discounted total is zero is a sample or
-- a gift, and on this catalogue samples ride along on most orders: counted, they
-- would top every "best product by orders" list without a cent changing hands.
create or replace function public.insights_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  product_id text,
  title text,
  tags text[],
  orders bigint,
  units bigint,
  revenue numeric
)
language sql
stable
set search_path = public
as $$
  select
    li.value ->> 'product_id',
    coalesce(max(p.title), max(li.value ->> 'title')),
    max(p.tags),
    count(distinct o.id),
    coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)::bigint,
    coalesce(sum((li.value ->> 'discounted_total')::numeric), 0)
  from public.orders o
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
  ) as li
  left join public.products p
    on p.shop_id = o.shop_id
   and p.shopify_product_id = li.value ->> 'product_id'
  where o.shop_id = p_shop
    and o.deleted_at is null
    and o.cancelled_at is null
    and li.value ->> 'product_id' is not null
    and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
    and o.processed_at >= (p_from at time zone p_tz)
    and o.processed_at < (p_to at time zone p_tz)
    and (p_channels is null or o.sales_channel_handle = any(p_channels))
    and (
      p_not_channels is null
      or o.sales_channel_handle is null
      or not (o.sales_channel_handle = any(p_not_channels))
    )
  group by 1
  order by 6 desc;
$$;

revoke all on function public.insights_product_sales from public, anon, authenticated;
grant execute on function public.insights_product_sales to service_role;

comment on function public.insights_product_sales is
  'Per product for a date range: distinct orders, units and net line revenue, with catalogue tags. Zero-value lines (samples, gifts) are excluded. One row per product, so bounded by the catalogue.';

-- ------------------------------------------------ sales: products by country

-- The same measure per destination country, top p_limit products per country by
-- p_metric ('revenue' or 'orders'). Ranked here because country x product is
-- thousands of rows before the cut, which is exactly the shape readView refuses.
create or replace function public.insights_country_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_metric text,
  p_limit integer,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  country_code text,
  country_orders bigint,
  country_revenue numeric,
  product_id text,
  title text,
  orders bigint,
  units bigint,
  revenue numeric,
  rank bigint
)
language sql
stable
set search_path = public
as $$
  with lines as (
    select
      coalesce(o.shipping_destination ->> 'country_code', '??') as country_code,
      o.id as order_id,
      o.total_price - coalesce(o.total_refunded, 0) as order_revenue,
      li.value ->> 'product_id' as product_id,
      li.value ->> 'title' as line_title,
      coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0) as units,
      coalesce((li.value ->> 'discounted_total')::numeric, 0) as line_revenue
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
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
$$;

revoke all on function public.insights_country_product_sales from public, anon, authenticated;
grant execute on function public.insights_country_product_sales to service_role;

comment on function public.insights_country_product_sales is
  'Top p_limit products per destination country for a date range, ranked by revenue or orders, with each country''s own order count and net revenue. Zero-value lines excluded, as in insights_product_sales.';

-- ---------------------------------------------------------- support: summary

-- The desk over a range, keyed on when the customer first wrote
-- (`first_message_at`), not on `created_at` -- the latter reads the ingestion
-- date, and 214 tickets once shared one.
--
-- Reply figures carry their own denominator (`replies_measured`); the purchase
-- split counts tickets, and the reachability figures count DISTINCT people --
-- see support_purchase_states.
create or replace function public.insights_support_summary(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  tickets bigint,
  categorised bigint,
  still_open bigint,
  unhappy bigint,
  very_unhappy bigint,
  level_three bigint,
  replies_measured bigint,
  p50_reply_hours double precision,
  p90_reply_hours double precision,
  replied_within_24h bigint,
  buyer_tickets bigint,
  no_order_tickets bigint,
  unknown_tickets bigint,
  no_order_customers bigint,
  no_order_deliverable bigint,
  no_order_marketable bigint
)
language sql
stable
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where t.category is not null),
    count(*) filter (where t.status not in ('resolved', 'closed')),
    count(*) filter (where t.happiness >= 3),
    count(*) filter (where t.happiness = 4),
    count(*) filter (where t.level = 3),
    count(*) filter (where r.reply_hours is not null),
    percentile_cont(0.5) within group (order by r.reply_hours),
    percentile_cont(0.9) within group (order by r.reply_hours),
    count(*) filter (where r.reply_hours is not null and r.reply_hours <= 24),
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) > 0),
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) = 0),
    count(*) filter (where t.customer_id is null),
    count(distinct c.id) filter (where coalesce(c.number_of_orders, 0) = 0),
    count(distinct c.id) filter (
      where coalesce(c.number_of_orders, 0) = 0 and c.valid_email_address is true
    ),
    count(distinct c.id) filter (
      where coalesce(c.number_of_orders, 0) = 0 and c.on_email_marketing_list is true
    )
  from public.tickets t
  left join public.ticket_reply_times r on r.ticket_id = t.id
  left join public.customers c on c.id = t.customer_id
  where t.shop_id = p_shop
    and t.deleted_at is null
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz);
$$;

revoke all on function public.insights_support_summary from public, anon, authenticated;
grant execute on function public.insights_support_summary to service_role;

comment on function public.insights_support_summary is
  'One row for a date range, on first_message_at: ticket volume and mood, first-reply timing over the tickets that can be timed, and who wrote in by whether an online purchase is visible (tickets, then distinct people and their reachability).';

-- ----------------------------------------------------------- support: series

create or replace function public.insights_support_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text
)
returns table (
  bucket timestamp,
  tickets bigint,
  unhappy bigint,
  replies_measured bigint,
  p50_reply_hours double precision
)
language sql
stable
set search_path = public
as $$
  select
    date_trunc(p_grain, t.first_message_at at time zone p_tz),
    count(*),
    count(*) filter (where t.happiness >= 3),
    count(*) filter (where r.reply_hours is not null),
    percentile_cont(0.5) within group (order by r.reply_hours)
  from public.tickets t
  left join public.ticket_reply_times r on r.ticket_id = t.id
  where t.shop_id = p_shop
    and t.deleted_at is null
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz)
  group by 1
  order by 1;
$$;

revoke all on function public.insights_support_series from public, anon, authenticated;
grant execute on function public.insights_support_series to service_role;

comment on function public.insights_support_series is
  'Tickets, unhappy tickets and median first reply per wall-clock bucket, on first_message_at. Non-empty buckets only.';

-- ------------------------------------------------------- support: categories

-- One row per subject. Grouped on the subject alone -- unlike
-- support_by_category, which groups on (subject, kind) and has to be folded --
-- so the mean happiness here is exact rather than re-weighted.
create or replace function public.insights_support_categories(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  category text,
  tickets bigint,
  still_open bigint,
  unhappy bigint,
  level_three bigint,
  mean_happiness double precision,
  buyer_tickets bigint,
  no_order_tickets bigint,
  unknown_tickets bigint
)
language sql
stable
set search_path = public
as $$
  select
    t.category,
    count(*),
    count(*) filter (where t.status not in ('resolved', 'closed')),
    count(*) filter (where t.happiness >= 3),
    count(*) filter (where t.level = 3),
    avg(t.happiness)::double precision,
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) > 0),
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) = 0),
    count(*) filter (where t.customer_id is null)
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  where t.shop_id = p_shop
    and t.deleted_at is null
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz)
  group by 1
  order by 2 desc, 1;
$$;

revoke all on function public.insights_support_categories from public, anon, authenticated;
grant execute on function public.insights_support_categories to service_role;

comment on function public.insights_support_categories is
  'Volume, mood and purchase state per subject for a date range, on first_message_at. Fourteen rows at most.';

-- ------------------------------------------------------------ agent: funnel

create or replace function public.insights_agent_funnel(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  tickets bigint,
  categorised bigint,
  customer_linked bigint,
  order_linked bigint,
  context_built bigint,
  investigated bigint,
  low_confidence bigint,
  awaiting_categorisation bigint,
  awaiting_investigation bigint
)
language sql
stable
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where t.categorised_at is not null),
    count(*) filter (where t.customer_id is not null),
    count(*) filter (where t.shopify_order_number is not null),
    count(*) filter (where t.context_resolved_at is not null),
    count(*) filter (where t.investigated_at is not null),
    count(*) filter (where t.categorisation_confidence = 'low'),
    count(*) filter (where t.needs_categorisation),
    count(*) filter (where t.needs_investigation)
  from public.tickets t
  where t.shop_id = p_shop
    and t.deleted_at is null
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz);
$$;

revoke all on function public.insights_agent_funnel from public, anon, authenticated;
grant execute on function public.insights_agent_funnel to service_role;

comment on function public.insights_agent_funnel is
  'agent_pipeline_funnel over the tickets first written in a date range. Always one row.';

-- ----------------------------------------------------------- agent: verdicts

-- Case files by verdict, on when the investigation ran (`created_at`), since a
-- verdict is a fact about a run rather than about when the customer wrote.
create or replace function public.insights_agent_verdicts(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  verdict text,
  investigations bigint,
  tickets bigint,
  with_handoff bigint
)
language sql
stable
set search_path = public
as $$
  select
    i.verdict,
    count(*),
    count(distinct i.ticket_id),
    count(*) filter (where i.handoff is not null)
  from public.ticket_investigations i
  where i.shop_id = p_shop
    and i.created_at >= (p_from at time zone p_tz)
    and i.created_at < (p_to at time zone p_tz)
  group by 1
  order by 2 desc;
$$;

revoke all on function public.insights_agent_verdicts from public, anon, authenticated;
grant execute on function public.insights_agent_verdicts to service_role;

comment on function public.insights_agent_verdicts is
  'Investigations by verdict for the runs made in a date range.';

-- ----------------------------------------------------------- agent: blockers

create or replace function public.insights_agent_blockers(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  need text,
  state text,
  finding text,
  occurrences bigint,
  tickets bigint
)
language sql
stable
set search_path = public
as $$
  select
    g.value ->> 'need',
    g.value ->> 'state',
    g.value ->> 'finding',
    count(*),
    count(distinct i.ticket_id)
  from public.ticket_investigations i
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(i.evidence_gaps) = 'array' then i.evidence_gaps else '[]'::jsonb end
  ) as g
  where i.shop_id = p_shop
    and i.created_at >= (p_from at time zone p_tz)
    and i.created_at < (p_to at time zone p_tz)
  group by 1, 2, 3
  order by 4 desc;
$$;

revoke all on function public.insights_agent_blockers from public, anon, authenticated;
grant execute on function public.insights_agent_blockers to service_role;

comment on function public.insights_agent_blockers is
  'investigation_evidence_gaps over the runs made in a date range. Satisfied needs are included, as in the view; the caller filters them.';

-- -------------------------------------------------------------- agent: usage

create or replace function public.insights_llm_usage(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  model text,
  pass text,
  calls bigint,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  failed_calls bigint
)
language sql
stable
set search_path = public
as $$
  select
    u.model,
    u.pass,
    coalesce(sum(u.call_count), 0)::bigint,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.total_tokens), 0)::bigint,
    count(*) filter (where not u.succeeded)
  from public.llm_usage u
  where u.shop_id = p_shop
    and u.occurred_at >= (p_from at time zone p_tz)
    and u.occurred_at < (p_to at time zone p_tz)
  group by 1, 2
  order by 6 desc;
$$;

revoke all on function public.insights_llm_usage from public, anon, authenticated;
grant execute on function public.insights_llm_usage to service_role;

comment on function public.insights_llm_usage is
  'Token counts per model and pass for a date range. Tokens only -- money is applied at read time from llm-rates.mjs.';

create or replace function public.insights_llm_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text
)
returns table (
  bucket timestamp,
  model text,
  calls bigint,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint
)
language sql
stable
set search_path = public
as $$
  select
    date_trunc(p_grain, u.occurred_at at time zone p_tz),
    u.model,
    coalesce(sum(u.call_count), 0)::bigint,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.total_tokens), 0)::bigint
  from public.llm_usage u
  where u.shop_id = p_shop
    and u.occurred_at >= (p_from at time zone p_tz)
    and u.occurred_at < (p_to at time zone p_tz)
  group by 1, 2
  order by 1, 2;
$$;

revoke all on function public.insights_llm_series from public, anon, authenticated;
grant execute on function public.insights_llm_series to service_role;

comment on function public.insights_llm_series is
  'Token counts per wall-clock bucket and model -- per model because each is priced at its own rate. Non-empty buckets only.';

-- The per-ticket rollup the cost tiles need, which an average of per-call rows
-- cannot give -- same reason llm_usage_summary has a subquery.
create or replace function public.insights_llm_ticket_stats(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  tickets_touched bigint,
  mean_tokens_per_ticket double precision,
  max_tokens_on_a_ticket bigint
)
language sql
stable
set search_path = public
as $$
  select
    count(*),
    avg(s.ticket_tokens)::double precision,
    max(s.ticket_tokens)::bigint
  from (
    select u.ticket_id, sum(u.total_tokens) as ticket_tokens
    from public.llm_usage u
    where u.shop_id = p_shop
      and u.ticket_id is not null
      and u.occurred_at >= (p_from at time zone p_tz)
      and u.occurred_at < (p_to at time zone p_tz)
    group by 1
  ) s;
$$;

revoke all on function public.insights_llm_ticket_stats from public, anon, authenticated;
grant execute on function public.insights_llm_ticket_stats to service_role;

comment on function public.insights_llm_ticket_stats is
  'How many tickets the agent spent tokens on in a date range, and the mean and worst per-ticket token totals.';

-- ---------------------------------------------------------------- freshness

-- HOW CURRENT EACH SOURCE IS, as one row. The dashboard is only as live as the
-- jobs that feed it, and when one stops the panels do not go blank -- they keep
-- showing the last thing they were given. This is what lets a panel say "last
-- email 22 days ago" instead of quietly drawing August.
--
-- `mail_synced_through` is the newest message in either direction: the mail
-- worker records no "last poll" anywhere, so the newest thing it wrote is the
-- best available bound on how far the mailbox has been read.
create or replace function public.insights_freshness(p_shop uuid)
returns table (
  orders_synced_at timestamptz,
  first_order_at timestamptz,
  last_order_at timestamptz,
  customers_synced_at timestamptz,
  first_mail_at timestamptz,
  mail_synced_through timestamptz,
  topic_map_built_at timestamptz,
  last_llm_call_at timestamptz,
  nightly_sync_status text,
  nightly_sync_started_at timestamptz,
  nightly_sync_finished_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    (select max(o.updated_at) from public.orders o where o.shop_id = p_shop),
    (select min(o.processed_at) from public.orders o where o.shop_id = p_shop and o.deleted_at is null),
    (select max(o.processed_at) from public.orders o where o.shop_id = p_shop and o.deleted_at is null),
    (select max(c.updated_at) from public.customers c where c.shop_id = p_shop),
    (select min(t.first_message_at) from public.tickets t where t.shop_id = p_shop and t.deleted_at is null),
    (
      select max(coalesce(m.sent_at, m.received_at))
      from public.ticket_messages m
      where m.shop_id = p_shop and m.deleted_at is null
    ),
    (select max(r.built_at) from public.cluster_runs r where r.shop_id = p_shop),
    (select max(u.occurred_at) from public.llm_usage u where u.shop_id = p_shop),
    e.status,
    e.started_at,
    e.finished_at
  from (select 1) as one
  left join lateral (
    select ie.status, ie.started_at, ie.finished_at
    from public.integration_events ie
    where ie.shop_id = p_shop
      and ie.event_type = 'nightly_sync'
    order by ie.created_at desc
    limit 1
  ) e on true;
$$;

revoke all on function public.insights_freshness from public, anon, authenticated;
grant execute on function public.insights_freshness to service_role;

comment on function public.insights_freshness is
  'One row: when each source feeding the dashboard last moved -- orders, customers, mail, the topic map, the agent -- and the latest nightly sync run. The panels read it to say how old their figures are.';

-- ----------------------------------------------------- sales: by country

-- Net revenue and orders per destination country for a range — the "sales by
-- country" list. Cancelled orders excluded, as everywhere revenue is counted.
create or replace function public.insights_orders_by_country(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  country_code text,
  orders bigint,
  revenue numeric
)
language sql
stable
set search_path = public
as $$
  select
    coalesce(o.shipping_destination ->> 'country_code', '??'),
    count(*),
    coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)), 0)
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
  group by 1
  order by 3 desc;
$$;

revoke all on function public.insights_orders_by_country from public, anon, authenticated;
grant execute on function public.insights_orders_by_country to service_role;

comment on function public.insights_orders_by_country is
  'Orders and net revenue per destination country for a date range, cancelled orders excluded.';

-- ------------------------------------------------------ sales: product pairs

-- Which two products are bought together most often, for a range: every pair
-- of distinct paid products that appear in the same order, whatever else the
-- order holds. Counted once per order; `revenue` is what the two lines of the
-- pair brought in, together, across those orders.
--
-- Global and per-country in one pass (GROUPING SETS — the global rows carry a
-- null country), each ranked both ways and cut to p_limit, so the caller can
-- switch between revenue and orders without a second round trip.
--
-- Free lines are excluded for the reason insights_product_sales gives: a sample
-- rides along on most orders and would pair with everything.
create or replace function public.insights_product_pairs(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_limit integer,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  country_code text,
  product_a text,
  title_a text,
  product_b text,
  title_b text,
  orders bigint,
  revenue numeric,
  rank_by_orders bigint,
  rank_by_revenue bigint
)
language sql
stable
set search_path = public
as $$
  with per_line as (
    select
      o.id as order_id,
      coalesce(o.shipping_destination ->> 'country_code', '??') as country_code,
      li.value ->> 'product_id' as product_id,
      max(li.value ->> 'title') as line_title,
      sum(coalesce((li.value ->> 'discounted_total')::numeric, 0)) as revenue
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
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
$$;

revoke all on function public.insights_product_pairs from public, anon, authenticated;
grant execute on function public.insights_product_pairs to service_role;

comment on function public.insights_product_pairs is
  'The product pairs most often bought in the same order for a date range, globally (null country) and per destination country, each ranked by orders and by revenue and cut to p_limit. Free lines excluded.';

-- ------------------------------------------------- customers: orders each

-- How many customers ordered once, twice, three times… inside a range.
--
-- PEOPLE, SO NEVER OVER A MARKETPLACE: Amazon and Yves Rocher mint one customer
-- per order, so every one of their buyers would sit in the "1" column. The
-- caller passes the marketplaces in p_not_channels.
create or replace function public.insights_orders_per_customer(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  order_count integer,
  customers bigint
)
language sql
stable
set search_path = public
as $$
  select per.n::integer, count(*)
  from (
    select o.shopify_customer_id, count(*) as n
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
    group by 1
  ) per
  group by 1
  order by 1;
$$;

revoke all on function public.insights_orders_per_customer from public, anon, authenticated;
grant execute on function public.insights_orders_per_customer to service_role;

comment on function public.insights_orders_per_customer is
  'How many customers placed 1, 2, 3… orders inside a date range. One row per order count. Callers exclude marketplace channels: those mint a customer per order.';

-- ---------------------------------------------- customers: newsletter consent

-- Subscribes and unsubscribes, as far as a SNAPSHOT can say.
--
-- `customers` holds each person's CURRENT consent state and the time it last
-- changed — one timestamp, not a history. So a subscribe is "is subscribed now,
-- and the last change fell in this bucket", and likewise an unsubscribe. Both
-- are floors: someone who subscribed in March and unsubscribed in June appears
-- only in June, as an unsubscribe. The caller says so, and derives the data edge
-- from `consent_through` rather than assuming the sync is current.
create or replace function public.insights_marketing_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text
)
returns table (
  bucket timestamp,
  subscribed bigint,
  unsubscribed bigint
)
language sql
stable
set search_path = public
as $$
  select
    date_trunc(p_grain, c.email_marketing_consent_updated_at at time zone p_tz),
    count(*) filter (where c.email_marketing_state = 'SUBSCRIBED'),
    count(*) filter (where c.email_marketing_state = 'UNSUBSCRIBED')
  from public.customers c
  where c.shop_id = p_shop
    and c.deleted_at is null
    and c.email_marketing_state in ('SUBSCRIBED', 'UNSUBSCRIBED')
    and c.email_marketing_consent_updated_at >= (p_from at time zone p_tz)
    and c.email_marketing_consent_updated_at < (p_to at time zone p_tz)
  group by 1
  order by 1;
$$;

revoke all on function public.insights_marketing_series from public, anon, authenticated;
grant execute on function public.insights_marketing_series to service_role;

comment on function public.insights_marketing_series is
  'Newsletter subscribes and unsubscribes per wall-clock bucket, read off the current consent state and its last-change time. Floors: one timestamp per customer, so an earlier change is overwritten by a later one.';

-- The range totals, plus the list size at the start of the range — the
-- denominator a churn rate needs, reconstructed from the snapshot:
--
--   subscribed now, last change BEFORE the range    -> was on the list at the start
--   unsubscribed now, last change INSIDE or after   -> was on the list, then left
--
-- An estimate, and a named one: somebody on the list at the start who left and
-- re-joined during the range reads as "joined", so the start is a floor too.
-- Its return shape grew a column after it was first applied, and create or
-- replace cannot change a return type.
drop function if exists public.insights_marketing_summary(uuid, timestamp, timestamp, text);

create or replace function public.insights_marketing_summary(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  subscribed bigint,
  unsubscribed bigint,
  list_at_start bigint,
  subscribers_now bigint,
  consent_through timestamptz,
  unsubscribes_from timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    count(*) filter (
      where c.email_marketing_state = 'SUBSCRIBED'
        and c.email_marketing_consent_updated_at >= (p_from at time zone p_tz)
        and c.email_marketing_consent_updated_at < (p_to at time zone p_tz)
    ),
    count(*) filter (
      where c.email_marketing_state = 'UNSUBSCRIBED'
        and c.email_marketing_consent_updated_at >= (p_from at time zone p_tz)
        and c.email_marketing_consent_updated_at < (p_to at time zone p_tz)
    ),
    count(*) filter (
      where (
        c.email_marketing_state = 'SUBSCRIBED'
        and coalesce(c.email_marketing_consent_updated_at, '-infinity'::timestamptz) < (p_from at time zone p_tz)
      ) or (
        c.email_marketing_state = 'UNSUBSCRIBED'
        and c.email_marketing_consent_updated_at >= (p_from at time zone p_tz)
      )
    ),
    count(*) filter (where c.email_marketing_state = 'SUBSCRIBED'),
    max(c.email_marketing_consent_updated_at),
    -- The earliest unsubscribe the snapshot still holds. Before it, subscribes
    -- appear and unsubscribes cannot, so a churn or net figure there is not
    -- low, it is unmeasured: the caller hatches that span and will not compare
    -- against it.
    min(c.email_marketing_consent_updated_at) filter (where c.email_marketing_state = 'UNSUBSCRIBED')
  from public.customers c
  where c.shop_id = p_shop
    and c.deleted_at is null;
$$;

revoke all on function public.insights_marketing_summary from public, anon, authenticated;
grant execute on function public.insights_marketing_summary to service_role;

comment on function public.insights_marketing_summary is
  'Newsletter subscribes and unsubscribes in a date range, the list size at its start reconstructed from the consent snapshot (an estimate), the list size now, and both edges of what the snapshot covers: the newest consent change and the earliest recorded unsubscribe.';

-- --------------------------------------------------- customers: capture rate

-- First-time buyers per bucket, and how many of them were on the newsletter by
-- the time of that first order — split into "subscribed before ordering" and
-- "subscribed at checkout" (consent within p_checkout_minutes of the order).
--
-- A first order is a customer's earliest synced, uncancelled order, so near the
-- start of the order history everyone is a first-time buyer; the caller marks
-- that edge. Consent is read off the current state, so a buyer who subscribed
-- and has since left counts as not captured: a floor. People, so the caller
-- excludes marketplace channels.
create or replace function public.insights_capture_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text,
  p_checkout_minutes integer,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  bucket timestamp,
  first_orders bigint,
  subscribed_before bigint,
  subscribed_at_checkout bigint
)
language sql
stable
set search_path = public
as $$
  with firsts as (
    select o.shopify_customer_id as customer, min(o.processed_at) as first_at
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id is not null
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
    group by 1
  )
  select
    date_trunc(p_grain, f.first_at at time zone p_tz),
    count(*),
    count(*) filter (
      where c.email_marketing_state = 'SUBSCRIBED'
        and c.email_marketing_consent_updated_at < f.first_at - make_interval(mins => p_checkout_minutes)
    ),
    count(*) filter (
      where c.email_marketing_state = 'SUBSCRIBED'
        and c.email_marketing_consent_updated_at >= f.first_at - make_interval(mins => p_checkout_minutes)
        and c.email_marketing_consent_updated_at <= f.first_at + make_interval(mins => p_checkout_minutes)
    )
  from firsts f
  left join public.customers c
    on c.shop_id = p_shop
   and c.shopify_customer_id = f.customer
  where f.first_at >= (p_from at time zone p_tz)
    and f.first_at < (p_to at time zone p_tz)
  group by 1
  order by 1;
$$;

revoke all on function public.insights_capture_series from public, anon, authenticated;
grant execute on function public.insights_capture_series to service_role;

comment on function public.insights_capture_series is
  'First-time buyers per wall-clock bucket, with how many were on the newsletter before that first order and how many joined at checkout (within p_checkout_minutes). Current consent state, so a floor. Callers exclude marketplace channels.';
