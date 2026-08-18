-- ============================================================================
-- 06 — ANALYTICS
-- What the Insights dashboards read, plus the two things that had to start
-- being recorded before they could be read at all.
--
-- THE RULE THIS FILE EXISTS TO ENFORCE: aggregate in SQL, never by paging rows.
-- PostgREST caps a response at 1,000 rows and pages an unordered query in
-- whatever order the planner returns, so a dashboard that reads rows and reduces
-- them in JavaScript is wrong twice over -- silently, with a plausible number.
-- Measured while designing these panels: an unordered paged tally of the 58,201
-- customers returned CHAMPIONS as 438, then 554, then 472 on three consecutive
-- runs. Every figure a panel shows therefore comes from a view below.
--
-- JOINS AND AGGREGATES ONLY, as in 04_support.sql. Judgement stays in tested
-- JavaScript: these views expose `rfm_group`, never `is_vip`, because who counts
-- as a VIP is a business rule owned by `customer-segments.mjs` and would become a
-- schema object the moment it was written here.
--
-- Requires: 01_foundation.sql (shops), 02_shopify.sql (orders, customers),
-- 04_support.sql (tickets, ticket_messages, ticket_investigations).
-- ============================================================================

-- ------------------------------------------------------------ carrier names

-- Carrier names arrive as free text from a 3PL fulfilment feed, and the same
-- carrier arrives spelled three ways: the live table holds `COLISSIMO`,
-- `Colissimo` and `LA POSTE COLISSIMO`. A per-carrier breakdown built on the raw
-- string splits one carrier across three rows and makes the second-largest look
-- like the largest. Normalised in one place so the panel and any future SLA
-- report cannot disagree about how many carriers there are.
create or replace function public.normalise_carrier(value text)
returns text
language sql
immutable
as $$
  select case
    when value is null or btrim(value) = '' then null
    when upper(value) like '%COLISSIMO%' then 'COLISSIMO'
    when upper(value) like '%LA POSTE%' then 'COLISSIMO'
    when upper(value) like '%GLS%' then 'GLS'
    when upper(value) like '%CHRONOPOST%' then 'CHRONOPOST'
    when upper(value) like '%MONDIAL%' then 'MONDIAL RELAY'
    when upper(value) like '%DHL%' then 'DHL'
    when upper(value) like '%UPS%' then 'UPS'
    else upper(btrim(value))
  end;
$$;

comment on function public.normalise_carrier(text) is
  'Free-text carrier name from a fulfilment record -> one canonical name. COLISSIMO/Colissimo/LA POSTE COLISSIMO are one carrier stored three ways; without this a per-carrier panel reports three.';

-- ---------------------------------------------------------------- llm_usage

-- One row per model call, append-only.
--
-- WHY IT EXISTS. Nothing recorded what the agent spends. OpenAI returns a
-- `usage` object on every response and `completeWithTools` already handed it
-- back to its caller, where nothing read it; `completeJson` discarded it before
-- the caller could see it. This is the table that field lands in.
--
-- TOKENS ARE STORED, MONEY IS NOT. Rates change and models get swapped, and a
-- stored euro figure is wrong the day the rate card moves with no way to restate
-- history. The panel multiplies tokens by a rate held in config at read time.
--
-- FAILURES ARE ROWS TOO. A retried or abandoned call still costs money, so
-- `succeeded` is a column rather than a filter on what gets written -- recording
-- only successes would under-report spend exactly when things are going wrong.
--
-- `ticket_id` is nullable and ON DELETE SET NULL: embedding runs and the spam
-- gate have no ticket, and a ticket deleted for compliance must not take the
-- shop's cost history with it. Without this column "average tokens per ticket"
-- and "the worst single ticket" are both unanswerable.
create table public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid references public.tickets(id) on delete set null,
  pass text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  call_count integer not null default 1,
  succeeded boolean not null default true,
  error_kind text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- The passes in the worker's poll order. `agent/src/llm/usage-sink.mjs` holds
  -- the other copy of this list and validates against it before a bulk insert;
  -- a check constraint cannot import a module, so 06_analytics.test.mjs is what
  -- stops the two drifting apart.
  constraint llm_usage_pass_check check (
    pass in ('spam', 'categorise', 'decompose', 'investigate', 'draft', 'embed', 'other')
  ),
  constraint llm_usage_input_tokens_check check (input_tokens >= 0),
  constraint llm_usage_output_tokens_check check (output_tokens >= 0),
  constraint llm_usage_total_tokens_check check (total_tokens >= 0),
  constraint llm_usage_call_count_check check (call_count > 0)
);

create index llm_usage_shop_occurred_idx on public.llm_usage (shop_id, occurred_at);

create index llm_usage_shop_model_idx on public.llm_usage (shop_id, model);

create index llm_usage_shop_pass_idx on public.llm_usage (shop_id, pass);

create index llm_usage_ticket_idx on public.llm_usage (ticket_id);

alter table public.llm_usage enable row level security;

comment on table public.llm_usage is
  'One row per LLM or embedding call: pass, model, token counts, and the ticket it was spent on. Append-only and written by the agent worker through a single sink in the OpenAI transport. Tokens are stored and money is computed at read time from a configured rate, so a price change does not invalidate history.';

