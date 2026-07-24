-- Support ticketing for the agent email workflow (see AGENT_INTEGRATION_PLAN.md).
--
-- A ticket is a *conversation*, not a single email: inbound mail is grouped by
-- Microsoft Graph conversationId, so a back-and-forth thread is one ticket with
-- many ticket_messages. The tickets row is the record the categorising agent
-- fills out (category, level, responsible_team, resolved Shopify order number),
-- while ticket_messages hold the individual emails.
--
-- Personal-data minimisation (AGENTS.md): the ticket row itself stores only a
-- hash of the requester email (for order matching and dedup) plus a display
-- name. The raw email addresses needed to actually send replies live on
-- ticket_messages, where they are strictly required for the task. Nothing here
-- should be placed into AI prompts unless strictly required.
--
-- The agent context bundle, message embeddings, secondary category, priority,
-- and retention lifecycle are added in 008_tickets_agent_context.sql.

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  graph_conversation_id text not null,
  subject text,
  status text not null default 'open',

  -- Filled by the categorising agent (Phase 3); free-form until the support
  -- taxonomy is finalised, mirroring knowledge_documents.category.
  category text,
  level smallint,
  responsible_team text,

  -- Source-of-truth lookup key resolved by the order-number tool (Phase 4).
  shopify_order_number text,
  customer_id uuid references public.customers(id) on delete set null,

  -- Hash of the requester email: lets us match against orders.customer_email_hash
  -- and dedup by sender without duplicating the raw address on this row.
  requester_email_hash text,
  requester_name text,

  first_message_at timestamptz,
  last_message_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tickets_shop_conversation_unique unique (shop_id, graph_conversation_id),
  constraint tickets_status_check check (
    status in (
      'open',
      'awaiting_customer',
      'awaiting_human',
      'forwarded',
      'resolved',
      'closed',
      'spam'
    )
  ),
  constraint tickets_level_check check (level is null or level between 1 and 4),
  constraint tickets_responsible_team_check check (
    responsible_team is null
      or responsible_team in ('finance', 'marketing', 'sales', 'logistics', 'contact')
  ),
  constraint tickets_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,

  graph_message_id text not null,
  graph_conversation_id text not null,
  internet_message_id text,
  in_reply_to text,

  direction text not null,
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text,
  body_text text,
  body_preview text,
  has_attachments boolean not null default false,

  received_at timestamptz,
  sent_at timestamptz,

  raw_graph_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ticket_messages_shop_message_unique unique (shop_id, graph_message_id),
  constraint ticket_messages_direction_check check (
    direction in ('inbound', 'outbound')
  ),
  constraint ticket_messages_raw_payload_object_check check (
    jsonb_typeof(raw_graph_payload) = 'object'
  )
);

create index tickets_shop_status_idx on public.tickets (shop_id, status);
create index tickets_shop_category_idx on public.tickets (shop_id, category);
create index tickets_shop_level_idx on public.tickets (shop_id, level);
create index tickets_shop_responsible_team_idx on public.tickets (shop_id, responsible_team);
create index tickets_shop_order_number_idx on public.tickets (shop_id, shopify_order_number);
create index tickets_shop_requester_email_hash_idx on public.tickets (shop_id, requester_email_hash);
create index tickets_customer_id_idx on public.tickets (customer_id);
create index tickets_shop_last_message_at_idx on public.tickets (shop_id, last_message_at);
create index tickets_shop_deleted_at_idx on public.tickets (shop_id, deleted_at);

create index ticket_messages_ticket_id_idx on public.ticket_messages (ticket_id);
create index ticket_messages_shop_conversation_idx on public.ticket_messages (shop_id, graph_conversation_id);
create index ticket_messages_shop_received_at_idx on public.ticket_messages (shop_id, received_at);
create index ticket_messages_shop_deleted_at_idx on public.ticket_messages (shop_id, deleted_at);

create trigger tickets_set_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

create trigger ticket_messages_set_updated_at
before update on public.ticket_messages
for each row
execute function public.set_updated_at();

alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;

comment on table public.tickets is
  'Support conversations for the agent email workflow. One ticket per Microsoft Graph conversationId; the categorising agent fills category, level, responsible_team, and the resolved Shopify order number. Access through the service-role worker only until dashboard roles and policies are implemented.';

comment on column public.tickets.graph_conversation_id is
  'Microsoft Graph conversationId. The threading key: all emails in one thread share this value and roll up to a single ticket, so tickets behave as conversations rather than individual emails.';

comment on column public.tickets.status is
  'Ticket lifecycle: open, awaiting_customer, awaiting_human, forwarded, resolved, closed, or spam. In draft-only mode nothing is auto-sent, so agent-drafted replies sit at awaiting_human until approved.';

comment on column public.tickets.category is
  'Support category set by the categorising agent (e.g. order question, delivery issue, product question). Intentionally unrestricted until the support taxonomy is finalised.';

comment on column public.tickets.level is
  'Handling level 1-4 set by the categorising agent: 1 question only (no human), 2 data lookup (no human, may suggest action), 3 state-changing (human action), 4 sensitive (manager action).';

comment on column public.tickets.responsible_team is
  'Team a forwarded ticket belongs to: finance, marketing, sales, logistics, or contact. The worker forwards B2B/invoice/marketing-type mail to the implicated person and tags the ticket here.';

comment on column public.tickets.shopify_order_number is
  'Shopify order number resolved for this ticket (the workflow''s source-of-truth lookup key). Stored as text to preserve the customer-facing #XXXX form; matched against orders.name / orders.order_number by the order-lookup tool.';

comment on column public.tickets.customer_id is
  'Optional link to the local customer snapshot once the requester is matched. Null for unresolved or guest requesters.';

comment on column public.tickets.requester_email_hash is
  'Hash of the requester email, for matching against orders.customer_email_hash and deduping by sender without storing the raw address on the ticket. The raw reply address lives on the latest inbound ticket_messages row.';

comment on column public.tickets.requester_name is
  'Display name of the requester for the dashboard queue. Do not include in AI prompts unless strictly required.';

comment on table public.ticket_messages is
  'Individual emails belonging to a ticket, one row per Microsoft Graph message. Inbound mail is ingested here idempotently (unique on shop_id + graph_message_id); outbound rows are the agent replies and team forwards.';

comment on column public.ticket_messages.graph_message_id is
  'Microsoft Graph message id. The idempotency key: re-ingesting the same email is a no-op via the shop_id + graph_message_id unique constraint.';

comment on column public.ticket_messages.internet_message_id is
  'RFC 5322 Message-ID header, stable across mail systems. Useful for threading and correlating replies independently of Graph ids.';

comment on column public.ticket_messages.direction is
  'inbound (from the customer/third party) or outbound (agent reply or team forward sent from the support mailbox).';

comment on column public.ticket_messages.from_email is
  'Raw sender email. Required to reply to the requester; do not include in AI prompts unless strictly required.';

comment on column public.ticket_messages.body_text is
  'Cleaned plain-text email body used for triage, categorisation, and drafting. Minimise personal data and keep it out of AI prompts unless strictly required for the task.';

comment on column public.ticket_messages.raw_graph_payload is
  'Sanitised raw Microsoft Graph message payload for traceability. Exclude attachment binaries and unnecessary personal data.';
