-- ============================================================================
-- 07 — THE STOREFRONT AGENT'S ANALYTICS: TURNS, CHAT OPENS, ASSISTED ORDERS
--
-- WHAT THIS ADDS.
--   `storefront_agent_turns` — one row per customer message the storefront
--     advisor answered or failed to answer: how (the model, or the code alone),
--     how long it took, its tokens, tool calls and failures, the fallbacks it
--     took, whether a policy/FAQ question found nothing, whether it sent the
--     customer to customer service, what it was about (intent) and which
--     products it showed. Written by the storefront chat service
--     (turn-metrics.mjs) after the reply, never waited for. The chat log
--     (`storefront_chat_messages`) is purged after 30 days; this is what the
--     dashboard's 90 days and their comparison are read from. `user_message_id`
--     is unique: a turn is recorded once, live or by the backfill
--     (`npm run storefront:backfill-turns`), whichever comes first.
--   `storefront_agent_opens` — one row per opening of the chat panel. Its id is
--     minted by the widget, so a beacon sent twice is one row.
--   `orders.advisor_conversation_id` — the conversation whose « Ajouter au
--     panier » put a product in the cart that became this order, read from the
--     cart attribute `_advisor_conversation` the widget sets (lifted out of the
--     order like `tracking_numbers`). One order, one conversation: an order is
--     counted once whatever the number of conversations.
--   `storefront_agent_dashboard(…)` — the Storefront Agent dashboard over one
--     window, as one jsonb document: the conversations started in it, the turns
--     answered in it, the orders placed in it. Money is the order's net
--     (total − refunds), cancelled and deleted orders excluded, as on Sales.
--     Tokens are returned by model; the price is applied by the dashboard
--     (llm-rates.mjs), never stored.
--
-- NO WORDS, NO CUSTOMER. Codes, counts, durations and product ids only, so the
-- rows are kept like `advisory_events`, with no purge.
--
-- ASSISTED, NOT INCREMENTAL. An order carrying a conversation is ASSISTED
-- revenue: the advisor was part of the path. Whether it would have been bought
-- anyway needs a holdout; nothing here claims incrementality.
--
-- docs/decisions/storefront-advisor.md § The dashboard reads turns, not the chat log.
--
-- Requires: 06_manual_forwards.sql. Idempotent.
-- ============================================================================

create table if not exists public.storefront_agent_turns (
  id uuid default gen_random_uuid() not null,
  user_message_id uuid,
  shop_domain text not null,
  conversation_id uuid not null,
  status text not null,
  error_code text,
  route text not null,
  rule text,
  intent text not null,
  action text,
  model text,
  model_calls smallint default 0 not null,
  model_ms integer,
  input_tokens integer default 0 not null,
  output_tokens integer default 0 not null,
  tool_calls smallint default 0 not null,
  tool_failures smallint default 0 not null,
  fallbacks text[] default '{}'::text[] not null,
  unanswered boolean default false not null,
  escalated boolean default false not null,
  product_ids text[] default '{}'::text[] not null,
  latency_ms integer not null,
  backfilled boolean default false not null,
  created_at timestamp with time zone default now() not null,
  constraint storefront_agent_turns_pkey primary key (id),
  constraint storefront_agent_turns_message_unique unique (user_message_id),
  constraint storefront_agent_turns_status_check check (status in ('answered', 'failed')),
  constraint storefront_agent_turns_route_check check (route in ('llm', 'rules', 'mock')),
  constraint storefront_agent_turns_intent_check check (
    intent in ('routine_building', 'reordering', 'customer_service', 'faq', 'product_discovery', 'other')
  ),
  constraint storefront_agent_turns_fallbacks_check check (
    fallbacks <@ array['source_unavailable', 'forced_answer', 'lexicon_backup']::text[]
  ),
  constraint storefront_agent_turns_counts_check check (
    model_calls >= 0 and input_tokens >= 0 and output_tokens >= 0 and tool_calls >= 0
    and tool_failures >= 0 and latency_ms >= 0
  )
);

create index if not exists storefront_agent_turns_shop_time_idx
  on public.storefront_agent_turns (shop_domain, created_at);
create index if not exists storefront_agent_turns_conversation_idx
  on public.storefront_agent_turns (conversation_id, created_at);

alter table public.storefront_agent_turns enable row level security;
revoke all on public.storefront_agent_turns from anon, authenticated;

comment on table public.storefront_agent_turns is
  'One row per storefront advisor turn: route (llm / rules / mock), latency, tokens, tool calls and failures, fallbacks, unanswered, escalated, intent, products shown. No words, no customer. Written by the storefront chat service (turn-metrics.mjs); read by storefront_agent_dashboard.';