comment on column public.llm_usage.pass is
  'Which agent pass spent this: spam | categorise | decompose | investigate | draft | embed | other. Matches the passes in the worker poll order, and the USAGE_PASSES list in agent/src/llm/usage-sink.mjs.';

comment on column public.llm_usage.ticket_id is
  'The ticket this call was spent on, where there is one. Null for embedding reconciliation and for spam-gate decisions, which are taken before any ticket exists.';

comment on column public.llm_usage.succeeded is
  'False for a call that errored or was abandoned. Those cost money too, so they are recorded rather than filtered out at the write.';

-- -------------------------------------------------------------- cluster_runs

-- One row per rebuild of the topic map.
--
-- THE MAP IS REBUILT BY HAND, ON PURPOSE. Clustering is an all-pairs cosine
-- comparison over the whole embedded corpus and its similarity threshold is
-- hand-tuned -- 0.68 was set by eye and is corpus-specific. That makes a rebuild
-- a deliberate act with a judgement in it, not something that should re-run at
-- 3am and change the map underneath whoever is reading it. This row is what lets
-- the panel say how old the map is and what settings produced it.
create table public.cluster_runs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  built_at timestamptz not null default now(),
  threshold numeric(4, 3) not null,
  min_size integer not null,
  dedupe numeric(4, 3) not null,
  message_count integer not null default 0,
  internal_excluded integer not null default 0,
  subject_count integer not null default 0,
  topic_count integer not null default 0,
  created_at timestamptz not null default now(),

  constraint cluster_runs_threshold_check check (threshold > 0 and threshold <= 1),
  constraint cluster_runs_dedupe_check check (dedupe > 0 and dedupe <= 1),
  constraint cluster_runs_min_size_check check (min_size >= 1),
  constraint cluster_runs_message_count_check check (message_count >= 0)
);

create index cluster_runs_shop_built_idx on public.cluster_runs (shop_id, built_at desc);

alter table public.cluster_runs enable row level security;

comment on table public.cluster_runs is
  'One row per manual rebuild of the topic map: when it was built, the threshold and minimum size used, and how much mail it saw. The panel reads the newest row to show the map''s age and to warn when the live corpus has drifted away from it.';

comment on column public.cluster_runs.threshold is
  'The cosine similarity threshold this run used. Corpus-specific and hand-tuned; exposed in the resync dialog because it is the one knob that changes the answer.';

comment on column public.cluster_runs.internal_excluded is
  'Messages skipped because the sender directory says they are ours. Recorded so a shrinking map can be told apart from a growing blocklist.';

-- ------------------------------------------------------------ ticket_clusters

-- One row per topic found in a run.
--
-- The member message ids are an array on the row rather than a fourth join
-- table: a cluster is written once, read whole, and never queried member-first,
-- so a join table would be a table to maintain for a query nobody makes. The
-- GIN index is what still allows "which cluster is this message in?".
create table public.ticket_clusters (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  run_id uuid not null references public.cluster_runs(id) on delete cascade,
  subject text not null,
  cluster_index integer not null,
  size integer not null,
  cohesion numeric(4, 3),
  representative_excerpt text,
  member_message_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),

  constraint ticket_clusters_size_check check (size >= 1),
  constraint ticket_clusters_run_index_unique unique (run_id, subject, cluster_index)
);

create index ticket_clusters_shop_run_idx on public.ticket_clusters (shop_id, run_id);

create index ticket_clusters_run_subject_idx on public.ticket_clusters (run_id, subject);

create index ticket_clusters_members_gin_idx on public.ticket_clusters using gin (member_message_ids);

alter table public.ticket_clusters enable row level security;

comment on table public.ticket_clusters is
  'One row per topic found in a cluster run: its subject, size, cohesion, a representative excerpt and the messages in it. Written whole by cluster:tickets and read whole by the topic map.';

comment on column public.ticket_clusters.member_message_ids is
  'The ticket_messages in this cluster. An array rather than a join table because a cluster is written and read whole; the GIN index still answers "which cluster holds this message?".';

-- ============================================================================
-- FULFILMENT
-- ============================================================================

-- --------------------------------------------------- order_fulfilment_timing

