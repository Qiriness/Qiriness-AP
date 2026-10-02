-- ============================================================================
-- 61 — CASES: several email threads, one customer problem
--
-- Message -> thread (`tickets`, one per Graph conversation) -> case. Threads
-- are never merged or deleted; several may point at one `cases` row. Linking
-- is decided in agent/src/cases/ (deterministic rules first, a model only
-- between a handful of candidates) and recorded in `case_links`. The reply
-- target is chosen by code and stored on the case. See DECISIONS.md § Cases.
--
-- DATA, ONCE:
--   · one case per existing ticket, reusing the ticket's id as the case id;
--   · a ticket linked as a duplicate joins its original's case (a `backfill`
--     row in case_links says so);
--   · every existing ticket is `decided`, so history is never re-linked;
--   · the issue families are seeded for every shop (configuration: a shop may
--     change them, and the linker reads only the table).
-- The reply targets are NOT computed here: `npm run cases:targets` (agent/)
-- does it with the same code the worker uses.
--
-- The tables are COPIED FROM 04_support.sql, the views and functions from 04
-- and 06 (61_cases.test.mjs asserts both). IDEMPOTENT.
--
-- Requires: 04_support.sql, 06_analytics.sql, 17_management_chat.sql, 53.
-- ============================================================================

-- ================================================================ 1. cases

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  case_key text,
  issue_family text,
  latest_actionable_inbound_message_id uuid,
  reply_thread_id uuid,
  target_computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cases_shop_idx on public.cases (shop_id);

create index if not exists cases_shop_key_idx on public.cases (shop_id, case_key) where case_key is not null;

drop trigger if exists cases_set_updated_at on public.cases;
create trigger cases_set_updated_at
before update on public.cases
for each row execute function public.set_updated_at();

alter table public.cases enable row level security;

comment on table public.cases is
  'The customer''s problem, above the email threads it arrived on: several tickets may share a case_id, nothing is merged. Created with its first ticket; linked only by agent/src/cases/ and recorded in case_links. Holds the reply target, chosen by code (case-reply-target.mjs). Written only by scripts/lib/case-record.mjs.';
comment on column public.cases.latest_actionable_inbound_message_id is
  'The newest customer message in the case that no later message of ours answers, on any of its threads. Null when everything is answered. Not a foreign key (tickets references this table); a pointer to nothing reads as no target.';
comment on column public.cases.reply_thread_id is
  'The ticket holding latest_actionable_inbound_message_id: the only thread of the case that is drafted and replied on.';

-- ======================================================= 2. issue families

create table if not exists public.issue_family_members (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  member_kind text not null,
  member_key text not null,
  family_key text not null,
  created_at timestamptz not null default now(),

  constraint issue_family_members_kind_check check (member_kind in ('subject', 'situation')),
  constraint issue_family_members_unique unique (shop_id, member_kind, member_key)
);

alter table public.issue_family_members enable row level security;

comment on table public.issue_family_members is
  'Per shop: the issue family each ticket subject and each situation belongs to (DELIVERY, ORDER_CHANGE, REFUND_RETURN...). Case linking reads it; a subject or situation with no row has no family and is never linked on family grounds.';

create table if not exists public.issue_family_transitions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  from_family text not null,
  to_family text not null,
  created_at timestamptz not null default now(),

  constraint issue_family_transitions_unique unique (shop_id, from_family, to_family),
  constraint issue_family_transitions_not_self_check check (from_family <> to_family)
);

alter table public.issue_family_transitions enable row level security;

comment on table public.issue_family_transitions is
  'Per shop: a case about from_family may continue as to_family (a late delivery becoming a refund). Directed; a family is always compatible with itself and needs no row.';

