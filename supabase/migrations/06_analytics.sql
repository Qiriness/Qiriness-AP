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
  -- HOW MUCH OF `input_tokens` THE PROVIDER SERVED FROM ITS PROMPT CACHE.
  --
  -- A SUBSET OF `input_tokens`, NOT AN ADDITION TO IT. OpenAI counts cached
  -- tokens inside `prompt_tokens`, so the two must never be summed — this says
  -- how many of the input tokens were billed at the reduced rate.
  --
  -- WHY IT IS WORTH A COLUMN. Input is 76% of the bill at 12.5 input tokens per
  -- output token, so the prompt cache is the largest single lever on cost — and
  -- without this field nothing distinguishes a cache working perfectly from one
  -- that never engages. Every cost calculation in codex_plans/Model_Cost_Notes.md
  -- is arithmetic over an assumption until this column has data in it.
  --
  -- ZERO IS A REAL ANSWER, and the common one: caching needs a stable prefix
  -- above a minimum length, and a prompt whose first ticket-specific token comes
  -- early can never earn it.
  cached_input_tokens integer not null default 0,
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
    pass in ('spam', 'categorise', 'decompose', 'situation', 'investigate', 'draft', 'embed', 'other')
  ),
  constraint llm_usage_input_tokens_check check (input_tokens >= 0),
  -- Deliberately NOT `<= input_tokens`. Usage is bookkeeping riding beside real
  -- work, and a provider reporting an unexpected shape must cost a ticket
  -- nothing — a refused insert here would fail the batch that carries it.
  constraint llm_usage_cached_input_tokens_check check (cached_input_tokens >= 0),
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

-- -------------------------------------------------------- agent: situations

