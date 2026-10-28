-- ============================================================================
-- 05 — ASSIGNING TICKETS TO PEOPLE
--
-- WHAT THIS ADDS.
--   `tickets.assigned_to` — the dashboard user (Supabase Auth id) a ticket is
--     with, or null. `assigned_at` / `assigned_by` say when and by whom. Kept
--     through close and reopen: a customer who writes again lands back with the
--     same person. Only a person sets it; nothing assigns automatically.
--   `ticket_assignments` — every assignment and unassignment, append-only, so
--     "who had this" survives the next change.
--   `dashboard_team()` — the people a ticket can be assigned to: every account
--     with a dashboard role that is not disabled (banned), as id, name and role.
--     SECURITY DEFINER because `auth.users` is not readable by the service role
--     through PostgREST, and this is what keeps the secret key out of the web
--     app (scripts/lib/dashboard-user-admin.mjs must never be imported there).
--     No address leaves it unless there is no name to show.
--   `ticket_queue` gains `assigned_to` as its last column.
--
-- REVERSES « assignee: left out by decision » (docs/decisions/human-overrides.md):
-- the user list now exists, read from Supabase Auth rather than invented.
-- docs/decisions/tickets-dashboard.md § Assignment.
--
-- Requires: 04_ticket_numbers_and_notes.sql. Idempotent.
-- ============================================================================

alter table public.tickets add column if not exists assigned_to text;
alter table public.tickets add column if not exists assigned_at timestamp with time zone;
alter table public.tickets add column if not exists assigned_by text;

comment on column public.tickets.assigned_to is
  'The dashboard user (auth.users id) this ticket is with, or null. Set only by a person on the dashboard; kept through close and reopen. History in ticket_assignments.';
comment on column public.tickets.assigned_at is 'When assigned_to last changed.';
comment on column public.tickets.assigned_by is 'Who last changed assigned_to (auth.users id).';

create index if not exists tickets_shop_assigned_to_idx on public.tickets (shop_id, assigned_to) where assigned_to is not null;

create table if not exists public.ticket_assignments (
  id uuid default gen_random_uuid() not null,
  shop_id uuid not null,
  ticket_id uuid not null,
  -- Null: the ticket was unassigned.
  assigned_to text,
  assigned_by text,
  assigned_at timestamp with time zone default now() not null,
  constraint ticket_assignments_pkey primary key (id),
  constraint ticket_assignments_shop_id_fkey foreign key (shop_id) references public.shops(id) on delete cascade,
  constraint ticket_assignments_ticket_id_fkey foreign key (ticket_id) references public.tickets(id) on delete cascade
);

create index if not exists ticket_assignments_ticket_idx on public.ticket_assignments (ticket_id, assigned_at);

alter table public.ticket_assignments enable row level security;
revoke all on public.ticket_assignments from anon, authenticated;

comment on table public.ticket_assignments is
  'Every assignment and unassignment of a ticket, append-only. The current value is tickets.assigned_to.';

CREATE OR REPLACE FUNCTION public.dashboard_team()
 RETURNS TABLE(id uuid, display_name text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return query
    select u.id,
           coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''), split_part(u.email::text, '@', 1)),
           u.raw_app_meta_data ->> 'dashboard_role'
    from auth.users u
    where u.raw_app_meta_data ->> 'dashboard_role' in ('developer', 'management', 'contact')
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null
    order by 2;
end;
$function$;

revoke all on function public.dashboard_team() from public, anon, authenticated;
grant execute on function public.dashboard_team() to service_role;

comment on function public.dashboard_team() is
  'The people a ticket can be assigned to: every dashboard account (developer, management, contact) that is not banned, as id, display name (the address before @ when none is set) and role.';

create or replace view public.ticket_queue with (security_invoker=true) as
SELECT t.id,
    t.shop_id,
    t.subject,
    t.status,
    t.category,
    t.secondary_category,
    t.level,
    t.happiness,
    t.responsible_team,
    t.requester_name,
    t.shopify_order_number,
    t.first_message_at,
    t.last_message_at,
    t.archived_at,
    t.duplicate_of_ticket_id,
    t.duplicate_reason,
    c.display_name AS customer_display_name,
    c.first_name AS customer_first_name,
    c.last_name AS customer_last_name,
    c.rfm_group AS customer_rfm_group,
    f.from_email AS requester_email,
    COALESCE(n.message_count, 0::bigint) AS message_count,
    COALESCE(n.inbound_count, 0::bigint) AS inbound_count,
        CASE
            WHEN n.latest_inbound_at IS NOT NULL AND (n.latest_outbound_at IS NULL OR n.latest_inbound_at > n.latest_outbound_at) THEN n.latest_inbound_at
            ELSE NULL::timestamp with time zone
        END AS waiting_since,
    t.sender_label,
    t.overrides,
    t.case_id,
    COALESCE(cf.lead_ticket_id = t.id, true) AS is_case_lead,
    COALESCE(cn.thread_count, 1::bigint) AS case_thread_count,
    COALESCE(cn.message_count, 0::bigint) AS case_message_count,
    COALESCE(cn.inbound_count, 0::bigint) AS case_inbound_count,
        CASE
            WHEN cn.latest_inbound_at IS NOT NULL AND (cn.latest_outbound_at IS NULL OR cn.latest_inbound_at > cn.latest_outbound_at) THEN cn.latest_inbound_at
            ELSE NULL::timestamp with time zone
        END AS case_waiting_since,
    cf.level AS case_level,
    cf.status AS case_status,
    t.resolved_at,
    t.closed_at,
    t.ticket_number,
    t.language,
    t.assigned_to,
    t.assigned_at
   FROM public.tickets t
     LEFT JOIN public.customers c ON c.id = t.customer_id
     LEFT JOIN public.ticket_message_counts n ON n.ticket_id = t.id
     LEFT JOIN public.ticket_first_inbound f ON f.ticket_id = t.id
     LEFT JOIN public.case_message_counts cn ON cn.case_id = t.case_id
     LEFT JOIN public.case_facts cf ON cf.case_id = t.case_id
  WHERE t.deleted_at IS NULL;