-- The seed, from the situations in Email-Example-Queries.md and the subjects
-- in support-taxonomy.mjs. A subject with no family (b2b, careers, partner,
-- legal_privacy, other) is never linked on family grounds.
insert into public.issue_family_members (shop_id, member_kind, member_key, family_key)
select s.id, v.kind, v.member, v.family
from public.shops s
cross join (values
  ('subject', 'delivery', 'DELIVERY'),
  ('subject', 'order', 'ORDER_CHANGE'),
  ('subject', 'return_exchange', 'REFUND_RETURN'),
  ('subject', 'payment', 'PAYMENT'),
  ('subject', 'promotions', 'PROMOTION'),
  ('subject', 'product', 'PRODUCT'),
  ('subject', 'product_stock', 'PRODUCT'),
  ('subject', 'account', 'ACCOUNT'),
  ('subject', 'cosmetovigilance', 'COSMETOVIGILANCE'),
  ('situation', 'D-01', 'DELIVERY'),
  ('situation', 'D-02', 'DELIVERY'),
  ('situation', 'D-03', 'DELIVERY'),
  ('situation', 'D-05', 'DELIVERY'),
  ('situation', 'D-06', 'DELIVERY'),
  ('situation', 'D-07', 'DELIVERY'),
  ('situation', 'D-08', 'DELIVERY'),
  ('situation', 'D-33', 'DELIVERY'),
  ('situation', 'D-36', 'DELIVERY'),
  ('situation', 'D-37', 'DELIVERY'),
  ('situation', 'O-09', 'DELIVERY'),
  ('situation', 'O-12', 'ORDER_CHANGE'),
  ('situation', 'O-13', 'ORDER_CHANGE'),
  ('situation', 'O-14', 'ORDER_CHANGE'),
  ('situation', 'P-15', 'PROMOTION'),
  ('situation', 'P-17', 'PROMOTION'),
  ('situation', 'P-18', 'PROMOTION'),
  ('situation', 'P-19', 'PROMOTION'),
  ('situation', 'P-20', 'DELIVERY'),
  ('situation', 'P-21', 'PROMOTION'),
  ('situation', 'P-22', 'PROMOTION'),
  ('situation', 'R-21', 'REFUND_RETURN'),
  ('situation', 'R-22', 'REFUND_RETURN'),
  ('situation', 'R-23', 'REFUND_RETURN'),
  ('situation', 'PR-24', 'PRODUCT'),
  ('situation', 'PR-25', 'PRODUCT'),
  ('situation', 'PR-26', 'PRODUCT'),
  ('situation', 'PR-27', 'PRODUCT'),
  ('situation', 'PR-28', 'PRODUCT'),
  ('situation', 'PR-29', 'PRODUCT'),
  ('situation', 'S-34', 'PRODUCT'),
  ('situation', 'A-29', 'ACCOUNT'),
  ('situation', 'A-35', 'ACCOUNT'),
  ('situation', 'PA-30', 'PAYMENT'),
  ('situation', 'PA-31', 'PAYMENT'),
  ('situation', 'PA-32', 'PAYMENT'),
  ('situation', 'CV-01', 'COSMETOVIGILANCE'),
  ('situation', 'CV-02', 'COSMETOVIGILANCE'),
  ('situation', 'CV-03', 'COSMETOVIGILANCE'),
  ('situation', 'CV-04', 'COSMETOVIGILANCE')
) as v(kind, member, family)
on conflict (shop_id, member_kind, member_key) do nothing;

insert into public.issue_family_transitions (shop_id, from_family, to_family)
select s.id, v.from_family, v.to_family
from public.shops s
cross join (values
  ('ORDER_CHANGE', 'DELIVERY'),
  ('DELIVERY', 'ORDER_CHANGE'),
  ('DELIVERY', 'REFUND_RETURN'),
  ('ORDER_CHANGE', 'REFUND_RETURN'),
  ('PAYMENT', 'ORDER_CHANGE'),
  ('ORDER_CHANGE', 'PAYMENT')
) as v(from_family, to_family)
on conflict (shop_id, from_family, to_family) do nothing;

-- ================================================ 3. every ticket has a case

alter table public.tickets add column if not exists case_id uuid references public.cases(id) on delete restrict;
alter table public.tickets add column if not exists case_link_state text not null default 'pending';

