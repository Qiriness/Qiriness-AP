-- 17_management_chat.sql
--
-- THE MANAGEMENT CHAT (/home): a model answers management questions by writing
-- SQL. This file is what that SQL can reach, and where the conversation is kept.
--
-- INCREMENTAL, like 10-16: it runs on top of the baseline and is idempotent.
--
-- THREE PARTS.
--   1. `mgmt_chat_ro`, a login role the chat connects as. It can read the views
--      in `chat` and nothing else. No password is set here: a secret has no
--      place in a checked-in file. It is set once by hand (DECISIONS.md §
--      Management chat), and until then the role cannot log in at all.
--   2. The `chat` schema: one view per thing management asks about, with every
--      personal field left out. The model's results are sent to OpenAI, and the
--      chat answers in aggregates, so no name, address, email, phone, message
--      text or subject is selected. The comments on these views ARE the schema
--      documentation the model is given — they are read back at request time —
--      so they are written for it.
--   3. `chat_conversations` / `chat_turns` / `chat_queries`: the log. Service
--      role only, like every table here.
--
-- THE VIEWS ARE OWNER-RIGHTS, deliberately, and the one exception in this
-- project to "every view is security_invoker". Every table has RLS on with no
-- policies, so a role that does not bypass RLS reads zero rows through an
-- invoker view. An owner-rights view reads as its owner (`postgres`, which
-- bypasses RLS), and that is safe here for the reason the rule exists: the rule
-- stops the anon key reading past RLS, and nobody but `mgmt_chat_ro` has any
-- privilege on this schema — not anon, not authenticated, not PostgREST, which
-- does not expose `chat`. 17_management_chat.test.mjs asserts all of it.

-- ============================================================== 1. the role

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mgmt_chat_ro') then
    create role mgmt_chat_ro login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$$;

-- Set on the role, so they hold for every session it opens, before the app's own
-- per-query `set local` repeats the timeout. A read-only default is not a
-- privilege boundary (a session may change it) — the absence of any write grant
-- is — but it turns a would-be write into a clear error.
alter role mgmt_chat_ro set default_transaction_read_only = on;
alter role mgmt_chat_ro set statement_timeout = '10s';
alter role mgmt_chat_ro set idle_in_transaction_session_timeout = '15s';
alter role mgmt_chat_ro set search_path = chat;
alter role mgmt_chat_ro connection limit 5;

-- ============================================================== 2. the views

create schema if not exists chat;

comment on schema chat is
  'Read-only views for the management chat (/home). Readable by mgmt_chat_ro only. No personal data.';

revoke all on schema chat from public, anon, authenticated;

create or replace view chat.shop as
  select
    s.shop_name as shop_name,
    s.iana_timezone as iana_timezone,
    s.vip_min_spend as vip_min_spend,
    s.vip_min_orders as vip_min_orders,
    s.vip_window_months as vip_window_months
  from public.shops s;

comment on view chat.shop is
  'One row: the shop. iana_timezone is where a day starts for reporting. The VIP rule is net spend above vip_min_spend AND more than vip_min_orders orders inside the last vip_window_months (all null = no VIP rule set).';

create or replace view chat.orders as
  select
    o.id as order_id,
    o.name as order_name,
    o.order_number as order_number,
    o.customer_id as customer_id,
    o.processed_at as processed_at,
    o.sales_channel_handle as channel,
    o.sales_channel as channel_label,
    o.financial_status as financial_status,
    o.fulfillment_status as fulfillment_status,
    o.return_status as return_status,
    o.order_status as order_status,
    o.cancelled_at as cancelled_at,
    o.cancel_reason as cancel_reason,
    o.closed_at as closed_at,
    o.currency_code as currency_code,
    o.subtotal_price as subtotal_price,
    o.total_discounts as total_discounts,
    o.total_shipping_price as total_shipping_price,
    o.total_tax as total_tax,
    o.total_price as total_price,
    coalesce(o.total_refunded, 0) as total_refunded,
    o.shipping_destination ->> 'country_code' as destination_country_code,
    o.shipping_destination ->> 'country' as destination_country,
    jsonb_array_length(o.line_items) as line_count,
    coalesce(
      (select sum((e ->> 'quantity')::integer) from jsonb_array_elements(o.line_items) as e),
      0
    ) as units,
    o.tags as tags
  from public.orders o
  where o.deleted_at is null;