-- How the investigation picked a situation, per ticket: its LATEST run among
-- the runs made in the range, so a re-investigated ticket is counted once, as
-- it stands. Read from `ticket_investigations.exemplar_match`, where the
-- verdict stays what the embedding said and `chosen_by` / `resolved_from` /
-- `chooser` say who supplied the key (DECISIONS.md § "A near miss is settled by
-- a model"). The buckets partition the tickets:
--   matched            the matcher committed (score 0.65+)
--   tie_by_rules       a tie the rules made free to settle (`resolved_from`)
--   chosen_by_model    a near miss or tie the situation chooser settled
--   near_chooser_none  a near miss or tie the chooser was asked and said none
--   near_not_settled   a near miss or tie with no key and no "none": not asked
--                      (chooser off, our own side, run before it shipped) or failed
--   no_match           nothing scored close enough to choose between
--   not_recorded       no verdict: the matcher failed or was not wired
-- Always one row.
create or replace function public.insights_agent_situations(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  tickets bigint,
  matched bigint,
  tie_by_rules bigint,
  chosen_by_model bigint,
  near_chooser_none bigint,
  near_not_settled bigint,
  no_match bigint,
  not_recorded bigint
)
language sql
stable
set search_path = public
as $$
  with latest as (
    select distinct on (i.ticket_id)
      i.exemplar_match as m
    from public.ticket_investigations i
    where i.shop_id = p_shop
      and i.created_at >= (p_from at time zone p_tz)
      and i.created_at < (p_to at time zone p_tz)
    order by i.ticket_id, i.created_at desc
  )
  select
    count(*),
    count(*) filter (where m->>'verdict' = 'matched'),
    count(*) filter (
      where m->>'verdict' = 'ambiguous'
        and m->>'exemplar_key' is not null
        and m->>'chosen_by' is distinct from 'model'
    ),
    count(*) filter (where m->>'verdict' in ('near', 'ambiguous') and m->>'chosen_by' = 'model'),
    count(*) filter (
      where m->>'verdict' in ('near', 'ambiguous')
        and m->>'exemplar_key' is null
        and m->'chooser'->>'choice' = 'none'
    ),
    count(*) filter (
      where m->>'verdict' in ('near', 'ambiguous')
        and m->>'exemplar_key' is null
        and coalesce(m->'chooser'->>'choice', '') <> 'none'
    ),
    count(*) filter (where m->>'verdict' = 'none'),
    count(*) filter (
      where m->>'verdict' is null
        or m->>'verdict' not in ('matched', 'near', 'ambiguous', 'none')
    )
  from latest;
$$;

revoke all on function public.insights_agent_situations from public, anon, authenticated;
grant execute on function public.insights_agent_situations to service_role;

comment on function public.insights_agent_situations is
  'How each ticket investigated in a date range got its situation (latest run per ticket): matched, tie settled by rules, near miss chosen by the model, chooser said none, not settled, no match, not recorded. Always one row.';

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

-- ============================================================================
-- THE VIP RULE
-- ============================================================================
--
-- Who counts as a VIP is set by the shop, on the Customers panel: three
-- numbers on `shops` (vip_min_spend, vip_min_orders, vip_window_months), read
-- by scripts/lib/vip-rule.mjs and passed in here. The rule itself — how those
-- three combine — is written ONCE, in vip_customers() below, and every reader
-- (the ticket queue, the Customers panel, the agent's customer lookup) calls it.
--
-- BOTH CONDITIONS, NOT EITHER. A customer is a VIP when, inside the window,
-- their net spend is MORE THAN the minimum AND their order count is MORE THAN
-- the minimum. Strictly greater on both, because that is how the rule is stated
-- on the screen ("more than").
--
-- NET SPEND, UNCANCELLED ORDERS, NO MARKETPLACES. Spend is total_price minus
-- total_refunded, the same net revenue the Sales panel reports. Marketplace
-- channels (p_not_channels) are excluded because they mint one customer per
-- order: no marketplace buyer can ever repeat, and a real customer's Amazon
-- orders never reach their record anyway.
--
-- COMPUTED ON EVERY READ, NEVER STORED. The window rolls forward daily, so a
-- stored flag would be stale by tomorrow; and the rule changes whenever the
-- shop edits it. This replaces the RFM rule (CHAMPIONS + LOYAL) — see
-- DECISIONS.md § Tickets dashboard.

create or replace function public.vip_customers(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_customer_ids uuid[] default null
)
returns table (
  customer_id uuid,
  orders bigint,
  spend numeric
)
language sql
stable
set search_path = public
as $$
  with windowed as (
    select
      o.shopify_customer_id,
      count(*) as orders,
      coalesce(sum(o.total_price - coalesce(o.total_refunded, 0)), 0) as spend
    from public.orders o
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and o.shopify_customer_id is not null
      and o.processed_at >= now() - make_interval(months => p_window_months)
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
    group by 1
  )
  select c.id, w.orders, w.spend
  from windowed w
  join public.customers c
    on c.shop_id = p_shop
   and c.shopify_customer_id = w.shopify_customer_id
   and c.deleted_at is null
  where w.spend > p_min_spend
    and w.orders > p_min_orders
    and (p_customer_ids is null or c.id = any(p_customer_ids));
$$;

revoke all on function public.vip_customers from public, anon, authenticated;
grant execute on function public.vip_customers to service_role;

comment on function public.vip_customers is
  'THE VIP RULE: customers whose net spend AND order count inside the last p_window_months are both strictly greater than the minimums, uncancelled orders only, marketplace channels excluded. With their windowed orders and spend. Pass p_customer_ids to ask about specific customers.';

-- Which tickets belong to a VIP — the queue asks this once for the whole list,
-- because `ticket_queue` carries no customer id and the rule should not have to
-- be restated to ask it.
create or replace function public.vip_tickets(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_ticket_ids uuid[] default null
)
returns table (
  ticket_id uuid,
  customer_id uuid
)
language sql
stable
set search_path = public
as $$
  select t.id, t.customer_id
  from public.tickets t
  join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
    on v.customer_id = t.customer_id
  where t.shop_id = p_shop
    and t.deleted_at is null
    and (p_ticket_ids is null or t.id = any(p_ticket_ids));
$$;

revoke all on function public.vip_tickets from public, anon, authenticated;
grant execute on function public.vip_tickets to service_role;

comment on function public.vip_tickets is
  'Live tickets whose linked customer is a VIP under vip_customers(). One call marks a whole queue.';

-- How many customers the rule admits, beside how many ordered at all in the
-- same window — the denominator a VIP share is quoted against.
create or replace function public.vip_summary(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null
)
returns table (
  vip_customers bigint,
  buyers_in_window bigint
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*) from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels)),
    (
      select count(distinct o.shopify_customer_id)
      from public.orders o
      where o.shop_id = p_shop
        and o.deleted_at is null
        and o.cancelled_at is null
        and o.shopify_customer_id is not null
        and o.processed_at >= now() - make_interval(months => p_window_months)
        and (
          p_not_channels is null
          or o.sales_channel_handle is null
          or not (o.sales_channel_handle = any(p_not_channels))
        )
    );
$$;

revoke all on function public.vip_summary from public, anon, authenticated;
grant execute on function public.vip_summary to service_role;

comment on function public.vip_summary is
  'How many customers vip_customers() admits, and how many ordered at all in the same window.';