alter table public.tickets drop constraint if exists tickets_case_link_state_check;
alter table public.tickets add constraint tickets_case_link_state_check check (case_link_state in ('pending', 'decided'));

comment on column public.tickets.case_id is
  'The case this thread belongs to. A new conversation opens its own case; the case linker (agent/src/cases/) may move the thread into an older case of the same customer, recorded in case_links. Threads are never merged: several tickets share a case_id.';

comment on column public.tickets.case_link_state is
  'pending until the case linker has decided, once, whether this thread continues an older case; decided after. Tickets that predate cases were marked decided by 61_cases.sql.';

-- ===================================================== 4. case_links (audit)

create table if not exists public.case_links (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  from_case_id uuid not null,
  to_case_id uuid not null,
  decision text not null,
  method text not null,
  candidates jsonb not null default '[]'::jsonb,
  model text,
  model_answer text,
  decided_at timestamptz not null default now(),

  constraint case_links_decision_check check (decision in ('link', 'new_case')),
  constraint case_links_method_check check (
    method in (
      'first_contact',
      'reply_chain',
      'identical_body',
      'tracking',
      'order_family',
      'unique_match',
      'model',
      'model_off',
      'no_candidates',
      'excluded_sender',
      'backfill'
    )
  ),
  constraint case_links_candidates_array_check check (jsonb_typeof(candidates) = 'array'),
  constraint case_links_shape_check check ((decision = 'link') = (from_case_id <> to_case_id))
);

create index if not exists case_links_ticket_idx on public.case_links (ticket_id, decided_at desc);

alter table public.case_links enable row level security;

comment on table public.case_links is
  'Append-only: every case-linking decision, a new case included, with the rule (method) and the candidates considered. Written only by scripts/lib/case-record.mjs.';
comment on column public.case_links.method is
  'first_contact (no other case for this customer) · reply_chain / identical_body (the duplicate rules) · tracking / order_family / unique_match (deterministic identifiers) · model (the Case Linker chose) · model_off (ambiguous, model switched off, so a new case) · no_candidates · excluded_sender (a listed sender or one of our own threads) · backfill (61_cases.sql).';

-- ============================================================ 5. the backfill

do $$
declare
  moved integer;
begin
  -- One case per ticket that has none, under the ticket's own id.
  insert into public.cases (id, shop_id, created_at)
  select t.id, t.shop_id, t.created_at
  from public.tickets t
  where t.case_id is null
  on conflict (id) do nothing;

  -- A duplicate joins its original's case, following a chain to its root.
  loop
    with moves as (
      update public.tickets d
      set case_id = coalesce(o.case_id, o.id)
      from public.tickets o
      where d.duplicate_of_ticket_id = o.id
        and d.case_id is null
        and (o.duplicate_of_ticket_id is null or o.case_id is not null)
      returning d.id, d.shop_id, d.case_id
    )
    insert into public.case_links (shop_id, ticket_id, from_case_id, to_case_id, decision, method)
    select m.shop_id, m.id, m.id, m.case_id, 'link', 'backfill'
    from moves m;
    get diagnostics moved = row_count;
    exit when moved = 0;
  end loop;

  -- Everything else is its own case.
  update public.tickets set case_id = id where case_id is null;

  -- A MUTUAL PAIR, each thread flagged as the other's duplicate (3 pairs on
  -- 2026-10-02), is one case: the later thread joins the earlier one's.
  with moves as (
    update public.tickets d
    set case_id = o.case_id
    from public.tickets o
    where d.duplicate_of_ticket_id = o.id
      and o.duplicate_of_ticket_id = d.id
      and d.case_id <> o.case_id
      and (d.first_message_at, d.id) > (o.first_message_at, o.id)
    returning d.id, d.shop_id, d.case_id
  )
  insert into public.case_links (shop_id, ticket_id, from_case_id, to_case_id, decision, method)
  select m.shop_id, m.id, m.id, m.case_id, 'link', 'backfill'
  from moves m;

  -- History is never re-linked: the linker decides for new threads only.
  update public.tickets set case_link_state = 'decided' where case_link_state = 'pending';

  -- The orphan cases a duplicate left behind.
  delete from public.cases k
  where not exists (select 1 from public.tickets t where t.case_id = k.id);