-- One row per order, with the one duration that is fully computable today.
--
-- Fulfilment time is `processed_at` -> the earliest `fulfillments[].created_at`,
-- and both are populated on essentially every order. DELIVERY time is NOT here
-- and cannot be: `in_transit_at`, `estimated_delivery_at` and `delivered_at` are
-- empty on the whole table because no carrier feeds scan events back to Shopify
-- for this store. When that feed exists this view is where the second duration
-- lands, beside the first.
--
-- The earliest fulfilment rather than the latest: a split shipment starts moving
-- when the first parcel does, and that is the promise the customer was given.
create view public.order_fulfilment_timing
with (security_invoker = true) as
  select
    o.id as order_id,
    o.shop_id as shop_id,
    o.order_number as order_number,
    o.name as order_name,
    o.processed_at as processed_at,
    f.first_fulfilled_at as first_fulfilled_at,
    extract(epoch from (f.first_fulfilled_at - o.processed_at)) / 3600.0 as fulfilment_hours,
    public.normalise_carrier(f.carrier_raw) as carrier,
    coalesce(array_length(o.tracking_numbers, 1), 0) as tracking_count,
    coalesce(f.fulfilment_count, 0) as fulfilment_count,
    o.shipping_destination ->> 'countryCode' as destination_country,
    o.total_price as total_price,
    o.delivered_at as delivered_at,
    -- The tail of the journey: what came back. `return_status` is Shopify's own
    -- enum and is populated on every order, so `NO_RETURN` is a recorded fact
    -- rather than a missing value -- which is the only reason a returns count
    -- off this view can be trusted at zero.
    o.total_refunded as total_refunded,
    o.return_status as return_status,
    -- The handle, not the label: `sales_channel` is a display string Shopify can
    -- restyle ('Amazon', 'Amazon by CedCommerce'), while the handle is the stable
    -- key a filter can be written against. Both travel so a panel can match on
    -- one and print the other.
    o.sales_channel_handle as channel,
    o.sales_channel as channel_label,
    date_trunc('month', o.processed_at)::date as processed_month
  from public.orders o
  left join lateral (
    select
      min(nullif(e.value ->> 'created_at', '')::timestamptz) as first_fulfilled_at,
      count(*) as fulfilment_count,
      min(t.value ->> 'company') as carrier_raw
    from jsonb_array_elements(o.fulfillments) as e
    left join lateral jsonb_array_elements(
      case when jsonb_typeof(e.value -> 'tracking_info') = 'array'
        then e.value -> 'tracking_info'
        else '[]'::jsonb
      end
    ) as t on true
  ) f on true
  where o.deleted_at is null;

revoke all on public.order_fulfilment_timing from anon, authenticated;

comment on view public.order_fulfilment_timing is
  'One row per live order with its fulfilment duration in hours, normalised carrier, tracking count, destination and sales channel. The base every fulfilment panel aggregate reads. Delivery duration is deliberately absent -- Shopify holds no delivery events for this store.';

-- ------------------------------------------------------- fulfilment_summary

-- The headline tiles, as one row. Percentiles cannot be averaged out of the
-- monthly view, so the overall figures are their own aggregate rather than
-- something the caller derives.
create view public.fulfilment_summary
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    count(*) as orders,
    count(*) filter (where t.fulfilment_hours is not null) as measured,
    percentile_cont(0.5) within group (order by t.fulfilment_hours) as p50_hours,
    percentile_cont(0.9) within group (order by t.fulfilment_hours) as p90_hours,
    avg(t.fulfilment_hours) as mean_hours,
    count(*) filter (where t.fulfilment_hours > 48) as over_48h,
    count(*) filter (where t.fulfilment_hours > 72) as over_72h,
    count(*) filter (where t.fulfilment_count > 0 and t.tracking_count = 0) as shipped_without_tracking,
    count(*) filter (where t.delivered_at is not null) as with_delivery_event,
    -- WHAT CAME BACK. Counted per order rather than summed off the refunds
    -- array: an order refunded twice is one unhappy order, and the money is
    -- carried separately by `refunded_amount` for anyone who wants the euros.
    -- `returns_opened` is a *separate* count and not folded into the refund one,
    -- because a return and a refund are different events and this store records
    -- 3 of the second and 0 of the first -- a combined figure would hide exactly
    -- the thing worth noticing.
    count(*) filter (where t.total_refunded > 0) as refunded_orders,
    count(*) filter (
      where t.total_refunded > 0 and t.total_price > 0 and t.total_refunded >= t.total_price
    ) as fully_refunded_orders,
    count(*) filter (
      where t.return_status is not null and t.return_status <> 'NO_RETURN'
    ) as returns_opened,
    coalesce(sum(t.total_refunded), 0) as refunded_amount,
    min(t.processed_at) as first_order_at,
    max(t.processed_at) as last_order_at
  from public.order_fulfilment_timing t
  group by t.shop_id;

revoke all on public.fulfilment_summary from anon, authenticated;

comment on view public.fulfilment_summary is
  'One row per shop: median, p90 and mean fulfilment hours, the counts past two and three days, and how many fulfilled orders went out with no tracking number. `with_delivery_event` is the coverage check on delivery data and reads 1 of 2,006 today. `refunded_orders` / `returns_opened` are the tail of the journey and read 3 and 0 of 2,006 -- the zero is a recorded NO_RETURN on every order, not a missing field, but a return handled outside Shopify is invisible to both.';

-- ------------------------------------------------------- fulfilment_by_month

create view public.fulfilment_by_month
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.processed_month as month,
    count(*) as orders,
    percentile_cont(0.5) within group (order by t.fulfilment_hours) as p50_hours,
    percentile_cont(0.9) within group (order by t.fulfilment_hours) as p90_hours,
    count(*) filter (where t.fulfilment_hours > 72) as over_72h,
    count(*) filter (where t.fulfilment_hours is not null) as measured
  from public.order_fulfilment_timing t
  where t.processed_month is not null
  group by t.shop_id, t.processed_month;

