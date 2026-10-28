-- ============================================================================
-- 04 — TICKET NUMBERS AND INTERNAL NOTES
--
-- WHAT THIS ADDS.
--   `tickets.ticket_number` — a short number a person can say aloud and type
--     into the search box ("T-1042"), counted per shop from 1. Shown with a
--     `T-` prefix because Shopify order numbers are shown as `#NNNN` and the
--     two ranges overlap: a bare `#1042` would read as an order.
--   `shop_ticket_counters` — the last number handed out per shop. A trigger on
--     `tickets` takes the next one on insert; the row lock on the counter makes
--     two concurrent inserts for one shop wait for each other rather than share
--     a number. A failed insert rolls its counter step back with it, so a
--     number is only spent by a ticket that exists.
--   `ticket_notes` — notes the team leaves on a ticket. Never sent to the
--     customer and, for now, never read by the agent.
--   `ticket_queue` gains `ticket_number` as its last column.
--
-- BACKFILL. Existing tickets are numbered per shop oldest first, by
-- `first_message_at` (then `created_at`, then id, so the order is total), and
-- the counter is set to the highest number given. Only then does the column
-- become NOT NULL and unique per shop.
--
-- docs/decisions/tickets-dashboard.md § Ticket numbers, § Internal notes.
--
-- Requires: 03_shop_mail_settings_stock_alerts.sql. Idempotent.
-- ============================================================================

create table if not exists public.shop_ticket_counters (
  shop_id uuid not null,
  last_number integer default 0 not null,
  constraint shop_ticket_counters_pkey primary key (shop_id),
  constraint shop_ticket_counters_shop_id_fkey foreign key (shop_id) references public.shops(id) on delete cascade,
  constraint shop_ticket_counters_last_number_check check (last_number >= 0)
);

alter table public.shop_ticket_counters enable row level security;
revoke all on public.shop_ticket_counters from anon, authenticated;

comment on table public.shop_ticket_counters is
  'The last ticket number handed out per shop. Written only by assign_ticket_number() on insert into tickets; never edited by hand.';

alter table public.tickets add column if not exists ticket_number integer;

-- The backfill: oldest first, per shop, only rows not yet numbered.
with numbered as (
  select t.id,
         coalesce((select c.last_number from public.shop_ticket_counters c where c.shop_id = t.shop_id), 0)
           + row_number() over (partition by t.shop_id order by t.first_message_at nulls last, t.created_at, t.id) as n
  from public.tickets t
  where t.ticket_number is null
)
update public.tickets t set ticket_number = numbered.n
from numbered
where numbered.id = t.id;

insert into public.shop_ticket_counters (shop_id, last_number)
select shop_id, max(ticket_number) from public.tickets group by shop_id
on conflict (shop_id) do update set last_number = greatest(public.shop_ticket_counters.last_number, excluded.last_number);

CREATE OR REPLACE FUNCTION public.assign_ticket_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.ticket_number is null then
    insert into public.shop_ticket_counters as c (shop_id, last_number)
    values (new.shop_id, 1)
    on conflict (shop_id) do update set last_number = c.last_number + 1
    returning c.last_number into new.ticket_number;
  end if;
  return new;
end;
$function$;

drop trigger if exists tickets_assign_ticket_number on public.tickets;
CREATE TRIGGER tickets_assign_ticket_number BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.assign_ticket_number();

alter table public.tickets alter column ticket_number set not null;
alter table public.tickets drop constraint if exists tickets_shop_ticket_number_unique;
alter table public.tickets add constraint tickets_shop_ticket_number_unique unique (shop_id, ticket_number);

comment on column public.tickets.ticket_number is
  'Per-shop running number, shown as T-<n>. Assigned on insert by assign_ticket_number(); existing tickets were numbered oldest first by first_message_at.';

create table if not exists public.ticket_notes (
  id uuid default gen_random_uuid() not null,
  shop_id uuid not null,
  ticket_id uuid not null,
  body text not null,
  -- The dashboard user's id, and the name they had when they wrote it: a note
  -- is read as "who said this", and nothing else resolves an id to a name.
  author_id text,
  author_name text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  constraint ticket_notes_pkey primary key (id),
  constraint ticket_notes_shop_id_fkey foreign key (shop_id) references public.shops(id) on delete cascade,
  constraint ticket_notes_ticket_id_fkey foreign key (ticket_id) references public.tickets(id) on delete cascade,
  constraint ticket_notes_body_check check (length(btrim(body)) between 1 and 5000)
);

create index if not exists ticket_notes_ticket_created_idx on public.ticket_notes (ticket_id, created_at);

alter table public.ticket_notes enable row level security;
revoke all on public.ticket_notes from anon, authenticated;

drop trigger if exists ticket_notes_set_updated_at on public.ticket_notes;
CREATE TRIGGER ticket_notes_set_updated_at BEFORE UPDATE ON public.ticket_notes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

comment on table public.ticket_notes is
  'Notes the team leaves on a ticket. Never sent to the customer and not read by the drafting agent. Soft-deleted (deleted_at) so the timeline does not silently lose what someone wrote.';

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
    t.language
   FROM public.tickets t
     LEFT JOIN public.customers c ON c.id = t.customer_id
     LEFT JOIN public.ticket_message_counts n ON n.ticket_id = t.id
     LEFT JOIN public.ticket_first_inbound f ON f.ticket_id = t.id
     LEFT JOIN public.case_message_counts cn ON cn.case_id = t.case_id
     LEFT JOIN public.case_facts cf ON cf.case_id = t.case_id
  WHERE t.deleted_at IS NULL;
