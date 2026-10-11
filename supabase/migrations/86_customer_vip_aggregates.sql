-- ============================================================================
-- 86 — CUSTOMERS PANEL: VIP TICKET FIGURES AGGREGATED IN SQL
--
-- WHAT THIS ADDS. customer_vip_ticket_stats, customer_vip_ticket_categories and
--   customer_vip_call_list. The panel read every row of customer_ticket_facts and
--   grouped it in TypeScript, refusing to render at a 500-row cap; case volume
--   reached it. Copied from 06_analytics.sql, not retyped.
--
-- IDEMPOTENT. No data is written.
--
-- Requires: 06_analytics.sql, 12_vip_rule.sql, 61_cases.sql.
-- ============================================================================

-- ----------------------------------------- the Customers panel's ticket reads
--
-- The panel used to read every row of customer_ticket_facts and group it in
-- TypeScript, refusing to render at a 500-row cap. Case volume reached that cap,
-- so the grouping lives here. The VIP rule is still written once: each function
-- joins vip_customers(), it never compares a number itself.
--
-- `p_closed_statuses` is passed in because "closed" is owned by ticket-stats.ts
-- (CLOSED_STATUSES); restating it here would be a second list to drift.

create or replace function public.customer_vip_ticket_stats(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_closed_statuses text[] default '{}',
  p_unhappy_from integer default 3
)
returns table (
  tickets_linked bigint,
  vip_tickets bigint,
  vip_contacted bigint,
  spend_exposed numeric
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*) from public.customer_ticket_facts f where f.shop_id = p_shop),
    (
      select count(*)
      from public.customer_ticket_facts f
      join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
        on v.customer_id = f.customer_id
      where f.shop_id = p_shop
    ),
    (
      select count(distinct f.customer_id)
      from public.customer_ticket_facts f
      join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
        on v.customer_id = f.customer_id
      where f.shop_id = p_shop
    ),
    -- Deduplicated by customer: amount_spent is a customer column, so a person
    -- with three open unhappy cases must count once.
    (
      select coalesce(sum(d.amount_spent), 0)
      from (
        select distinct on (f.customer_id) f.amount_spent
        from public.customer_ticket_facts f
        where f.shop_id = p_shop
          and not (f.status = any(p_closed_statuses))
          and f.happiness >= p_unhappy_from
        order by f.customer_id
      ) d
    );
$$;

revoke all on function public.customer_vip_ticket_stats from public, anon, authenticated;
grant execute on function public.customer_vip_ticket_stats to service_role;

comment on function public.customer_vip_ticket_stats is
  'The Customers panel''s ticket figures, aggregated: cases linked to a customer, cases of VIPs (vip_customers()), distinct VIPs who wrote in, and lifetime spend behind open unhappy cases (once per customer).';

create or replace function public.customer_vip_ticket_categories(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null
)
returns table (
  category text,
  tickets bigint
)
language sql
stable
set search_path = public
as $$
  select f.category, count(*)
  from public.customer_ticket_facts f
  join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
    on v.customer_id = f.customer_id
  where f.shop_id = p_shop
  group by f.category;
$$;

revoke all on function public.customer_vip_ticket_categories from public, anon, authenticated;
grant execute on function public.customer_vip_ticket_categories to service_role;

comment on function public.customer_vip_ticket_categories is
  'VIP cases by subject (null category = uncategorised). Ordering is left to the caller.';

create or replace function public.customer_vip_call_list(
  p_shop uuid,
  p_min_spend numeric,
  p_min_orders integer,
  p_window_months integer,
  p_not_channels text[] default null,
  p_closed_statuses text[] default '{}',
  p_min_level integer default 3
)
returns setof public.customer_ticket_facts
language sql
stable
set search_path = public
as $$
  select f.*
  from public.customer_ticket_facts f
  join public.vip_customers(p_shop, p_min_spend, p_min_orders, p_window_months, p_not_channels) v
    on v.customer_id = f.customer_id
  where f.shop_id = p_shop
    and not (f.status = any(p_closed_statuses))
    and f.level >= p_min_level
  order by f.amount_spent desc, f.ticket_id;
$$;

revoke all on function public.customer_vip_call_list from public, anon, authenticated;
grant execute on function public.customer_vip_call_list to service_role;

comment on function public.customer_vip_call_list is
  'Cases of VIP customers that are open and at or above p_min_level: the panel''s call list. Filtered in SQL, so it is bounded by what needs a call, not by all cases.';