create table if not exists public.storefront_agent_opens (
  id uuid not null,
  shop_domain text not null,
  conversation_id uuid,
  created_at timestamp with time zone default now() not null,
  constraint storefront_agent_opens_pkey primary key (id)
);

create index if not exists storefront_agent_opens_shop_time_idx
  on public.storefront_agent_opens (shop_domain, created_at);

alter table public.storefront_agent_opens enable row level security;
revoke all on public.storefront_agent_opens from anon, authenticated;

comment on table public.storefront_agent_opens is
  'One row per opening of the storefront advisor panel; the id is minted by the widget, so a repeated beacon is one row. conversation_id when the browser already had a conversation.';

alter table public.orders add column if not exists advisor_conversation_id uuid;

create index if not exists orders_advisor_conversation_idx
  on public.orders (advisor_conversation_id) where advisor_conversation_id is not null;

comment on column public.orders.advisor_conversation_id is
  'The storefront advisor conversation (storefront_agent_turns.conversation_id) whose add to cart led to this order, from the cart attribute _advisor_conversation. Null for every order the advisor had no part in.';

-- Clicks and adds are looked up per conversation.
create index if not exists advisory_events_conversation_idx
  on public.advisory_events (conversation_ref, event_type);

-- ----------------------------------------------------------------------------
-- The dashboard over one window [p_from, p_to), wall-clock in p_tz, bucketed by
-- p_grain for its series. Conversations belong to the window they started in;
-- turns, opens and orders to the window they happened in.
-- ----------------------------------------------------------------------------