comment on view chat.orders is
  'One row per Shopify order (all sales channels). Money is in currency_code (EUR). processed_at is when the order was placed (UTC). Join customers on customer_id, order_lines and fulfilment_timing on order_id, tickets on order_number (tickets.shopify_order_number is text).';
comment on column chat.orders.channel is
  'Stable sales channel handle: web = Online Store, amazon = Amazon, connect-dev-1 = Yves Rocher (Mirakl Connect), shopify-draft-orders = Draft Orders, shop-72 = Shop app.';
comment on column chat.orders.total_price is
  'Order total including tax and shipping, after discounts, before refunds.';
comment on column chat.orders.total_refunded is
  'Amount refunded so far; 0 when nothing was refunded.';
comment on column chat.orders.financial_status is
  'Shopify payment state: PAID, PARTIALLY_REFUNDED, REFUNDED, VOIDED, ...';
comment on column chat.orders.fulfillment_status is
  'Shopify fulfilment state: FULFILLED, UNFULFILLED, PARTIALLY_FULFILLED, ...';
comment on column chat.orders.order_status is
  'Derived lifecycle: fulfilled, delivered, cancelled, return_refund_completed, ... "delivered" is only set on the few orders where a delivery was recorded; do not use it to measure delivery.';
comment on column chat.orders.cancelled_at is
  'Set when the order was cancelled. Exclude cancelled orders from sales figures.';
comment on column chat.orders.units is
  'Total quantity across the order''s line items.';
comment on column chat.orders.tags is
  'Merchant tags. Yves Rocher orders carry "Yves Rocher FR".';

create or replace view chat.order_lines as
  select
    o.id as order_id,
    li.ordinality::integer as line_index,
    o.processed_at as processed_at,
    o.sales_channel_handle as channel,
    o.cancelled_at as cancelled_at,
    li.item ->> 'title' as product_title,
    li.item ->> 'variant_title' as variant_title,
    li.item ->> 'sku' as sku,
    li.item ->> 'product_id' as shopify_product_id,
    (li.item ->> 'quantity')::integer as quantity,
    (li.item ->> 'current_quantity')::integer as current_quantity,
    (li.item ->> 'original_total')::numeric as original_total,
    (li.item ->> 'discounted_total')::numeric as discounted_total
  from public.orders o
  cross join lateral jsonb_array_elements(o.line_items) with ordinality as li(item, ordinality)
  where o.deleted_at is null;

comment on view chat.order_lines is
  'One row per line item of an order: what was sold. product_title is the title at the time of sale. Join products on shopify_product_id.';
comment on column chat.order_lines.quantity is
  'Units ordered on this line.';
comment on column chat.order_lines.current_quantity is
  'Units still on the order after removals and refunds.';
comment on column chat.order_lines.discounted_total is
  'Line revenue after line-level discounts (EUR), excluding shipping and order-level adjustments.';

-- READS THE TABLES, NOT public.order_fulfilment_timing. That view is
-- security_invoker, and an invoker view nested in an owner-rights view checks
-- its tables as the QUERYING role — which reads nothing. The lateral block is
-- copied from 06 (the test asserts it). The destination reads `country_code`,
-- the key the order mapper actually writes; 06 reads `countryCode`, which no
-- stored order has.
drop view if exists chat.fulfilment_timing;
create view chat.fulfilment_timing as
  select
    o.id as order_id,
    o.processed_at as processed_at,
    f.first_fulfilled_at as first_fulfilled_at,
    extract(epoch from (f.first_fulfilled_at - o.processed_at)) / 3600.0 as fulfilment_hours,
    public.normalise_carrier(f.carrier_raw) as carrier,
    coalesce(f.fulfilment_count, 0) as fulfilment_count,
    o.shipping_destination ->> 'country_code' as destination_country_code,
    o.sales_channel_handle as channel,
    o.return_status as return_status,
    o.total_refunded as total_refunded
  from public.orders o
  left join lateral (
    select
      min(nullif(e.value ->> 'created_at', '')::timestamptz) as first_fulfilled_at,
      count(*) as fulfilment_count,
      min(t.value ->> 'company') as carrier_raw
    from jsonb_array_elements(o.fulfillments) as e
    left join lateral jsonb_array_elements(
      case when jsonb_typeof(e.value -> 'tracking_info') = 'array'
        then e.value -> 'tracking_info'
        else '[]'::jsonb
      end
    ) as t on true
  ) f on true
  where o.deleted_at is null;