-- Orders still waiting to ship, oldest first, each marked VIP or not under the
-- shop's rule — the Fulfilment panel's list.
--
-- WAITING TO SHIP means Shopify has not called it FULFILLED (or RESTOCKED), and
-- the order is neither cancelled nor closed. Closed matters: six orders read
-- UNFULFILLED forever because they were refunded instead of shipped, and they
-- are not waiting for anything (measured 2026-09-11).
--
-- VIP COMES FROM vip_customers(), never restated here. With the thresholds null
-- (no rule set) it admits nobody and every row reads is_vip = false.
--
-- NOT RANGED. An order placed two months ago and still unshipped is the one
-- that matters most; the list is "now", as of the last order sync.
create or replace function public.open_orders(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  order_id uuid,
  order_name text,
  legacy_resource_id text,
  processed_at timestamptz,
  channel text,
  channel_label text,
  fulfillment_status text,
  total_price numeric,
  units bigint,
  customer_id uuid,
  customer_name text,
  customer_email text,
  is_vip boolean
)
language sql
stable
set search_path = public
as $$
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
      select coalesce(sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0)), 0)
      from jsonb_array_elements(
        case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
      ) as li
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
$$;

revoke all on function public.open_orders from public, anon, authenticated;
grant execute on function public.open_orders to service_role;

comment on function public.open_orders is
  'Orders not yet fulfilled (not cancelled, not closed), oldest first, with the buyer''s name and email and whether they are a VIP under vip_customers(). Current state as of the last order sync, not ranged.';

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

-- --------------------------------------------------------- sales: products

-- What sold, per product, for a range: distinct orders, units and net line
-- revenue, with the product's tags so the caller can fold products into the
-- groups it needs (gender is read off the catalogue tags in TypeScript -- a
-- judgement, so not here).
--
-- FREE LINES ARE NOT SALES. A line whose discounted total is zero is a sample or
-- a gift, and on this catalogue samples ride along on most orders: counted, they
-- would top every "best product by orders" list without a cent changing hands.
--
-- VIP ONLY. p_vip_only keeps orders from customers vip_customers() admits under
-- the shop's rule -- whose window is its own, not this range -- with the rule
-- passed by the caller; no threshold is compared here. Off by default, so every
-- caller that does not ask is unchanged.
create or replace function public.insights_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
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
  with vip_keys as (
    select c.shopify_customer_id as customer_key
    from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels) v
    join public.customers c
      on c.id = v.customer_id
    where coalesce(p_vip_only, false)
  )
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
    and (
      not coalesce(p_vip_only, false)
      or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
    )
  group by 1
  order by 6 desc;
$$;

revoke all on function public.insights_product_sales from public, anon, authenticated;
grant execute on function public.insights_product_sales to service_role;

comment on function public.insights_product_sales is
  'Per product for a date range: distinct orders, units and net line revenue, with catalogue tags. Zero-value lines (samples, gifts) are excluded. One row per product, so bounded by the catalogue. p_vip_only limits it to customers vip_customers() admits.';

-- ------------------------------------------------ sales: products by country

-- The same measure per destination country, top p_limit products per country by
-- p_metric ('revenue' or 'orders'). Ranked here because country x product is
-- thousands of rows before the cut, which is exactly the shape readView refuses.
--
-- VIP ONLY as in insights_product_sales: vip_customers() decides, the caller
-- passes the rule, and it is off by default.
create or replace function public.insights_country_product_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_metric text,
  p_limit integer,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
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
$$;

revoke all on function public.insights_country_product_sales from public, anon, authenticated;
grant execute on function public.insights_country_product_sales to service_role;

comment on function public.insights_country_product_sales is
  'Top p_limit products per destination country for a date range, ranked by revenue or orders, with each country''s own order count and net revenue. Zero-value lines excluded, as in insights_product_sales, and so is p_vip_only.';

-- -------------------------------------------------- sales: product customers

