-- ============================================================================
-- 75 — THE QUEUE CARRIES WHEN A TICKET WAS CLOSED
--
-- `ticket_queue` gains `resolved_at` and `closed_at`, appended last
-- (`create or replace view` can only append). The dashboard's Closed section
-- is ordered by them, earliest closure first.
--
-- COPIED FROM 04_support.sql (75_queue_closed_at.test.mjs asserts they agree).
-- NO DATA IS WRITTEN. IDEMPOTENT.
--
-- Requires: 61_cases.sql, 62 (case_facts).
-- ============================================================================

create or replace view public.ticket_queue
with (security_invoker = true) as
  select
    t.id as id,
    t.shop_id as shop_id,
    t.subject as subject,
    t.status as status,
    t.category as category,
    t.secondary_category as secondary_category,
    t.level as level,
    t.happiness as happiness,
    t.responsible_team as responsible_team,
    t.requester_name as requester_name,
    t.shopify_order_number as shopify_order_number,
    t.first_message_at as first_message_at,
    t.last_message_at as last_message_at,
    t.archived_at as archived_at,
    -- The duplicate link, so the list can mark a row without opening it. A
    -- linked ticket is skipped by the drafting queue, and an operator working
    -- through the queue needs to know that BEFORE they read a draft on it.
    t.duplicate_of_ticket_id as duplicate_of_ticket_id,
    t.duplicate_reason as duplicate_reason,
    c.display_name as customer_display_name,
    c.first_name as customer_first_name,
    c.last_name as customer_last_name,
    c.rfm_group as customer_rfm_group,
    -- The address that opened the thread, so the caller can ask
    -- `sender_directory` whether this is a customer or one of our own. Resolved
    -- to a label server-side and never sent to the browser.
    f.from_email as requester_email,
    coalesce(n.message_count, 0) as message_count,
    coalesce(n.inbound_count, 0) as inbound_count,
    case
      when n.latest_inbound_at is not null
        and (n.latest_outbound_at is null or n.latest_inbound_at > n.latest_outbound_at)
      then n.latest_inbound_at
      else null
    end as waiting_since,
    -- LAST, AND NOT BY PREFERENCE. `create or replace view` can only APPEND
    -- columns — inserting one beside `duplicate_reason`, where it belongs
    -- logically, fails with "cannot change name of view column". Putting it
    -- here is what lets the view be replaced in a transaction instead of
    -- dropped and recreated, which on a live database is the difference
    -- between a forward step and an outage.
    --
    -- Whose thread this is: the row is skipped by drafting, and somebody
    -- working the queue should see that before they open it expecting a reply.
    t.sender_label as sender_label,
    -- A person's corrections (48_ticket_overrides.sql): the queue marks an
    -- overridden row and pins a priority band a person chose. Appended last for
    -- the reason above.
    t.overrides as overrides,
    -- THE CASE (61_cases.sql), appended for the same reason. The queue shows
    -- one row per case, its lead thread, and ranks it on the case's facts:
    -- every customer message on every thread, the case's unanswered wait, the
    -- highest level and the folded status.
    t.case_id as case_id,
    coalesce(cf.lead_ticket_id = t.id, true) as is_case_lead,
    coalesce(cn.thread_count, 1) as case_thread_count,
    coalesce(cn.message_count, 0) as case_message_count,
    coalesce(cn.inbound_count, 0) as case_inbound_count,
    case
      when cn.latest_inbound_at is not null
        and (cn.latest_outbound_at is null or cn.latest_inbound_at > cn.latest_outbound_at)
      then cn.latest_inbound_at
      else null
    end as case_waiting_since,
    cf.level as case_level,
    cf.status as case_status,
    -- WHEN IT WAS CLOSED (75), appended for the reason above: the Closed
    -- section lists the earliest closure first.
    t.resolved_at as resolved_at,
    t.closed_at as closed_at
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  left join public.ticket_message_counts n on n.ticket_id = t.id
  left join public.ticket_first_inbound f on f.ticket_id = t.id
  left join public.case_message_counts cn on cn.case_id = t.case_id
  left join public.case_facts cf on cf.case_id = t.case_id
  where t.deleted_at is null;