comment on view chat.fulfilment_timing is
  'Per order: how long from placing the order to its first shipment. This is FULFILMENT time. Delivery time is not measurable: no carrier delivery data exists.';
comment on column chat.fulfilment_timing.fulfilment_hours is
  'Hours from processed_at to first_fulfilled_at; null while the order has not shipped.';
comment on column chat.fulfilment_timing.carrier is
  'Carrier of the first shipment, normalised (e.g. Colissimo, Chronopost, DHL).';

create or replace view chat.customers as
  select
    c.id as customer_id,
    c.shopify_created_at as created_at,
    c.state as account_state,
    c.locale as locale,
    c.default_address_country_code as country_code,
    c.number_of_orders as number_of_orders,
    c.amount_spent as amount_spent,
    c.amount_spent_currency as currency_code,
    c.last_order_at as last_order_at,
    c.rfm_group as rfm_group,
    c.email_marketing_state as email_marketing_state,
    c.on_email_marketing_list as on_email_marketing_list
  from public.customers c
  where c.deleted_at is null;

comment on view chat.customers is
  'One row per Shopify customer, as they are NOW (a snapshot, not a history: past states cannot be reconstructed). Marketplace orders (amazon, connect-dev-1) create one synthetic customer per order, so exclude customers whose orders are all on those channels from any per-person metric.';
comment on column chat.customers.account_state is
  'ENABLED (has an account), INVITED, DISABLED. DISABLED is the default for guest checkouts, not a closed account.';
comment on column chat.customers.number_of_orders is
  'Lifetime order count as Shopify reports it.';
comment on column chat.customers.amount_spent is
  'Lifetime spend as Shopify reports it (EUR).';
comment on column chat.customers.rfm_group is
  'Shopify RFM segment: CHAMPIONS, LOYAL, ACTIVE, NEW, PROMISING, NEEDS_ATTENTION, AT_RISK, ALMOST_LOST, DORMANT, PREVIOUSLY_LOYAL, PROSPECTS (never ordered).';
comment on column chat.customers.email_marketing_state is
  'SUBSCRIBED, NOT_SUBSCRIBED, UNSUBSCRIBED, INVALID. Current state only: unsubscribes over time are undercounted.';

create or replace view chat.products as
  select
    p.id as product_id,
    p.shopify_product_id as shopify_product_id,
    p.title as title,
    p.status as status,
    p.vendor as vendor,
    p.product_type as product_type,
    p.tags as tags,
    p.available_stock as available_stock,
    jsonb_array_length(p.variants) as variant_count,
    p.published_at as published_at,
    p.shopify_created_at as created_at
  from public.products p
  where p.deleted_at is null;

comment on view chat.products is
  'The Shopify catalogue as it is now. status: active, draft, archived, unlisted. For what sold, use order_lines.';
comment on column chat.products.available_stock is
  'Units in stock across variants at the last sync; null when not tracked.';

create or replace view chat.promotions as
  select
    p.id as promotion_id,
    p.title as title,
    p.method as method,
    p.discount_type as discount_type,
    p.status as status,
    p.summary as summary,
    p.starts_at as starts_at,
    p.ends_at as ends_at,
    p.usage_limit as usage_limit,
    p.discount_usage_count as discount_usage_count,
    p.applies_once_per_customer as applies_once_per_customer,
    jsonb_array_length(p.codes) as code_count,
    p.offerable_in_replies as offerable_in_replies
  from public.promotions p
  where p.deleted_at is null;