revoke all on public.fulfilment_by_month from anon, authenticated;

comment on view public.fulfilment_by_month is
  'Fulfilment timing per calendar month -- the trend that shows July 2026 degrading to 30.7% over three days against a steady 4-14%. The caller marks the current month as partial; the view does not, because "partial" depends on when it is read.';

-- ------------------------------------------------------ fulfilment_by_carrier

-- CONTACT RATE IS COUNTED PER ORDER, NOT PER TICKET. `orders_with_ticket` is how
-- many of this carrier's shipments produced at least one ticket; `tickets` is the
-- raw thread count beside it. Dividing threads by shipments would let one order
-- that was chased four times read as four unhappy deliveries, and on a 6-shipment
-- carrier that arithmetic produces a contact rate over 100%.
--
-- The join is `tickets.shopify_order_number` -> the order's name, which is the
-- ONLY confirmed link between a thread and a parcel. It is also a partial one:
-- the resolver has confirmed a number on a minority of threads, so both columns
-- are floors. `fulfilment_ticket_coverage` below carries the denominator that
-- says how partial, and the panel is required to show it beside these figures.
create view public.fulfilment_by_carrier
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.carrier as carrier,
    count(*) as shipments,
    percentile_cont(0.5) within group (order by t.fulfilment_hours) as p50_hours,
    count(*) filter (where t.fulfilment_hours > 72) as over_72h,
    count(*) filter (where t.tracking_count = 0) as without_tracking,
    count(*) filter (where k.tickets > 0) as orders_with_ticket,
    coalesce(sum(k.tickets), 0) as tickets
  from public.order_fulfilment_timing t
  left join lateral (
    select count(*) as tickets
    from public.tickets k
    where k.shop_id = t.shop_id
      and k.deleted_at is null
      and k.shopify_order_number = t.order_name
  ) k on true
  where t.carrier is not null
  group by t.shop_id, t.carrier;

revoke all on public.fulfilment_by_carrier from anon, authenticated;

comment on view public.fulfilment_by_carrier is
  'Shipments and fulfilment timing per normalised carrier, plus how many of those shipments the desk was contacted about. Reads through normalise_carrier(), so Colissimo is one row rather than three. `orders_with_ticket` counts orders, not threads -- see the view body.';

-- ------------------------------------------------ fulfilment_ticket_coverage

-- The denominator behind the contact-rate column, and the reason it exists.
--
-- A ticket joins to a parcel only through `shopify_order_number`, which the
-- order-number resolver fills in and which most threads do not carry: a customer
-- writes "my parcel has not arrived" far more often than they quote #5337. So a
-- per-carrier contact rate is a FLOOR, and the size of the gap is a fact the
-- panel has to state rather than a caveat someone remembers to add. One row per
-- shop, read beside the carrier table.
create view public.fulfilment_ticket_coverage
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    count(*) as tickets,
    count(*) filter (where t.shopify_order_number is not null) as with_order_number
  from public.tickets t
  where t.deleted_at is null
  group by t.shop_id;

revoke all on public.fulfilment_ticket_coverage from anon, authenticated;

comment on view public.fulfilment_ticket_coverage is
  'How many tickets carry a resolved order number, out of all of them -- the coverage figure that turns the per-carrier contact rate from a claim into a floor. Reads 52 of 214 today.';

-- ------------------------------------------------------- fulfilment_by_bucket

-- The histogram, bucketed in SQL so the panel renders a result set of six rows
-- rather than reading two thousand orders to count them.
create view public.fulfilment_by_bucket
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    case
      when t.fulfilment_hours < 12 then '<12h'
      when t.fulfilment_hours < 24 then '12-24h'
      when t.fulfilment_hours < 48 then '24-48h'
      when t.fulfilment_hours < 72 then '48-72h'
      when t.fulfilment_hours < 96 then '72-96h'
      else '>96h'
    end as bucket,
    case
      when t.fulfilment_hours < 12 then 1
      when t.fulfilment_hours < 24 then 2
      when t.fulfilment_hours < 48 then 3
      when t.fulfilment_hours < 72 then 4
      when t.fulfilment_hours < 96 then 5
      else 6
    end as bucket_order,
    count(*) as orders
  from public.order_fulfilment_timing t
  where t.fulfilment_hours is not null
  group by t.shop_id, 2, 3;

revoke all on public.fulfilment_by_bucket from anon, authenticated;

comment on view public.fulfilment_by_bucket is
  'The fulfilment-time histogram in six fixed buckets, with a sort key so the panel does not have to know the order. Buckets straddle the three-day line deliberately: 72-96h and >96h are the two the business cares about.';

-- --------------------------------------------------- fulfilment BY CHANNEL