-- The Sales panel's product card: for ONE product, how the range's customers
-- split around it, and what else its buyers bought.
--
-- PEOPLE, NOT ORDERS. Every figure counts distinct Shopify customers who ordered
-- in the range, so the three buckets partition them: bought only this product,
-- bought it and something else, did not buy it. The caller removes marketplace
-- channels, which mint one customer per order and would make every buyer a
-- single-product customer.
--
-- FREE LINES ARE NOT PURCHASES. A line with a zero discounted total (a sample,
-- a promotional masque) is ignored on both sides: it neither makes a buyer
-- "with something else" nor appears in the ordered-with list, and a free unit
-- of the product itself does not make someone its buyer.
--
-- "ORDERED WITH" IS ACROSS THE RANGE, not within one order: the buckets have to
-- partition people, and a person with two orders cannot be split between them.
-- Top 7 other products by distinct buyers, product id breaking ties so the list
-- is stable between renders.
--
-- THE TWO FILTERS NARROW THE POPULATION, not just the buyers, because they sit
-- in `ranged_orders`: every figure -- the customer total included -- is then
-- about that group, and the three buckets still sum to it.
--   p_country  keeps orders delivered to that country, on the same expression
--              orders_list_facets() and insights_orders_by_country() group on
--              ('??' = no destination). A customer who ordered to two countries
--              is counted in each, on that country's orders only.
--   p_vip_only keeps customers vip_customers() admits under the shop's rule,
--              which looks back over its OWN window, not over this range. No
--              threshold is compared here.
--
-- ONE PRODUCT PER CALL, so the result is at most 7 rows. The first draft
-- returned every product's split at once -- up to 8 rows a product -- which
-- PostgREST's 1,000-row cap would have cut silently (DECISIONS.md § Insights).
create or replace function public.insights_product_customer_mix(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_product_id text,
  p_country text default null,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
  p_channels text[] default null,
  p_not_channels text[] default null
)
returns table (
  customers bigint,
  only_customers bigint,
  with_other_customers bigint,
  without_customers bigint,
  other_product_id text,
  other_title text,
  other_customers bigint,
  other_rank bigint
)
language sql
stable
set search_path = public
as $$
  with vip_keys as (
    select c.shopify_customer_id as customer_key
    from public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels) v
    join public.customers c
      on c.id = v.customer_id
    where coalesce(p_vip_only, false)
  ),
  ranged_orders as (
    select
      o.shopify_customer_id as customer_key,
      o.line_items
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
      and (p_country is null or coalesce(o.shipping_destination ->> 'country_code', '??') = p_country)
      and (
        not coalesce(p_vip_only, false)
        or o.shopify_customer_id in (select vk.customer_key from vip_keys vk)
      )
  ),
  paid_lines as (
    select
      ro.customer_key,
      li.value ->> 'product_id' as product_id,
      li.value ->> 'title' as line_title
    from ranged_orders ro
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(ro.line_items) = 'array' then ro.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
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
$$;

revoke all on function public.insights_product_customer_mix from public, anon, authenticated;
grant execute on function public.insights_product_customer_mix to service_role;

comment on function public.insights_product_customer_mix is
  'For one product over a date range: distinct Shopify customers who bought only that paid product, bought it with other paid products, or did not buy it (the three sum to customers), plus the top 7 other paid products its buyers bought, by distinct customer. Optional filters narrow the whole population: delivery country, and VIP only under vip_customers(). Zero-value lines are ignored; the caller excludes marketplace channels.';

-- -------------------------------------- sales: product orders per customer

-- The product card's distribution: among the customers who BOUGHT one product
-- in the range, how many bought it once, twice, three times…
--
-- THE POPULATION IS ITS BUYERS, not the range's customers. The split above
-- partitions everyone who ordered, and "did not order it" is its third bucket;
-- repeating that group here as a zero column would dwarf every other one and
-- say nothing the split has not already said. The columns therefore start at 1.
--
-- ORDERS CARRYING IT, NOT UNITS. Two jars in one order is one order, which is
-- what "orders" means on Customers -> Customers by number of orders, so the two
-- charts can be read side by side.
--
-- FREE LINES ARE NOT PURCHASES, as everywhere else in this card: an order that
-- carried the product only as a zero-value sample is not an order of it.
--
-- THE FILTERS ARE THE CARD'S, applied in `ranged_orders` exactly as the split
-- applies them, so both figures describe the same group of people. The caller
-- removes marketplace channels: one synthetic customer per order would put
-- every marketplace buyer in the "1" column.
--
-- One row per distinct order count, so at most as many rows as the busiest
-- buyer has orders; the caller folds the long tail into one "N or more" column.
create or replace function public.insights_product_orders_per_customer(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_product_id text,
  p_country text default null,
  p_vip_only boolean default false,
  p_min_spend numeric default null,
  p_min_orders integer default null,
  p_window_months integer default null,
  p_vip_not_channels text[] default null,
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
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(ro.line_items) = 'array' then ro.line_items else '[]'::jsonb end
    ) as li
    where li.value ->> 'product_id' = p_product_id
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
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
$$;

revoke all on function public.insights_product_orders_per_customer from public, anon, authenticated;
grant execute on function public.insights_product_orders_per_customer to service_role;

comment on function public.insights_product_orders_per_customer is
  'For one product over a date range: how many distinct Shopify customers placed 1, 2, 3... orders carrying a PAID line of it. One row per order count, buyers only (never-bought is the customer mix''s third bucket). Takes the same country and VIP-only filters as insights_product_customer_mix, so both describe the same group; the caller excludes marketplace channels.';