comment on view chat.promotions is
  'Shopify discounts, one row per discount. method: code or automatic. discount_usage_count is how many times it has been used. The codes themselves are not exposed.';

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
    t.closed_at as closed_at
  from public.tickets t
  where t.deleted_at is null;

comment on view chat.tickets is
  'One row per customer-support email thread. Coverage starts when the mailbox sync began: use min(first_message_at) as the start of the data and never report a period before it. Join orders on shopify_order_number = orders.order_name or the order number as text.';
comment on column chat.tickets.status is
  'open, awaiting_customer, awaiting_human, resolved, closed.';
comment on column chat.tickets.category is
  'Subject: order, delivery, product, product_stock, return_exchange, promotions, payment, account, b2b, careers, partner_collaboration, legal_privacy, cosmetovigilance, other. Null when not yet categorised.';
comment on column chat.tickets.level is
  '1 (simple) to 4 (serious, e.g. a skin reaction). Severity, not subject.';
comment on column chat.tickets.happiness is
  'Customer mood read from the mail: 1 happy to 4 very unhappy.';
comment on column chat.tickets.sender_label is
  'internal or contractor when one of our own addresses opened the thread; null for customer threads.';
comment on column chat.tickets.is_duplicate is
  'True when the thread is a duplicate of another ticket; exclude from volume counts.';

-- The tables, not public.ticket_reply_times (which reads another invoker view,
-- ticket_first_inbound), for the reason given on chat.fulfilment_timing. Same
-- rule as 06: the earliest inbound message, then the earliest outbound one
-- after it.
drop view if exists chat.ticket_reply_times;
create view chat.ticket_reply_times as
  select
    t.id as ticket_id,
    fi.received_at as first_inbound_at,
    o.first_outbound_at as first_outbound_at,
    extract(epoch from (o.first_outbound_at - fi.received_at)) / 3600.0 as reply_hours,
    date_trunc('month', fi.received_at)::date as inbound_month
  from public.tickets t
  join lateral (
    select m.received_at as received_at
    from public.ticket_messages m
    where m.ticket_id = t.id
      and m.direction = 'inbound'
      and m.deleted_at is null
    order by m.received_at asc
    limit 1
  ) fi on true
  left join lateral (
    select min(coalesce(m.sent_at, m.received_at)) as first_outbound_at
    from public.ticket_messages m
    where m.ticket_id = t.id
      and m.direction = 'outbound'
      and m.deleted_at is null
      and coalesce(m.sent_at, m.received_at) > fi.received_at
  ) o on true
  where t.deleted_at is null;

comment on view chat.ticket_reply_times is
  'First-response time per ticket: first customer message to the first reply after it. reply_hours is null when the desk has not replied from the synced mailbox.';

-- The table, not public.ticket_message_counts, for the reason given on
-- chat.fulfilment_timing. Same aggregate as 04's view.
drop view if exists chat.ticket_message_counts;
create view chat.ticket_message_counts as
  select
    m.ticket_id as ticket_id,
    count(*) as message_count,
    count(*) filter (where m.direction = 'inbound') as inbound_count,
    max(m.received_at) filter (where m.direction = 'inbound') as latest_inbound_at,
    max(m.sent_at) filter (where m.direction = 'outbound') as latest_outbound_at
  from public.ticket_messages m
  where m.deleted_at is null
  group by m.ticket_id;

comment on view chat.ticket_message_counts is
  'Messages per ticket: total, and how many came from the customer (inbound).';

create or replace view chat.ticket_investigations as
  select
    i.id as investigation_id,
    i.ticket_id as ticket_id,
    i.verdict as verdict,
    i.proposed_level as proposed_level,
    jsonb_array_length(i.established) as established_count,
    jsonb_array_length(i.missing) as missing_count,
    i.model as model,
    i.investigated_at as investigated_at
  from public.ticket_investigations i;

comment on view chat.ticket_investigations is
  'The AI agent''s investigation of a ticket, one per inbound message investigated. verdict: answerable (the agent could answer), needs_customer_input, needs_human.';