-- The same three aggregates again, cut by sales channel.
--
-- WHY A SECOND SET RATHER THAN A CHANNEL COLUMN ON THE FIRST. The existing three
-- views are what "the whole book" means, and every caller reads them as one row
-- per shop. Adding `channel` to their group-by would silently turn each of them
-- into several rows and every current reader would start reporting one channel's
-- figures as the store's. These are additive: the originals keep their shape.
--
-- GROUPED BY CHANNEL, NOT FILTERED TO ONE. Amazon is the channel that prompted
-- this -- a marketplace dispatches under someone else's clock and its delay is
-- only legible against the store's own -- but which channel matters is a
-- business question, and the moment 'amazon' is written into a where-clause the
-- schema owns that answer. The caller picks the channel; the view knows the
-- shape. Four channels exist today, so this stays a handful of rows.
--
-- Percentiles are recomputed per channel rather than derived: a median cannot be
-- averaged out of a coarser one.

create view public.fulfilment_summary_by_channel
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.channel as channel,
    max(t.channel_label) as channel_label,
    count(*) as orders,
    count(*) filter (where t.fulfilment_hours is not null) as measured,
    percentile_cont(0.5) within group (order by t.fulfilment_hours) as p50_hours,
    percentile_cont(0.9) within group (order by t.fulfilment_hours) as p90_hours,
    avg(t.fulfilment_hours) as mean_hours,
    count(*) filter (where t.fulfilment_hours > 48) as over_48h,
    count(*) filter (where t.fulfilment_hours > 72) as over_72h,
    count(*) filter (where t.fulfilment_count > 0 and t.tracking_count = 0) as shipped_without_tracking,
    count(*) filter (where t.delivered_at is not null) as with_delivery_event,
    -- Kept in step with fulfilment_summary above, column for column. The two
    -- back the same TypeScript type and render through the same component, so a
    -- column on one and not the other is a channel section quietly reporting
    -- zero for a figure it never selected.
    count(*) filter (where t.total_refunded > 0) as refunded_orders,
    count(*) filter (
      where t.total_refunded > 0 and t.total_price > 0 and t.total_refunded >= t.total_price
    ) as fully_refunded_orders,
    count(*) filter (
      where t.return_status is not null and t.return_status <> 'NO_RETURN'
    ) as returns_opened,
    coalesce(sum(t.total_refunded), 0) as refunded_amount,
    min(t.processed_at) as first_order_at,
    max(t.processed_at) as last_order_at
  from public.order_fulfilment_timing t
  where t.channel is not null
  group by t.shop_id, t.channel;

revoke all on public.fulfilment_summary_by_channel from anon, authenticated;

comment on view public.fulfilment_summary_by_channel is
  'fulfilment_summary cut by sales channel handle -- one row per channel per shop, same columns plus the display label. Read with a channel filter; the whole-store figures stay in fulfilment_summary.';

create view public.fulfilment_by_channel_month
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.channel as channel,
    t.processed_month as month,
    count(*) as orders,
    percentile_cont(0.5) within group (order by t.fulfilment_hours) as p50_hours,
    percentile_cont(0.9) within group (order by t.fulfilment_hours) as p90_hours,
    count(*) filter (where t.fulfilment_hours > 72) as over_72h,
    count(*) filter (where t.fulfilment_hours is not null) as measured
  from public.order_fulfilment_timing t
  where t.processed_month is not null
    and t.channel is not null
  group by t.shop_id, t.channel, t.processed_month;

revoke all on public.fulfilment_by_channel_month from anon, authenticated;

comment on view public.fulfilment_by_channel_month is
  'fulfilment_by_month cut by sales channel handle. A channel that sold nothing in a month has no row rather than a zero one, so the caller reads a shorter series than the store-wide trend and must not assume the two align month for month.';

create view public.fulfilment_by_channel_bucket
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.channel as channel,
    case
      when t.fulfilment_hours < 12 then '<12h'
      when t.fulfilment_hours < 24 then '12-24h'
      when t.fulfilment_hours < 48 then '24-48h'
      when t.fulfilment_hours < 72 then '48-72h'
      when t.fulfilment_hours < 96 then '72-96h'
      else '>96h'
    end as bucket,
    case
      when t.fulfilment_hours < 12 then 1
      when t.fulfilment_hours < 24 then 2
      when t.fulfilment_hours < 48 then 3
      when t.fulfilment_hours < 72 then 4
      when t.fulfilment_hours < 96 then 5
      else 6
    end as bucket_order,
    count(*) as orders
  from public.order_fulfilment_timing t
  where t.fulfilment_hours is not null
    and t.channel is not null
  group by t.shop_id, t.channel, 3, 4;

revoke all on public.fulfilment_by_channel_bucket from anon, authenticated;

comment on view public.fulfilment_by_channel_bucket is
  'fulfilment_by_bucket cut by sales channel handle, in the same six fixed buckets with the same sort key -- identical boundaries on purpose, so a channel histogram can be read straight against the store one.';

-- ============================================================================
-- SUPPORT
-- ============================================================================

-- --------------------------------------------------------- ticket_reply_times

