-- ============================================================================
-- 62 — A CASE WITH A LIVE THREAD NEVER LEADS WITH A FINISHED ONE
--
-- The queue shows one row per case: its lead thread. The lead was the reply
-- thread, else the most recently active thread, whatever its status. A case
-- owing nothing whose latest thread was resolved therefore led with it, and
-- went to Closed with a thread still awaiting_human behind it (cddd49b6: the
-- same question sent twice, answered on the twin, the first left awaiting).
-- Live this is rare; after the 61 backfill, with statuses from before cases,
-- it is not.
--
-- NOW: the reply thread, else the most recently active thread still live (not
-- resolved or closed), else the most recently active. Only the lateral's
-- ordering changes; every column keeps its name and type, so dependent views
-- and functions stand.
--
-- COPIED FROM 04_support.sql (62_case_lead.test.mjs asserts they agree).
-- IDEMPOTENT. NO DATA IS WRITTEN.
--
-- Requires: 61_cases.sql.
-- ============================================================================

create or replace view public.case_facts
with (security_invoker = true) as
  select
    k.id as case_id,
    k.shop_id as shop_id,
    case when a.has_reply_thread then k.reply_thread_id else a.fallback_lead_id end as lead_ticket_id,
    a.thread_count as thread_count,
    a.category as category,
    a.secondary_category as secondary_category,
    a.request_kind as request_kind,
    a.level as level,
    a.happiness as happiness,
    case
      when a.any_awaiting_human then 'awaiting_human'
      when a.all_finished then case when a.any_resolved then 'resolved' else 'closed' end
      else coalesce(a.open_status, 'open')
    end as status,
    a.customer_id as customer_id,
    a.shopify_order_number as shopify_order_number,
    a.first_message_at as first_message_at,
    a.last_message_at as last_message_at,
    fi.first_inbound_at as first_inbound_at,
    o.first_outbound_at as first_outbound_at,
    extract(epoch from (o.first_outbound_at - fi.first_inbound_at)) / 3600.0 as reply_hours
  from public.cases k
  join lateral (
    select
      count(*) as thread_count,
      coalesce(bool_or(t.id = k.reply_thread_id), false) as has_reply_thread,
      (array_agg(t.id order by (t.status not in ('resolved', 'closed')) desc, t.last_message_at desc nulls last))[1] as fallback_lead_id,
      (array_agg(t.category order by t.first_message_at asc nulls last))[1] as category,
      (array_agg(t.secondary_category order by t.first_message_at asc nulls last))[1] as secondary_category,
      (array_agg(t.request_kind order by t.first_message_at asc nulls last))[1] as request_kind,
      max(t.level) as level,
      max(t.happiness) as happiness,
      bool_or(t.status = 'awaiting_human') as any_awaiting_human,
      bool_and(t.status in ('resolved', 'closed')) as all_finished,
      bool_or(t.status = 'resolved') as any_resolved,
      (array_agg(t.status order by t.last_message_at desc nulls last)
        filter (where t.status not in ('resolved', 'closed')))[1] as open_status,
      (array_agg(t.customer_id order by (t.id = k.reply_thread_id) desc nulls last, t.last_message_at desc nulls last)
        filter (where t.customer_id is not null))[1] as customer_id,
      (array_agg(t.shopify_order_number order by (t.id = k.reply_thread_id) desc nulls last, t.last_message_at desc nulls last)
        filter (where t.shopify_order_number is not null))[1] as shopify_order_number,
      min(t.first_message_at) as first_message_at,
      max(t.last_message_at) as last_message_at
    from public.tickets t
    where t.case_id = k.id
      and t.deleted_at is null
  ) a on a.thread_count > 0
  left join lateral (
    select min(m.received_at) as first_inbound_at
    from public.ticket_messages m
    join public.tickets t on t.id = m.ticket_id
    where t.case_id = k.id
      and t.deleted_at is null
      and m.direction = 'inbound'
      and m.deleted_at is null
  ) fi on true
  left join lateral (
    select min(coalesce(m.sent_at, m.received_at)) as first_outbound_at
    from public.ticket_messages m
    join public.tickets t on t.id = m.ticket_id
    where t.case_id = k.id
      and t.deleted_at is null
      and m.direction = 'outbound'
      and m.deleted_at is null
      and coalesce(m.sent_at, m.received_at) > fi.first_inbound_at
  ) o on true;

comment on view public.case_facts is
  'One row per case with at least one live thread: the earliest thread''s subject, the highest level and worst mood of any thread, a status folded across threads, the lead thread (the reply thread, else the most recently active thread still live, else the most recently active), and the case''s first-reply time across threads. Read by the queue and by the Insights support figures, which count cases.';
