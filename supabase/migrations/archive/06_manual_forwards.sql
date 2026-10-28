-- ============================================================================
-- 06 — FORWARDING A TICKET TO A COLLEAGUE, AND MAIL THAT NEVER LEFT THE COMPANY
--
-- WHAT THIS ADDS.
--   `ticket_messages.internal_only` — an outbound message every recipient of
--     which is on one of our own domains: a forward to a colleague, a note to
--     logistics. Set at ingestion (graph-message-mapper.mjs). Until now every
--     message of ours counted as « we answered the customer »: it staled the
--     pending draft, could snooze the ticket waiting for the customer, fold it
--     to resolved, cleared the case's reply target and reset the customer's
--     waiting time. Every one of those readers now skips internal-only mail.
--     Existing rows stay false: the flag starts with the mail read from now on,
--     so no historical case is re-folded differently.
--   `ticket_message_counts` / `case_message_counts` — `latest_outbound_at`
--     ignores internal-only mail, so forwarding a ticket does not reset how long
--     the customer has been waiting (the queue's priority reads it).
--   `ticket_manual_forwards` — a person forwarding the whole thread to
--     colleagues from the ticket page. One row per forward; the worker carries
--     it (agent/src/outbound/forward-ticket.mjs) through `send_outbound` jobs.
--   `dashboard_team()` gains `email`, so a team member can be a recipient. The
--     address is read on the server only; the page shows names.
--
-- docs/decisions/forwarding.md § Manual forwards.
--
-- Requires: 05_ticket_assignment.sql. Idempotent.
-- ============================================================================

alter table public.ticket_messages add column if not exists internal_only boolean default false not null;

comment on column public.ticket_messages.internal_only is
  'Outbound mail every To/Cc recipient of which is on one of our own domains (a forward to a colleague): set at ingestion. Never counts as an answer to the customer: the fold, drafting, the reply target and the waiting time all skip it. False on rows stored before 06.';

create or replace view public.ticket_message_counts with (security_invoker=true) as
SELECT shop_id,
    ticket_id,
    count(*) AS message_count,
    count(*) FILTER (WHERE direction = 'inbound'::text) AS inbound_count,
    max(received_at) FILTER (WHERE direction = 'inbound'::text) AS latest_inbound_at,
    max(sent_at) FILTER (WHERE direction = 'outbound'::text AND NOT internal_only) AS latest_outbound_at
   FROM public.ticket_messages m
  WHERE deleted_at IS NULL
  GROUP BY shop_id, ticket_id;

create or replace view public.case_message_counts with (security_invoker=true) as
SELECT t.shop_id,
    t.case_id,
    count(DISTINCT t.id) AS thread_count,
    count(m.id) AS message_count,
    count(m.id) FILTER (WHERE m.direction = 'inbound'::text) AS inbound_count,
    max(m.received_at) FILTER (WHERE m.direction = 'inbound'::text) AS latest_inbound_at,
    max(m.sent_at) FILTER (WHERE m.direction = 'outbound'::text AND NOT m.internal_only) AS latest_outbound_at,
    max(t.last_message_at) AS last_activity_at
   FROM public.tickets t
     LEFT JOIN public.ticket_messages m ON m.ticket_id = t.id AND m.deleted_at IS NULL
  WHERE t.deleted_at IS NULL
  GROUP BY t.shop_id, t.case_id;

create table if not exists public.ticket_manual_forwards (
  id uuid default gen_random_uuid() not null,
  shop_id uuid not null,
  ticket_id uuid not null,
  -- Minted by the page when the form opens: a double click sends one forward.
  client_key uuid not null,
  -- [{ email, name, kind: team | destination | address }], validated internal on the server.
  recipients jsonb not null,
  note text,
  forwarded_by text,
  forwarded_by_name text,
  state text default 'queued'::text not null,
  -- The message Graph forwarded (the latest customer message), and the draft it made.
  source_message_id uuid,
  provider_draft_id text,
  internet_message_id text,
  attachments_sent integer default 0 not null,
  -- [{ name, size, reason }]: files that could not travel (too large, gone).
  attachments_skipped jsonb default '[]'::jsonb not null,
  error text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint ticket_manual_forwards_pkey primary key (id),
  constraint ticket_manual_forwards_shop_id_fkey foreign key (shop_id) references public.shops(id) on delete cascade,
  constraint ticket_manual_forwards_ticket_id_fkey foreign key (ticket_id) references public.tickets(id) on delete cascade,
  constraint ticket_manual_forwards_source_message_id_fkey foreign key (source_message_id) references public.ticket_messages(id) on delete set null,
  constraint ticket_manual_forwards_client_key_unique unique (shop_id, client_key),
  constraint ticket_manual_forwards_recipients_check check (jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) between 1 and 10),
  constraint ticket_manual_forwards_skipped_check check (jsonb_typeof(attachments_skipped) = 'array'),
  constraint ticket_manual_forwards_note_check check (note is null or length(note) <= 5000),
  constraint ticket_manual_forwards_state_check check (state = any (array['queued'::text, 'draft_created'::text, 'send_requested'::text, 'sent'::text, 'held'::text, 'failed'::text]))
);

create index if not exists ticket_manual_forwards_ticket_idx on public.ticket_manual_forwards (ticket_id, created_at);
create index if not exists ticket_manual_forwards_message_id_idx on public.ticket_manual_forwards (shop_id, internet_message_id) where internet_message_id is not null;

alter table public.ticket_manual_forwards enable row level security;
revoke all on public.ticket_manual_forwards from anon, authenticated;

drop trigger if exists ticket_manual_forwards_set_updated_at on public.ticket_manual_forwards;
CREATE TRIGGER ticket_manual_forwards_set_updated_at BEFORE UPDATE ON public.ticket_manual_forwards FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

comment on table public.ticket_manual_forwards is
  'A person forwarding a ticket''s whole thread to colleagues from the dashboard: recipients, note, and how far the worker got (queued → draft_created → send_requested → sent | held | failed). The Sent Items copy is matched back by internet_message_id.';

-- A new column in the result: Postgres refuses to change a function's result
-- type in place, so it is dropped and created again, with its grants.
drop function if exists public.dashboard_team();

CREATE OR REPLACE FUNCTION public.dashboard_team()
 RETURNS TABLE(id uuid, display_name text, role text, email text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return query
    select u.id,
           coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''), split_part(u.email::text, '@', 1)),
           u.raw_app_meta_data ->> 'dashboard_role',
           lower(u.email::text)
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
  'The people a ticket can be assigned or forwarded to: every dashboard account (developer, management, contact) that is not banned, as id, display name (the address before @ when none is set), role and address. The address is for the server; the page shows names.';