-- How long the desk took to answer first, per ticket.
--
-- The anchor is the ticket's earliest INBOUND message and the response is the
-- earliest OUTBOUND message after it -- not simply the earliest outbound, which
-- on a reopened thread would be a reply to a previous question and would score
-- the new one as answered before it was asked.
--
-- Only tickets the desk has actually replied to from the synced mailbox get a
-- row. That is a real denominator caveat and the panel states it rather than
-- quietly averaging over whatever happens to be present.
create view public.ticket_reply_times
with (security_invoker = true) as
  select
    t.id as ticket_id,
    t.shop_id as shop_id,
    fi.received_at as first_inbound_at,
    o.first_outbound_at as first_outbound_at,
    extract(epoch from (o.first_outbound_at - fi.received_at)) / 3600.0 as reply_hours,
    date_trunc('month', fi.received_at)::date as inbound_month
  from public.tickets t
  join public.ticket_first_inbound fi on fi.ticket_id = t.id
  left join lateral (
    select min(coalesce(m.sent_at, m.received_at)) as first_outbound_at
    from public.ticket_messages m
    where m.ticket_id = t.id
      and m.direction = 'outbound'
      and m.deleted_at is null
      and coalesce(m.sent_at, m.received_at) > fi.received_at
  ) o on true
  where t.deleted_at is null;

revoke all on public.ticket_reply_times from anon, authenticated;

comment on view public.ticket_reply_times is
  'First-response time per ticket: earliest inbound to the earliest outbound that came after it. `reply_hours` is null on a ticket the desk has not answered from the synced mailbox, which is the denominator the panel has to declare.';

-- ------------------------------------------------------------ support_by_month

create view public.support_by_month
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    date_trunc('month', t.first_message_at)::date as month,
    count(*) as tickets,
    count(*) filter (where t.happiness >= 3) as unhappy,
    count(*) filter (where t.happiness = 4) as very_unhappy,
    count(*) filter (where t.level = 3) as level_three,
    count(*) filter (where t.status not in ('resolved', 'closed')) as still_open,
    avg(t.happiness) as mean_happiness,
    percentile_cont(0.5) within group (order by r.reply_hours) as p50_reply_hours,
    count(*) filter (where r.reply_hours is not null and r.reply_hours <= 24) as replied_within_24h,
    count(*) filter (where r.reply_hours is not null) as replies_measured
  from public.tickets t
  left join public.ticket_reply_times r on r.ticket_id = t.id
  where t.deleted_at is null
    and t.first_message_at is not null
  group by t.shop_id, 2;

revoke all on public.support_by_month from anon, authenticated;

comment on view public.support_by_month is
  'Monthly support intake with the mood and reply-time facts already folded in. Months with no ingested mail are absent rather than zero -- the panel draws that distinction, because an honest zero and missing data look identical on a chart.';

-- --------------------------------------------------------- support_by_category

create view public.support_by_category
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.category as category,
    t.request_kind as request_kind,
    count(*) as tickets,
    count(*) filter (where t.status not in ('resolved', 'closed')) as still_open,
    count(*) filter (where t.happiness >= 3) as unhappy,
    count(*) filter (where t.level = 3) as level_three,
    avg(t.happiness) as mean_happiness
  from public.tickets t
  where t.deleted_at is null
  group by t.shop_id, t.category, t.request_kind;

revoke all on public.support_by_category from anon, authenticated;

comment on view public.support_by_category is
  'Volume and mood per (subject, kind) pair -- the two taxonomy axes kept separate, as everywhere else. Delivery reads mean happiness 2.89 with 76% unhappy, the worst of the fourteen subjects.';

-- ------------------------------------------------------- support_purchase_states

-- WHO IS WRITING TO US, BY WHETHER WE CAN SEE THEM BUY.
--
-- Three populations, and the middle one is why this view exists:
--   the sender's address matches a customer WITH orders      -- an online buyer
--   it matches a customer with NONE                          -- newsletter signup,
--                                                               Shop login, or an
--                                                               address captured at
--                                                               a till
--   it matches nothing                                       -- unplaceable
--
-- THE COUNTS ARE RAW, THE NAMES ARE NOT HERE. `purchase-verification.mjs` owns
-- what `known_no_orders` means and what a reply may say about it; this view only
-- counts orders and reachability flags, the same way `support_by_category`
-- counts `happiness >= 3` without owning the word "unhappy". A view that emitted
-- the state names would be a second definition to disagree with the first.
--
-- A ZERO-ORDER CUSTOMER IS NOT A NON-CUSTOMER. A sale made in a physical shop
-- never reaches Shopify, so this population includes people holding the product
-- -- three of them have written a Judge.me product review. Any caller rendering
-- these figures has to say so; see DECISIONS.md.
create view public.support_purchase_states
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    count(*) as tickets,
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) > 0)
      as buyer_tickets,
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) = 0)
      as no_order_tickets,
    count(*) filter (where t.customer_id is null) as unknown_tickets,
    -- DISTINCT PEOPLE, not threads. One person who writes four times is one
    -- person to reach, and an outreach list built from the ticket count would be
    -- four times too long.
    count(distinct c.id) filter (where coalesce(c.number_of_orders, 0) = 0)
      as no_order_customers,
    -- TWO SENSES OF "REACHABLE", BOTH REPORTED, because they answer different
    -- questions and this store's numbers differ. `deliverable` is Shopify's own
    -- judgement that the address works at all -- the operational sense. `marketable`
    -- is consent to be sent marketing, which is the only one that makes an
    -- outreach campaign lawful.
    count(distinct c.id) filter (
      where coalesce(c.number_of_orders, 0) = 0 and c.valid_email_address is true
    ) as no_order_deliverable,
    count(distinct c.id) filter (
      where coalesce(c.number_of_orders, 0) = 0 and c.on_email_marketing_list is true
    ) as no_order_marketable
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  where t.deleted_at is null
  group by t.shop_id;