create or replace view chat.ticket_drafts as
  select
    d.id as draft_id,
    d.ticket_id as ticket_id,
    d.source_verdict as source_verdict,
    d.disposition as disposition,
    d.level as level,
    d.language as language,
    d.status as status,
    d.checks_passed as checks_passed,
    d.auto_send_eligible as auto_send_eligible,
    (d.approved_body_text is not null) as was_rewritten,
    d.model as model,
    d.drafted_at as drafted_at
  from public.ticket_drafts d;

comment on view chat.ticket_drafts is
  'Replies the AI agent drafted. Nothing is sent automatically. status is the human review decision (pending, approved, edited, rejected); was_rewritten is true when a reviewer changed the text; auto_send_eligible is whether it WOULD have qualified for auto-send.';

create or replace view chat.llm_usage as
  select
    u.ticket_id as ticket_id,
    u.pass as pass,
    u.model as model,
    u.input_tokens as input_tokens,
    u.cached_input_tokens as cached_input_tokens,
    u.output_tokens as output_tokens,
    u.total_tokens as total_tokens,
    u.call_count as call_count,
    u.succeeded as succeeded,
    u.error_kind as error_kind,
    u.occurred_at as occurred_at
  from public.llm_usage u;

comment on view chat.llm_usage is
  'One row per AI model call by the support agent (spam, categorise, decompose, investigate, draft, embed). Tokens only: no prices are stored, so cost cannot be computed here. cached_input_tokens is part of input_tokens, never add them.';

-- normalise_carrier() is called inside public.order_fulfilment_timing. A view
-- checks table access as its owner, but a FUNCTION call as the querying role.
grant execute on function public.normalise_carrier(text) to mgmt_chat_ro;

grant usage on schema chat to mgmt_chat_ro;
revoke all on all tables in schema chat from public, anon, authenticated;
grant select on all tables in schema chat to mgmt_chat_ro;

-- ============================================================== 3. the log

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The Supabase auth.users id of whoever started it. No foreign key: auth is
  -- Supabase's schema, and data_access_events.actor_id makes the same choice.
  user_id uuid not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_conversations_user_idx
  on public.chat_conversations (shop_id, user_id, updated_at desc);

drop trigger if exists chat_conversations_set_updated_at on public.chat_conversations;
create trigger chat_conversations_set_updated_at
  before update on public.chat_conversations
  for each row execute function public.set_updated_at();

alter table public.chat_conversations enable row level security;
revoke all on public.chat_conversations from anon, authenticated;

comment on table public.chat_conversations is
  'A management chat thread (/home). Owned by one dashboard user; the title is the first question.';

create table if not exists public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  asked_by uuid not null,
  question text not null,
  -- Null while running, and on an error that produced nothing to show.
  answer text,
  status text not null default 'running',
  error text,
  model text not null,
  steps integer not null default 0,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  duration_ms integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint chat_turns_status_check check (
    status in ('running', 'ok', 'step_limit', 'empty', 'error')
  )
);

create index if not exists chat_turns_conversation_idx
  on public.chat_turns (conversation_id, created_at);

alter table public.chat_turns enable row level security;
revoke all on public.chat_turns from anon, authenticated;

comment on table public.chat_turns is
  'One question and its answer in a management chat, with the model, step count, token usage and duration. Tokens are kept here and NOT in llm_usage, which answers what the support mailbox costs.';

create table if not exists public.chat_queries (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.chat_turns(id) on delete cascade,
  step integer not null,
  sql text not null,
  ok boolean not null,
  row_count integer not null default 0,
  truncated boolean not null default false,
  duration_ms integer not null default 0,
  error text,
  columns text[] not null default '{}',
  -- The first rows, so a reopened conversation still shows what an answer was
  -- based on. Aggregates over views that hold no personal data.
  rows_preview jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint chat_queries_rows_preview_array_check check (jsonb_typeof(rows_preview) = 'array')
);

create index if not exists chat_queries_turn_idx on public.chat_queries (turn_id, step);

alter table public.chat_queries enable row level security;
revoke all on public.chat_queries from anon, authenticated;

comment on table public.chat_queries is
  'Every SQL query the management chat ran or tried to run: the text, whether it was refused or failed and why, rows returned, whether it hit the 1,000-row cap, and time taken.';