create or replace function public.storefront_agent_dashboard(
  p_shops text[],
  p_from timestamp without time zone,
  p_to timestamp without time zone,
  p_tz text,
  p_grain text
)
returns jsonb
language sql
stable
set search_path = public
as $$
with bounds as (
  select (p_from at time zone p_tz) as t0, (p_to at time zone p_tz) as t1
),
turns as (
  select t.*
  from storefront_agent_turns t, bounds b
  where t.shop_domain = any(p_shops) and t.created_at >= b.t0 and t.created_at < b.t1
),
started as (
  select t.conversation_id, min(t.created_at) as started_at
  from storefront_agent_turns t
  where t.shop_domain = any(p_shops)
  group by t.conversation_id
  having min(t.created_at) >= (select t0 from bounds) and min(t.created_at) < (select t1 from bounds)
),
conv_turns as (
  select t.* from storefront_agent_turns t join started s using (conversation_id)
),
intent_counts as (
  select conversation_id, intent, count(*) as n,
    array_position(array['routine_building', 'reordering', 'customer_service', 'faq', 'product_discovery', 'other'], intent) as priority
  from conv_turns group by conversation_id, intent
),
conv_intent as (
  -- The intent most of its turns had; `other` only when nothing else; ties by priority.
  select distinct on (conversation_id) conversation_id, intent
  from intent_counts
  order by conversation_id, (intent = 'other'), n desc, priority
),
clicks as (
  select e.conversation_ref, e.event_type, e.created_at, pid
  from advisory_events e, unnest(e.product_ids) as pid
  where e.shop_domain = any(p_shops) and e.channel = 'storefront_chat'
    and e.event_type in ('product_clicked', 'added_to_cart')
),
linked_orders as (
  select o.id, o.advisor_conversation_id as conversation_id,
    coalesce(o.processed_at, o.shopify_created_at) as placed_at,
    o.total_price - coalesce(o.total_refunded, 0) as revenue
  from orders o join shops s on s.id = o.shop_id
  where s.shop_domain = any(p_shops)
    and o.advisor_conversation_id is not null
    and o.deleted_at is null and o.cancelled_at is null
    -- Placed after the conversation began: an attribute older than the chat is not its sale.
    and exists (
      select 1 from storefront_agent_turns t
      where t.conversation_id = o.advisor_conversation_id and t.shop_domain = s.shop_domain
        and t.created_at <= coalesce(o.processed_at, o.shopify_created_at)
    )
),
window_orders as (
  select lo.* from linked_orders lo, bounds b where lo.placed_at >= b.t0 and lo.placed_at < b.t1
),
conv as (
  select
    s.conversation_id,
    s.started_at,
    ci.intent,
    count(*) as turns,
    (array_agg(t.status order by t.created_at desc))[1] = 'answered'
      and not bool_or(t.escalated) and not bool_or(t.unanswered) as resolved,
    bool_or(t.escalated) as escalated,
    bool_or(cardinality(t.product_ids) > 0) as shown,
    exists (select 1 from clicks c where c.conversation_ref = s.conversation_id::text and c.event_type = 'product_clicked') as clicked,
    exists (select 1 from clicks c where c.conversation_ref = s.conversation_id::text and c.event_type = 'added_to_cart') as carted,
    (select count(*) from linked_orders lo where lo.conversation_id = s.conversation_id) as orders,
    (select coalesce(sum(lo.revenue), 0) from linked_orders lo where lo.conversation_id = s.conversation_id) as revenue
  from started s
  join conv_turns t using (conversation_id)
  join conv_intent ci using (conversation_id)
  group by s.conversation_id, s.started_at, ci.intent
),
-- Each turn that showed products, and whether one of them was clicked / added
-- afterwards in the same conversation: what a route's click and cart rates read.
shown_turns as (
  select t.id, t.route,
    exists (
      select 1 from clicks c
      where c.conversation_ref = t.conversation_id::text and c.event_type = 'product_clicked'
        and c.created_at >= t.created_at and c.pid = any(t.product_ids)
    ) as clicked,
    exists (
      select 1 from clicks c
      where c.conversation_ref = t.conversation_id::text and c.event_type = 'added_to_cart'
        and c.created_at >= t.created_at and c.pid = any(t.product_ids)
    ) as carted
  from turns t
  where cardinality(t.product_ids) > 0
),
latency as (
  select
    percentile_cont(0.5) within group (order by latency_ms) as p50,
    percentile_cont(0.95) within group (order by latency_ms) as p95
  from turns where status = 'answered'
)
select jsonb_build_object(
  'coverage', jsonb_build_object(
    'turns_from', (select min(created_at) from storefront_agent_turns where shop_domain = any(p_shops)),
    'live_turns_from', (select min(created_at) from storefront_agent_turns where shop_domain = any(p_shops) and not backfilled),
    'opens_from', (select min(created_at) from storefront_agent_opens where shop_domain = any(p_shops)),
    -- Purchases are measurable only where this shop's orders are synced.
    'orders_synced', exists (
      select 1 from orders o join shops s on s.id = o.shop_id where s.shop_domain = any(p_shops)
    ),
    'linked_orders_from', (select min(placed_at) from linked_orders)
  ),
  'conversations', jsonb_build_object(
    'total', (select count(*) from conv),
    'resolved', (select count(*) from conv where resolved),
    'escalated', (select count(*) from conv where escalated),
    'shown', (select count(*) from conv where shown),
    'clicked', (select count(*) from conv where clicked),
    'carted', (select count(*) from conv where carted),
    'purchased', (select count(*) from conv where orders > 0)
  ),
  'opens', (select count(*) from storefront_agent_opens o, bounds b where o.shop_domain = any(p_shops) and o.created_at >= b.t0 and o.created_at < b.t1),
  'orders', jsonb_build_object(
    'count', (select count(*) from window_orders),
    'revenue', (select coalesce(sum(revenue), 0) from window_orders)
  ),
  'turns', (
    select jsonb_build_object(
      'total', count(*),
      'answered', count(*) filter (where status = 'answered'),
      'failed', count(*) filter (where status = 'failed'),
      'conversations', count(distinct conversation_id),
      'p50', (select p50 from latency),
      'p95', (select p95 from latency),
      'model_p50', percentile_cont(0.5) within group (order by model_ms) filter (where model_ms is not null),
      'model_p95', percentile_cont(0.95) within group (order by model_ms) filter (where model_ms is not null),
      'tool_calls', coalesce(sum(tool_calls), 0),
      'tool_failures', coalesce(sum(tool_failures), 0),
      'with_fallback', count(*) filter (where cardinality(fallbacks) > 0),
      'unanswered', count(*) filter (where unanswered),
      'escalated', count(*) filter (where escalated),
      'input_tokens', coalesce(sum(input_tokens), 0),
      'output_tokens', coalesce(sum(output_tokens), 0)
    )
    from turns
  ),
  'errors', coalesce((
    select jsonb_agg(jsonb_build_object('code', error_code, 'turns', n) order by n desc)
    from (select error_code, count(*) as n from turns where status = 'failed' group by error_code) x
  ), '[]'::jsonb),
  'fallbacks', coalesce((
    select jsonb_agg(jsonb_build_object('kind', kind, 'turns', n) order by n desc)
    from (select kind, count(*) as n from turns, unnest(fallbacks) as kind group by kind) x
  ), '[]'::jsonb),
  'tokens', coalesce((
    select jsonb_agg(jsonb_build_object('route', route, 'intent', intent, 'model', model,
      'input', input, 'output', output))
    from (
      select t.route, coalesce(ci.intent, t.intent) as intent, t.model,
        sum(t.input_tokens) as input, sum(t.output_tokens) as output
      from turns t left join conv_intent ci using (conversation_id)
      where t.model is not null
      group by t.route, coalesce(ci.intent, t.intent), t.model
    ) x
  ), '[]'::jsonb),
  'routes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'route', r.route, 'turns', r.turns, 'failed', r.failed, 'resolved', r.resolved,
      'p50', r.p50, 'p95', r.p95,
      'shown', coalesce(st.shown, 0), 'clicked', coalesce(st.clicked, 0), 'carted', coalesce(st.carted, 0)
    ) order by r.route)
    from (
      select route, count(*) as turns,
        count(*) filter (where status = 'failed') as failed,
        count(*) filter (where status = 'answered' and not unanswered and not escalated) as resolved,
        percentile_cont(0.5) within group (order by latency_ms) filter (where status = 'answered') as p50,
        percentile_cont(0.95) within group (order by latency_ms) filter (where status = 'answered') as p95
      from turns group by route
    ) r
    left join (
      select route, count(*) as shown, count(*) filter (where clicked) as clicked, count(*) filter (where carted) as carted
      from shown_turns group by route
    ) st using (route)
  ), '[]'::jsonb),
  'intents', coalesce((
    select jsonb_agg(jsonb_build_object(
      'intent', intent, 'conversations', n, 'resolved', resolved, 'carted', carted,
      'purchased', purchased, 'revenue', revenue, 'p50', p50, 'p95', p95
    ) order by n desc)
    from (
      select c.intent, count(*) as n,
        count(*) filter (where c.resolved) as resolved,
        count(*) filter (where c.carted) as carted,
        count(*) filter (where c.orders > 0) as purchased,
        coalesce(sum(c.revenue), 0) as revenue
      from conv c
      group by c.intent
    ) x
    left join (
      select c.intent,
        percentile_cont(0.5) within group (order by ct.latency_ms) as p50,
        percentile_cont(0.95) within group (order by ct.latency_ms) as p95
      from conv c join conv_turns ct using (conversation_id)
      where ct.status = 'answered'
      group by c.intent
    ) l using (intent)
  ), '[]'::jsonb),
  'series', coalesce((
    select jsonb_agg(jsonb_build_object('bucket', bucket, 'conversations', conversations, 'orders', orders, 'revenue', revenue) order by bucket)
    from (
      select bucket, sum(conversations) as conversations, sum(orders) as orders, sum(revenue) as revenue
      from (
        select date_trunc(p_grain, started_at at time zone p_tz) as bucket, 1 as conversations, 0 as orders, 0::numeric as revenue from conv
        union all
        select date_trunc(p_grain, placed_at at time zone p_tz), 0, 1, revenue from window_orders
      ) u
      group by bucket
    ) x
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object(
      'product_id', p.product_id, 'title', pr.title, 'handle', pr.handle,
      'shown', p.shown, 'clicked', p.clicked, 'carted', p.carted,
      'units', coalesce(s.units, 0), 'sales', coalesce(s.sales, 0)
    ) order by p.clicked desc, p.carted desc, p.shown desc)
    from (
      select pid as product_id,
        count(distinct conversation_id) filter (where kind = 'shown') as shown,
        count(distinct conversation_id) filter (where kind = 'product_clicked') as clicked,
        count(distinct conversation_id) filter (where kind = 'added_to_cart') as carted
      from (
        select t.conversation_id::text as conversation_id, pid, 'shown' as kind from turns t, unnest(t.product_ids) as pid
        union all
        select c.conversation_ref, c.pid, c.event_type from clicks c, bounds b where c.created_at >= b.t0 and c.created_at < b.t1
      ) e
      group by pid
      order by 3 desc, 4 desc, 2 desc
      limit 10
    ) p
    left join products pr on pr.id::text = p.product_id
    left join lateral (
      select sum(nullif(ol.quantity, '')::numeric) as units, sum(nullif(ol.discounted_total, '')::numeric) as sales
      from window_orders wo join order_lines ol on ol.order_id = wo.id
      where pr.shopify_product_id is not null and ol.product_id = pr.shopify_product_id
    ) s on true
  ), '[]'::jsonb)
);
$$;

revoke all on function public.storefront_agent_dashboard(text[], timestamp without time zone, timestamp without time zone, text, text) from public, anon, authenticated;
grant execute on function public.storefront_agent_dashboard(text[], timestamp without time zone, timestamp without time zone, text, text) to service_role;

comment on function public.storefront_agent_dashboard(text[], timestamp without time zone, timestamp without time zone, text, text) is
  'The Storefront Agent dashboard over [p_from, p_to) as wall-clock time in p_tz, for the advisor''s shops (shop domains): conversations started in it, turns and chat opens in it, assisted orders placed in it (orders.advisor_conversation_id, net of refunds, cancelled excluded), series by p_grain, top products, tokens by route/intent/model (priced by the dashboard). One jsonb document.';