revoke all on public.support_purchase_states from anon, authenticated;

comment on view public.support_purchase_states is
  'Tickets split by whether the sender can be seen to have bought online: buyer_tickets / no_order_tickets / unknown_tickets, plus DISTINCT people behind the middle group and how many of them are reachable. `deliverable` is a usable address, `marketable` is marketing consent -- different questions, both reported. Reads 111 / 34 / 69 tickets today. A zero-order customer is not a non-customer: a shop sale never reaches Shopify.';

-- --------------------------------------------------- support_purchase_by_category

-- The same split, per subject, so "what do the people we cannot verify actually
-- write about" is answerable. Ticket counts only -- they sum across rows, while
-- a distinct-customer count would double-count anyone who wrote under two
-- subjects, which is why those live in the shop-level view above and not here.
create view public.support_purchase_by_category
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.category as category,
    count(*) as tickets,
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) > 0)
      as buyer_tickets,
    count(*) filter (where t.customer_id is not null and coalesce(c.number_of_orders, 0) = 0)
      as no_order_tickets,
    count(*) filter (where t.customer_id is null) as unknown_tickets
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  where t.deleted_at is null
  group by t.shop_id, t.category;

revoke all on public.support_purchase_by_category from anon, authenticated;

comment on view public.support_purchase_by_category is
  'support_purchase_states cut by subject. Ticket counts only, so rows sum; distinct-customer counts stay in the shop-level view because one person can write under several subjects.';

-- ============================================================================
-- CUSTOMERS
-- ============================================================================

-- ------------------------------------------------------ customer_ticket_facts

-- One row per ticket that resolves to a customer, carrying the segment and the
-- spend behind it.
--
-- IT EXPOSES `rfm_group`, NOT `is_vip`. Who counts as a VIP is a business rule
-- that lives in `customer-segments.mjs` and is applied at read time by the
-- service; encoding it here would freeze a rule that changes with the business
-- into a schema object, and would put a second definition of VIP in the codebase
-- the first time it moved.
create view public.customer_ticket_facts
with (security_invoker = true) as
  select
    t.id as ticket_id,
    t.shop_id as shop_id,
    t.category as category,
    t.level as level,
    t.happiness as happiness,
    t.status as status,
    t.first_message_at as first_message_at,
    c.id as customer_id,
    c.display_name as customer_display_name,
    c.rfm_group as rfm_group,
    c.number_of_orders as number_of_orders,
    c.amount_spent as amount_spent,
    c.last_order_at as last_order_at,
    c.on_email_marketing_list as on_email_marketing_list,
    c.default_address_country_code as country_code
  from public.tickets t
  join public.customers c on c.id = t.customer_id
  where t.deleted_at is null
    and c.deleted_at is null;

revoke all on public.customer_ticket_facts from anon, authenticated;

comment on view public.customer_ticket_facts is
  'One row per ticket linked to a customer, with that customer''s segment, lifetime spend and marketing state joined on. Bounded by ticket count, so the service reads it whole and applies the VIP rule in JavaScript rather than the view asserting one.';

-- --------------------------------------------------- customer_segment_totals

-- The whole customer base by segment, aggregated in SQL because it is 58,201
-- rows and reading them to count them is precisely the mistake this file exists
-- to prevent.
create view public.customer_segment_totals
with (security_invoker = true) as
  select
    c.shop_id as shop_id,
    c.rfm_group as rfm_group,
    count(*) as customers,
    count(*) filter (where c.number_of_orders > 0) as buyers,
    count(*) filter (where c.number_of_orders > 1) as repeat_buyers,
    count(*) filter (where c.on_email_marketing_list) as marketing_opted_in,
    sum(c.amount_spent) as total_spent
  from public.customers c
  where c.deleted_at is null
  group by c.shop_id, c.rfm_group;

revoke all on public.customer_segment_totals from anon, authenticated;

comment on view public.customer_segment_totals is
  'The customer base by RFM segment, with the buyer count beside the customer count. Both denominators are here on purpose: 53,942 of 58,201 customers have never ordered, so a percentage quoted against the wrong one is meaningless.';

-- ============================================================================
-- AGENT
-- ============================================================================

-- ------------------------------------------------ investigation_evidence_gaps

-- Which fact the agent could not get, ranked.
--
-- The single most useful thing this schema can tell you: it is the system
-- reporting its own blockers, so the leaderboard is a prioritised build list
-- rather than an opinion. Unnested from the jsonb the investigation writes,
-- guarded on `jsonb_typeof` so a malformed row skips rather than failing the
-- whole view.
create view public.investigation_evidence_gaps
with (security_invoker = true) as
  select
    i.shop_id as shop_id,
    g.value ->> 'need' as need,
    g.value ->> 'state' as state,
    g.value ->> 'finding' as finding,
    count(*) as occurrences,
    count(distinct i.ticket_id) as tickets
  from public.ticket_investigations i
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(i.evidence_gaps) = 'array' then i.evidence_gaps else '[]'::jsonb end
  ) as g
  group by i.shop_id, 2, 3, 4;