end $$;

alter table public.tickets alter column case_id set not null;

create index if not exists tickets_case_idx on public.tickets (case_id);

create index if not exists tickets_case_link_pending_idx
  on public.tickets (shop_id)
  where case_link_state = 'pending';

-- A TICKET INSERTED WITHOUT A CASE OPENS ONE. The worker creates the case
-- itself (scripts/lib/case-record.mjs); this is the net under every other
-- writer -- above all a worker still running code from before 61, whose
-- inserts would otherwise fail the NOT NULL and stall ingestion. The thread
-- stays `pending`, so the link pass still decides it.
create or replace function public.tickets_open_case()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.case_id is null then insert into public.cases (shop_id) values (new.shop_id) returning id into new.case_id; end if;
  return new;
end;
$$;

drop trigger if exists tickets_open_case on public.tickets;
create trigger tickets_open_case
before insert on public.tickets
for each row
execute function public.tickets_open_case();

-- ===================================================== 5b. the Case Linker model

alter table public.agent_models drop constraint if exists agent_models_agent_check;
alter table public.agent_models add constraint agent_models_agent_check check (
    agent in ('spam', 'categorise', 'situation', 'decompose', 'investigate', 'draft', 'chat', 'case_link')
  );

-- Its calls are costed under their own pass (copied from 06).
alter table public.llm_usage drop constraint if exists llm_usage_pass_check;
alter table public.llm_usage add constraint llm_usage_pass_check check (
    pass in ('spam', 'categorise', 'decompose', 'situation', 'investigate', 'draft', 'embed', 'case_link', 'other')
  );

-- ========================================== 5c. the management chat sees cases

-- Appended last (create or replace view can only append). Support volume is
-- count(distinct case_id): several threads about one problem are one case.
create or replace view chat.tickets as
  select
    t.id as ticket_id,
    t.status as status,
    t.category as category,
    t.secondary_category as secondary_category,
    t.request_kind as request_kind,
    t.level as level,
    t.responsible_team as responsible_team,
    t.language as language,
    t.happiness as happiness,
    t.sender_label as sender_label,
    t.customer_id as customer_id,
    t.shopify_order_number as shopify_order_number,
    (t.duplicate_of_ticket_id is not null) as is_duplicate,
    t.related_ticket_id as related_ticket_id,
    t.first_message_at as first_message_at,
    t.last_message_at as last_message_at,
    t.categorised_at as categorised_at,
    t.investigated_at as investigated_at,
    t.resolved_at as resolved_at,
    t.closed_at as closed_at,
    t.case_id as case_id
  from public.tickets t
  where t.deleted_at is null;

comment on column chat.tickets.case_id is
  'The customer case this thread belongs to. Several threads can share one case (a customer who wrote again on a new thread about the same problem): count support volume as count(distinct case_id), not count(*).';

grant select on chat.tickets to mgmt_chat_ro;

-- ===================================================== 6. the case projections
-- Copied from 04_support.sql (61_cases.test.mjs asserts it). case_facts must
-- exist before ticket_queue reads it.

create or replace view public.case_message_counts
with (security_invoker = true) as
  select
    t.shop_id as shop_id,
    t.case_id as case_id,
    count(distinct t.id) as thread_count,
    count(m.id) as message_count,
    count(m.id) filter (where m.direction = 'inbound') as inbound_count,
    max(m.received_at) filter (where m.direction = 'inbound') as latest_inbound_at,
    max(m.sent_at) filter (where m.direction = 'outbound') as latest_outbound_at,
    max(t.last_message_at) as last_activity_at
  from public.tickets t
  left join public.ticket_messages m on m.ticket_id = t.id and m.deleted_at is null
  where t.deleted_at is null
  group by t.shop_id, t.case_id;


revoke all on public.case_message_counts from anon, authenticated;

