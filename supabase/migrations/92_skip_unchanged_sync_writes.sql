-- ============================================================================
-- 92 — A SYNC WRITE THAT CHANGES NOTHING IS NOT WRITTEN
--
-- WHY. The nightly upserts every customer and every order, so every row was
--   rewritten each night: 2.08M updates on 61k customers and 231k on 6k orders
--   since 2026-08-07, an index (26 MB) larger than its table (21 MB). Measured
--   2026-10-12 between the last two nightly runs, 14 customers and 12 orders had
--   actually changed in Shopify.
--
--   The rewrite also moved `updated_at` on every row, and three readers take
--   that column to mean "this changed": the worker's change gate (re-runs its
--   passes), `changedOrderRefs` (re-reads every order since a time) and the
--   customer lookup (rebuilds its 4.7 MB index). After each nightly all three
--   saw the whole table as changed.
--
-- WHAT THIS DOES. A BEFORE UPDATE trigger on `customers` and `orders` drops the
--   update when the row would differ only in `synced_at` / `updated_at`. That
--   covers the upsert's ON CONFLICT DO UPDATE too. A real change, including a
--   column we compute such as `rfm_group`, writes as before. `synced_at` therefore
--   now means "last written", not "last seen by a sync".
--
-- FRESHNESS. `insights_freshness` reported `max(updated_at)` as when orders and
--   customers last synced, which the trigger stops moving on a quiet night. It
--   now reports the later of that and the last COMPLETED nightly's finish, which
--   is what "synced" meant. Same columns, same types.
--
-- IDEMPOTENT. Requires: 01_foundation.sql, 02_shopify.sql, 11_insights_ranges.sql.
-- ============================================================================

-- Trigger arguments name further columns to ignore. Generated columns must be
-- among them: a BEFORE trigger sees them before they are computed, so they would
-- differ on every row; they derive from compared columns, so nothing is lost.
create or replace function public.skip_unchanged_sync_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  ignored text[] := array['synced_at', 'updated_at'] || coalesce(tg_argv::text[], '{}');
begin
  if (to_jsonb(new) - ignored) = (to_jsonb(old) - ignored) then
    return null;
  end if;
  return new;
end;
$$;

comment on function public.skip_unchanged_sync_write() is
  'BEFORE UPDATE trigger: skips an update that would change nothing but synced_at, updated_at and the columns named as trigger arguments, so a full re-sync rewrites only rows that changed and updated_at keeps meaning "changed".';

revoke all on function public.skip_unchanged_sync_write() from public, anon, authenticated;

drop trigger if exists customers_skip_unchanged_sync_write on public.customers;
create trigger customers_skip_unchanged_sync_write
before update on public.customers
for each row
execute function public.skip_unchanged_sync_write('on_email_marketing_list');

drop trigger if exists orders_skip_unchanged_sync_write on public.orders;
create trigger orders_skip_unchanged_sync_write
before update on public.orders
for each row
execute function public.skip_unchanged_sync_write();

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
  with last_complete as (
    select max(ie.finished_at) as finished_at
    from public.integration_events ie
    where ie.shop_id = p_shop
      and ie.event_type = 'nightly_sync'
      and ie.status = 'completed'
  )
  select
    greatest(
      (select max(o.updated_at) from public.orders o where o.shop_id = p_shop),
      (select lc.finished_at from last_complete lc)
    ),
    (select min(o.processed_at) from public.orders o where o.shop_id = p_shop and o.deleted_at is null),
    (select max(o.processed_at) from public.orders o where o.shop_id = p_shop and o.deleted_at is null),
    greatest(
      (select max(c.updated_at) from public.customers c where c.shop_id = p_shop),
      (select lc.finished_at from last_complete lc)
    ),
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
  'One row: when each source feeding the dashboard last moved -- orders, customers, mail, the topic map, the agent -- and the latest nightly sync run. orders/customers_synced_at are the later of the newest row change and the last completed nightly (92: unchanged rows are no longer rewritten). The panels read it to say how old their figures are.';