revoke all on public.investigation_evidence_gaps from anon, authenticated;

comment on view public.investigation_evidence_gaps is
  'Every evidence need the investigation recorded, with how often it came up and on how many tickets. Ranked, this is the agent telling you which missing fact blocks the most mail -- today order_identity, promotion_identity and promotion_validity.';

-- ---------------------------------------------------- agent_pipeline_funnel

-- The resolution funnel as one row: how far tickets actually get.
--
-- Each stage is a count over the same denominator rather than a chain of
-- filtered subqueries, so the drop-offs are directly comparable and the panel
-- does not have to make five round trips to draw one chart.
create view public.agent_pipeline_funnel
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    count(*) as tickets,
    count(*) filter (where t.categorised_at is not null) as categorised,
    count(*) filter (where t.customer_id is not null) as customer_linked,
    count(*) filter (where t.shopify_order_number is not null) as order_linked,
    count(*) filter (where t.context_resolved_at is not null) as context_built,
    count(*) filter (where t.investigated_at is not null) as investigated,
    count(*) filter (where t.categorisation_confidence = 'low') as low_confidence,
    count(*) filter (where t.needs_categorisation) as awaiting_categorisation,
    count(*) filter (where t.needs_investigation) as awaiting_investigation
  from public.tickets t
  where t.deleted_at is null
  group by t.shop_id;

revoke all on public.agent_pipeline_funnel from anon, authenticated;

comment on view public.agent_pipeline_funnel is
  'One row per shop counting how far tickets get through the pipeline: categorised -> customer linked -> order linked -> context built -> investigated. The order-linked drop-off is the binding constraint on every metric that crosses email with commerce.';

-- --------------------------------------------------- investigation_verdicts

create view public.investigation_verdicts
with (security_invoker = true) as
  select
    i.shop_id as shop_id,
    i.verdict as verdict,
    count(*) as investigations,
    count(distinct i.ticket_id) as tickets,
    count(*) filter (where i.handoff is not null) as with_handoff
  from public.ticket_investigations i
  group by i.shop_id, i.verdict;

revoke all on public.investigation_verdicts from anon, authenticated;

comment on view public.investigation_verdicts is
  'Case files by verdict. The `answerable` share is the honest automation ceiling -- what the agent could have replied to unaided -- and is the number to watch weekly rather than any accuracy score.';

-- -------------------------------------------------------- llm_usage_by_month

create view public.llm_usage_by_month
with (security_invoker = true) as
  select
    u.shop_id as shop_id,
    date_trunc('month', u.occurred_at)::date as month,
    u.model as model,
    u.pass as pass,
    sum(u.call_count) as calls,
    sum(u.input_tokens) as input_tokens,
    sum(u.output_tokens) as output_tokens,
    sum(u.total_tokens) as total_tokens,
    count(*) filter (where not u.succeeded) as failed_calls
  from public.llm_usage u
  group by u.shop_id, 2, u.model, u.pass;

revoke all on public.llm_usage_by_month from anon, authenticated;

comment on view public.llm_usage_by_month is
  'Token spend per month, model and pass. Money is not here: the panel multiplies these by a rate held in config, so a price change restates history instead of invalidating it.';

-- --------------------------------------------------------- llm_usage_summary

-- The four figures the cost tiles show, including the two that need a per-ticket
-- rollup first -- hence the subquery rather than a plain aggregate.
create view public.llm_usage_summary
with (security_invoker = true) as
  select
    s.shop_id as shop_id,
    sum(s.ticket_tokens) as total_tokens,
    sum(s.ticket_input) as input_tokens,
    sum(s.ticket_output) as output_tokens,
    sum(s.ticket_calls) as calls,
    count(*) filter (where s.ticket_id is not null) as tickets_touched,
    avg(s.ticket_tokens) filter (where s.ticket_id is not null) as mean_tokens_per_ticket,
    max(s.ticket_tokens) filter (where s.ticket_id is not null) as max_tokens_on_a_ticket,
    min(s.first_at) as first_recorded_at,
    max(s.last_at) as last_recorded_at
  from (
    select
      u.shop_id as shop_id,
      u.ticket_id as ticket_id,
      sum(u.total_tokens) as ticket_tokens,
      sum(u.input_tokens) as ticket_input,
      sum(u.output_tokens) as ticket_output,
      sum(u.call_count) as ticket_calls,
      min(u.occurred_at) as first_at,
      max(u.occurred_at) as last_at
    from public.llm_usage u
    group by u.shop_id, u.ticket_id
  ) s
  group by s.shop_id;

revoke all on public.llm_usage_summary from anon, authenticated;

comment on view public.llm_usage_summary is
  'One row per shop: total tokens and calls, plus the mean and worst per-ticket token counts. The per-ticket rollup happens in the subquery because an average of per-call rows would answer a different question from the one the tile asks.';