comment on view public.case_message_counts is
  'Message counts and inbound/outbound activity per case, over every live thread in it, soft-deleted messages excluded. The case-level twin of ticket_message_counts, read by the queue''s priority.';


create or replace view public.case_facts
with (security_invoker = true) as
  select
    k.id as case_id,
    k.shop_id as shop_id,
    case when a.has_reply_thread then k.reply_thread_id else a.latest_ticket_id end as lead_ticket_id,
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
      (array_agg(t.id order by t.last_message_at desc nulls last))[1] as latest_ticket_id,
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


revoke all on public.case_facts from anon, authenticated;

comment on view public.case_facts is
  'One row per case with at least one live thread: the earliest thread''s subject, the highest level and worst mood of any thread, a status folded across threads, the lead thread (the reply thread, else the most recently active), and the case''s first-reply time across threads. Read by the queue and by the Insights support figures, which count cases.';


-- The queue appends the case columns last (create or replace view can only
-- append). Copied from 04_support.sql.
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
    cf.status as case_status
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  left join public.ticket_message_counts n on n.ticket_id = t.id
  left join public.ticket_first_inbound f on f.ticket_id = t.id
  left join public.case_message_counts cn on cn.case_id = t.case_id
  left join public.case_facts cf on cf.case_id = t.case_id
  where t.deleted_at is null;


-- ================================================= 7. Insights count cases
-- Copied byte-for-byte from 06_analytics.sql. Same signatures and columns:
-- `create or replace`, nothing dropped.

create or replace view public.customer_ticket_facts
with (security_invoker = true) as
  select
    t.lead_ticket_id as ticket_id,
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
  from public.case_facts t
  join public.customers c on c.id = t.customer_id
  where c.deleted_at is null;


comment on view public.customer_ticket_facts is
  'One row per CASE linked to a customer (ticket_id is its lead thread), with that customer''s segment, lifetime spend and marketing state joined on. Bounded by ticket count, so the service reads it whole and applies the VIP rule in JavaScript rather than the view asserting one.';


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
    count(*) filter (where t.reply_hours is not null),
    percentile_cont(0.5) within group (order by t.reply_hours),
    percentile_cont(0.9) within group (order by t.reply_hours),
    count(*) filter (where t.reply_hours is not null and t.reply_hours <= 24),
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
  from public.case_facts t
  left join public.customers c on c.id = t.customer_id
  where t.shop_id = p_shop
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz);
$$;

revoke all on function public.insights_support_summary from public, anon, authenticated;
grant execute on function public.insights_support_summary to service_role;

comment on function public.insights_support_summary is
  'One row for a date range, on first_message_at: CASE volume and mood (case_facts: several threads of one customer problem count once; the output columns keep the name tickets), first-reply timing over the cases that can be timed, and who wrote in by whether an online purchase is visible (tickets, then distinct people and their reachability).';


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
    count(*) filter (where t.reply_hours is not null),
    percentile_cont(0.5) within group (order by t.reply_hours)
  from public.case_facts t
  where t.shop_id = p_shop
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz)
  group by 1
  order by 1;
$$;

revoke all on function public.insights_support_series from public, anon, authenticated;
grant execute on function public.insights_support_series to service_role;

comment on function public.insights_support_series is
  'Cases (case_facts; the column keeps the name tickets), unhappy cases and median first reply per wall-clock bucket, on the case''s first_message_at. Non-empty buckets only.';


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
  from public.case_facts t
  left join public.customers c on c.id = t.customer_id
  where t.shop_id = p_shop
    and t.first_message_at >= (p_from at time zone p_tz)
    and t.first_message_at < (p_to at time zone p_tz)
  group by 1
  order by 2 desc, 1;
$$;

revoke all on function public.insights_support_categories from public, anon, authenticated;
grant execute on function public.insights_support_categories to service_role;

comment on function public.insights_support_categories is
  'Case volume, mood and purchase state per subject (the case''s earliest thread) for a date range, on first_message_at. Fourteen rows at most.';

