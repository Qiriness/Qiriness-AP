-- ============================================================================
-- 08 — A CUSTOMER'S THUMBS UP / DOWN ON A RECOMMENDATION
--
-- WHAT THIS ADDS.
--   `storefront_agent_turns.feedback` (`up` / `down`) + `feedback_at` — the
--     customer's rating of the reply that turn gave, from the 👍 / 👎 the widget
--     draws under replies with product or routine cards. Written through the
--     signed event route (`type: feedback`) for a turn of the signed shop's
--     conversation the browser holds; a second click replaces the first.
--   `storefront_agent_dashboard` — the same document, plus `coverage.feedback_from`,
--     `turns.rated` / `turns.rated_up` and the same per route: recommendation
--     accuracy is rated_up / rated over replies that showed products. And
--     `routines`: the personalised routines the builder provided in the window
--     (`advisor_routines`), how many were added to the cart, and the builder's
--     conversations started / completed (`advisory_events`); `coverage.routines_from`.
--
-- Still no words: a rating is one of two codes.
--
-- docs/decisions/storefront-advisor.md § Recommendation accuracy is the customer's thumbs.
--
-- Requires: 07_storefront_agent_analytics.sql. Idempotent.
-- ============================================================================

alter table public.storefront_agent_turns add column if not exists feedback text;
alter table public.storefront_agent_turns add column if not exists feedback_at timestamp with time zone;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'storefront_agent_turns_feedback_check') then
    alter table public.storefront_agent_turns
      add constraint storefront_agent_turns_feedback_check
      check (feedback is null or feedback in ('up', 'down'));
  end if;
end $$;

comment on column public.storefront_agent_turns.feedback is
  'The customer''s 👍 (up) or 👎 (down) on this turn''s reply, from the storefront widget; null when not rated. The latest click wins (feedback_at).';

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
    'feedback_from', (select min(feedback_at) from storefront_agent_turns where shop_domain = any(p_shops)),
    'routines_from', (select min(created_at) from advisor_routines where shop_domain = any(p_shops)),
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
  -- The personalised routines the builder provided, and the builder's own funnel.
  'routines', (
    select jsonb_build_object(
      'provided', count(*),
      'added', count(*) filter (where r.added_to_cart_at is not null),
      'started', (
        select count(distinct e.conversation_ref) from advisory_events e
        where e.shop_domain = any(p_shops) and e.event_type = 'routine_builder_started'
          and e.created_at >= b.t0 and e.created_at < b.t1
      ),
      'completed', (
        select count(distinct e.conversation_ref) from advisory_events e
        where e.shop_domain = any(p_shops) and e.event_type = 'routine_builder_completed'
          and e.created_at >= b.t0 and e.created_at < b.t1
      )
    )
    from bounds b
    left join advisor_routines r
      on r.shop_domain = any(p_shops) and r.created_at >= b.t0 and r.created_at < b.t1
    group by b.t0, b.t1
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
      -- The customer's rating of a reply that recommended products: accuracy's ground truth.
      'rated', count(*) filter (where feedback is not null and cardinality(product_ids) > 0),
      'rated_up', count(*) filter (where feedback = 'up' and cardinality(product_ids) > 0),
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
      'p50', r.p50, 'p95', r.p95, 'rated', r.rated, 'rated_up', r.rated_up,
      'shown', coalesce(st.shown, 0), 'clicked', coalesce(st.clicked, 0), 'carted', coalesce(st.carted, 0)
    ) order by r.route)
    from (
      select route, count(*) as turns,
        count(*) filter (where status = 'failed') as failed,
        count(*) filter (where status = 'answered' and not unanswered and not escalated) as resolved,
        percentile_cont(0.5) within group (order by latency_ms) filter (where status = 'answered') as p50,
        percentile_cont(0.95) within group (order by latency_ms) filter (where status = 'answered') as p95,
        count(*) filter (where feedback is not null and cardinality(product_ids) > 0) as rated,
        count(*) filter (where feedback = 'up' and cardinality(product_ids) > 0) as rated_up
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
