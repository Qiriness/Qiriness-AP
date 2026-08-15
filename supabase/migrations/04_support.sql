-- ============================================================================
-- 04 — SUPPORT WORKFLOW
-- The email desk: tickets and their messages, the two-pass spam gate and its
-- audit trail, the investigation case file, forwarding, and the human review set.
--
-- ORDER WITHIN THIS FILE IS A DEPENDENCY CHAIN: tickets -> ticket_messages ->
-- (email_blocklist -> spam_audit) -> ticket_investigations -> category_forwarding
-- -> ticket_forwards. Nothing here may be reordered without checking the foreign
-- keys. `sender_directory` sits outside that chain (it references only shops) and
-- is filed beside email_blocklist because it shares its matching.
--
-- SPAM NEVER BECOMES A TICKET. Both gates drop mail before the first insert, so
-- `spam_audit` is the only trace a blocked email leaves and is what makes a
-- wrong drop reviewable at all — see its comment for why that now includes the
-- body, and under what expiry.
--
-- `tickets.category` / `.request_kind` carry the two axes of the shared support
-- taxonomy (subject and kind, stored separately and never composed). See
-- 03_knowledge.sql for the shared half of that vocabulary.
--
-- Requires: 01_foundation.sql (shops) and 02_shopify.sql (customers).
-- ============================================================================

-- ---------------------------------------------------------------- tickets

-- One row per Graph conversation, not per email.
--
-- TWO TAXONOMY AXES, STORED SEPARATELY:
--   category / secondary_category      -> SUBJECT: what the email is about (the
--                                         same 14 knowledge articles use, so a
--                                         ticket subject filters straight into
--                                         matching knowledge chunks)
--   request_kind / secondary_...       -> KIND: what the sender wants
--                                         (question | problem | complaint | contact)
--
-- "order_problem" as one composed value would need stripping back to "order" for
-- every knowledge lookup, and would make the categoriser pick 1-of-23 flat
-- strings instead of 1-of-14 plus 1-of-4 (measurably easier for a cheap-tier
-- model, same expressiveness). The composed form is a display concern only.
-- `complaint` is a KIND, not a subject, so a delivery complaint is
-- (delivery, complaint).
--
-- TWO QUEUE FLAGS, both booleans rather than a `<stage>_at < last_message_at`
-- comparison, for two reasons: PostgREST compares a column to a literal and
-- never to another column, so the worker's REST client cannot express that
-- filter; and last_message_at also advances on OUR outbound replies, so a
-- timestamp rule would re-run the model every time the agent answered.
-- needs_categorisation defaults TRUE (a ticket can never be created in a state
-- the categoriser does not look at); needs_investigation defaults FALSE (a
-- ticket that has never been categorised has no subject to choose tools from).
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  graph_conversation_id text not null,
  subject text,
  status text not null default 'open',

  -- The categorisation axes.
  category text,
  secondary_category text,
  request_kind text,
  secondary_request_kind text,
  level smallint,
  responsible_team text,

  -- Source-of-truth lookup key resolved by the order-number tool.
  shopify_order_number text,
  customer_id uuid references public.customers(id) on delete set null,

  -- Hash of the requester email: lets us match against orders.customer_email_hash
  -- and dedup by sender without duplicating the raw address on this row.
  requester_email_hash text,
  requester_name text,

  -- Categoriser queue + the signals it reads off the same email in one call.
  needs_categorisation boolean not null default true,
  categorised_at timestamptz,
  categorisation_confidence text,
  language text,
  happiness smallint,

  -- Investigation queue. ONE WRITER RAISES IT: the categoriser, in the same
  -- patch that clears needs_categorisation. Ingestion does not touch it — a new
  -- inbound message raises needs_categorisation, the categoriser re-labels the
  -- thread and then re-raises this. That ordering is what stops a ticket being
  -- investigated with a tool set chosen from the previous conversation's subject.
  needs_investigation boolean not null default false,
  investigated_at timestamptz,

  priority smallint not null default 3,
  resolved_context jsonb not null default '{}'::jsonb,
  context_resolved_at timestamptz,

  first_message_at timestamptz,
  last_message_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,

  -- Retention lifecycle. archived_at keeps the ticket but drops it out of the
  -- active queue; deleted_at is the separate compliance soft-delete.
  resolved_at timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,
  retention_delete_after timestamptz,
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
  constraint tickets_priority_check check (priority between 1 and 5),
  constraint tickets_responsible_team_check check (
    responsible_team is null
      or responsible_team in ('finance', 'marketing', 'sales', 'logistics', 'contact')
  ),
  constraint tickets_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint tickets_resolved_context_object_check check (
    jsonb_typeof(resolved_context) = 'object'
  ),
  -- Subjects: the shared 14. Deliberately excludes the knowledge-only faq and
  -- brand_story.
  constraint tickets_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  constraint tickets_secondary_category_check check (
    secondary_category is null or secondary_category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  constraint tickets_request_kind_check check (
    request_kind is null or request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  constraint tickets_secondary_request_kind_check check (
    secondary_request_kind is null
      or secondary_request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  -- A secondary kind without a secondary subject is meaningless; the subject is
  -- what the kind qualifies.
  constraint tickets_secondary_pair_check check (
    secondary_request_kind is null or secondary_category is not null
  ),
  -- A marker that the labels are known to be untrustworthy, NOT a model
  -- self-assessment: only `low` is written, and only when categorisation failed.
  -- `high`/`medium` stay permitted so a future calibrated signal can land here
  -- without a migration. See the column comment.
  constraint tickets_categorisation_confidence_check check (
    categorisation_confidence is null
      or categorisation_confidence in ('high', 'medium', 'low')
  ),
  -- The language to REPLY in, restricted to what the desk can actually write.
  -- 'other' is a routing signal (a human takes it), not a label.
  constraint tickets_language_check check (
    language is null or language in ('fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other')
  ),
  -- 1 happy .. 4 really unhappy. Same direction as level (1 benign, 4 the one
  -- you want to see) but deliberately independent of it — level is what WORK a
  -- ticket needs, happiness is how the customer FEELS.
  constraint tickets_happiness_check check (
    happiness is null or happiness between 1 and 4
  )
);

create index tickets_shop_status_idx on public.tickets (shop_id, status);

create index tickets_shop_category_idx on public.tickets (shop_id, category);

create index tickets_shop_secondary_category_idx on public.tickets (shop_id, secondary_category);

create index tickets_shop_level_idx on public.tickets (shop_id, level);

create index tickets_shop_priority_idx on public.tickets (shop_id, priority);

create index tickets_shop_responsible_team_idx on public.tickets (shop_id, responsible_team);

create index tickets_shop_order_number_idx on public.tickets (shop_id, shopify_order_number);

create index tickets_shop_requester_email_hash_idx on public.tickets (shop_id, requester_email_hash);

create index tickets_customer_id_idx on public.tickets (customer_id);

create index tickets_shop_last_message_at_idx on public.tickets (shop_id, last_message_at);

create index tickets_shop_archived_at_idx on public.tickets (shop_id, archived_at);

create index tickets_retention_delete_after_idx on public.tickets (shop_id, retention_delete_after);

create index tickets_shop_deleted_at_idx on public.tickets (shop_id, deleted_at);

-- The queue filters and groups on (subject, kind) together.
create index tickets_shop_category_kind_idx
  on public.tickets (shop_id, category, request_kind);

-- The worker's pending query: pending tickets only, oldest first. Partial, so
-- the index holds the backlog rather than the whole table -- in steady state
-- almost every ticket is already categorised and drops straight out of it.
create index tickets_pending_categorisation_idx
  on public.tickets (shop_id, first_message_at)
  where needs_categorisation;

-- Partial index: the queue reads only the flagged rows, and on a table where
-- almost none are flagged at rest a full index would be mostly dead weight.
create index tickets_needs_investigation_idx
  on public.tickets (shop_id, first_message_at)
  where needs_investigation;

create trigger tickets_set_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

alter table public.tickets enable row level security;

comment on table public.tickets is
  'Support conversations for the agent email workflow. One ticket per Microsoft Graph conversationId; the categorising agent fills category, request_kind, level, responsible_team, and the resolved Shopify order number. Access through the service-role worker only until dashboard roles and policies are implemented.';

comment on column public.tickets.graph_conversation_id is
  'Microsoft Graph conversationId. The threading key: all emails in one thread share this value and roll up to a single ticket, so tickets behave as conversations rather than individual emails.';

comment on column public.tickets.status is
  'Ticket lifecycle: open, awaiting_customer, awaiting_human, forwarded, resolved, closed, or spam. In draft-only mode nothing is auto-sent, so agent-drafted replies sit at awaiting_human until approved.';

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

comment on column public.tickets.priority is
  'Queue priority 1 (highest) to 5 (lowest), set by the prioritiser from RFM group, level, and age. Defaults to 3 (normal) so the queue sorts before prioritisation runs.';

comment on column public.tickets.resolved_context is
  'Order/customer context bundle the order-context resolver assembles from the synced orders/customers rows once shopify_order_number is set (tracking, order name, order-customer name, RFM group, etc.), handed to the drafting agent so it does not query fields individually. A re-resolvable snapshot, not a source of truth and not a duplicate of first-class order columns; may be edited for human-in-the-loop review. Holds personal data, so it must be scoped, kept out of prompts unless strictly required, and redacted on compliance requests. Excludes billing/street address (never synced; gated live Shopify lookup only).';

comment on column public.tickets.context_resolved_at is
  'When resolved_context was last assembled. Lets the worker re-resolve stale context rather than trusting the snapshot as source of truth.';

comment on column public.tickets.resolved_at is
  'When the ticket moved to resolved. Retention anchor for how long resolved tickets are kept.';

comment on column public.tickets.closed_at is
  'When the ticket was closed. Retention anchor for archival and eventual deletion.';

comment on column public.tickets.archived_at is
  'When the ticket was archived out of the active queue while still retained. Set by the archival job for old tickets; distinct from deleted_at.';

comment on column public.tickets.retention_delete_after is
  'Timestamp after which the ticket may be hard-deleted by the retention cleanup job. Durations are policy-driven and set later; the column is the mechanism, not a fixed rule.';

comment on column public.tickets.deleted_at is
  'Soft-delete / compliance-redaction flag. Distinct from archived_at (archival keeps the ticket; deletion removes it, e.g. on a customer redact request).';

comment on column public.tickets.category is
  'Primary subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs -- the same 14 subjects knowledge articles use, so a ticket subject filters straight into the matching knowledge chunks. No subject implies a handling level on its own; cosmetovigilance floors at level 2 for a reported reaction (see the level comment).';

comment on column public.tickets.secondary_category is
  'Optional second subject when one email spans two topics (an order problem plus a stock question). Same vocabulary as category.';

comment on column public.tickets.request_kind is
  'What the sender wants about the primary subject: question (answerable from knowledge), problem (needs an action), complaint (dissatisfaction, never auto-handled), contact (inbound B2B/partnership/careers, forwarded to a team). Kept separate from category so knowledge retrieval can filter on subject alone.';

comment on column public.tickets.secondary_request_kind is
  'Kind for secondary_category, since a second subject can be a different kind (an order problem plus a stock question). Null unless secondary_category is set.';

comment on column public.tickets.level is
  'Handling level 1-4, derived from (category, request_kind) by defaultLevel() in scripts/lib/support-taxonomy.mjs: 1 answerable from general knowledge, 2 needs the customer''s own record consulted and answered (no change), 3 needs something changed (refund, resend, cancellation, address change, commercial gesture). Subjects whose answers live in the database (order, delivery, payment, account, product_stock, promotions) floor at 2 for BOTH questions and problems, because most problems there are resolved by looking something up; the categoriser escalates to 3 itself when the fix requires a change. Level 4 is a SEVERITY judgement and is NOT derived from any subject -- reserved for an explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger, so it can only arrive as a categoriser escalation and should be rare. The categoriser may escalate above the derived floor but never below it, and a re-categorisation may raise a stored level but never lower it (ratchetLevel).';

comment on column public.tickets.needs_categorisation is
  'True when the ticket is waiting for the categoriser. Set on insert (default) and set again by ingestion whenever a new INBOUND message joins the thread, because a reply can change the subject, the kind and above all the level; cleared when the worker writes fresh labels. A flag rather than a categorised_at < last_message_at comparison: PostgREST cannot compare two columns, and last_message_at also advances on our own outbound replies, which must not trigger a re-run.';

comment on column public.tickets.categorised_at is
  'When the current labels were written. Distinct from updated_at, which any other write also moves, so this is what tells you how stale a label is relative to last_message_at.';

comment on column public.tickets.categorisation_confidence is
  'Marker that this ticket''s labels are known to be untrustworthy. NOT a model self-assessment: the categoriser was originally asked how sure it was and answered "high" on 171 of 171 real tickets and 40 of 40 review cases, because Structured Outputs emits fields in order, so it was rating an answer it had already committed to in the same forward pass. A constant field carries no information, so the question was dropped. Today only "low" is written, and only by the categoriser''s failure paths: a categorisation that exhausted its retries, or stale labels on a ticket whose re-categorisation errored. A successfully categorised ticket is NULL. "high" and "medium" remain permitted by the constraint but nothing writes them -- they are kept so a future calibrated signal (sampling for agreement, or token logprobs) can land here without a migration.';

comment on column public.tickets.language is
  'Language the reply should be written in (fr, en, es, de, it, nl, pt, other), read from the customer''s own message by the categoriser. The mailbox is mostly French but not exclusively, and the drafting agent needs this before it writes a word. ''other'' means the desk cannot answer natively -- route to a human rather than guessing.';

comment on column public.tickets.happiness is
  'How the customer feels: 1 happy, 2 neutral, 3 discontent expressed, 4 really unhappy (threatening to stop buying, calling the situation unacceptable, or chasing an unanswered thread). Same direction as level, but NOT derived from it and it does not feed it: level is what WORK the ticket needs, happiness is how the customer feels about it. An angry customer with a simple tracking question is happiness 4, level 2 -- both true. Deriving one from the other would make a mood imply a severity and fill the manager queue with routine mail. Consumed by the drafting agent to set tone.';

comment on column public.tickets.needs_investigation is
  'Pending flag for the investigation pass. Raised by the categoriser when it finishes labelling a ticket (and again on each re-categorisation), cleared by the investigation pass. Default false because an uncategorised ticket has no subject from which to choose tools.';

comment on column public.tickets.investigated_at is
  'When the last case file was written. Not a queue predicate -- needs_investigation is; this is for reporting and for spotting a ticket whose case file predates its latest reply.';

-- ---------------------------------------------------------------- ticket_messages

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

  -- Semantic vectors of the email body for similar-ticket retrieval, reusing the
  -- knowledge_chunks determinism pattern. Cheap at support-email volume.
  embedding vector(1536),
  embedding_model text,
  embedding_dimensions integer,
  embedded_input_hash text,
  embedded_at timestamptz,

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
  ),
  -- The same guard knowledge_chunks and support_exemplar_phrasings carry. This
  -- table copied the determinism quadruple from knowledge_chunks and did not
  -- copy the constraint, which is the drift that made the whole pattern worth
  -- asserting across files rather than trusting three tables to keep agreeing.
  -- Null until the row is embedded; 1536 once it is, and nothing else.
  constraint ticket_messages_embedding_dimensions_check check (
    embedding_dimensions is null or embedding_dimensions = 1536
  )
);

create index ticket_messages_ticket_id_idx on public.ticket_messages (ticket_id);

create index ticket_messages_shop_conversation_idx on public.ticket_messages (shop_id, graph_conversation_id);

create index ticket_messages_shop_received_at_idx on public.ticket_messages (shop_id, received_at);

create index ticket_messages_shop_deleted_at_idx on public.ticket_messages (shop_id, deleted_at);

create index ticket_messages_embedding_hnsw_idx on public.ticket_messages using hnsw (embedding vector_cosine_ops);

create trigger ticket_messages_set_updated_at
before update on public.ticket_messages
for each row
execute function public.set_updated_at();

alter table public.ticket_messages enable row level security;

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

comment on column public.ticket_messages.embedding is
  'pgvector(1536) embedding of the email body (text-embedding-3-small) for similar-ticket retrieval and clustering, populated primarily for inbound messages. Matches the knowledge_chunks embedding pipeline; a row holds a vector iff embedded_input_hash/model/dimensions match the current input and model.';

comment on column public.ticket_messages.embedded_input_hash is
  'Hash of the embedded input (body text + relevant metadata) so a reconciler can detect stale vectors and re-embed on model or content changes, mirroring knowledge_chunks determinism metadata.';

comment on column public.ticket_messages.raw_graph_payload is
  'Sanitised raw Microsoft Graph message payload for traceability. Exclude attachment binaries and unnecessary personal data.';

-- ---------------------------------------------------------------- email_blocklist

-- ============================================================================
-- THE TWO-PASS SPAM GATE
--
-- Both passes drop mail BEFORE anything is written to tickets/ticket_messages,
-- so blocked spam never becomes a ticket:
--   pass 1  email_blocklist  — deterministic sender/domain match, no LLM
--   pass 2  cheap-tier LLM classifier, new conversations only, fails open
--
-- Replies into an existing ticket are never triaged, so a genuine follow-up can
-- never be discarded — and produces no audit row, because no decision was made.
-- ============================================================================

-- A rule matches by exact sender email or by sender domain. Adding a rule also
-- purges any already-stored mail from that sender (the worker's add-rule flow),
-- so "blacklist this address" removes their spam past and future.
create table public.email_blocklist (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  pattern_type text not null,
  pattern text not null,
  reason text,
  created_by text not null default 'system',

  -- Observability: how often this rule has blocked something.
  hit_count integer not null default 0,
  last_hit_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint email_blocklist_shop_pattern_unique unique (shop_id, pattern_type, pattern),
  constraint email_blocklist_pattern_type_check check (pattern_type in ('email', 'domain')),
  constraint email_blocklist_hit_count_check check (hit_count >= 0)
);

create index email_blocklist_shop_pattern_idx on public.email_blocklist (shop_id, pattern_type, pattern);

create trigger email_blocklist_set_updated_at
before update on public.email_blocklist
for each row
execute function public.set_updated_at();

alter table public.email_blocklist enable row level security;

comment on table public.email_blocklist is
  'Deterministic sender blocklist for the agent email workflow. Matched senders are dropped at ingestion before any ticket/message is stored, so blocked spam never consumes storage. Service-role worker only until dashboard roles and policies exist.';

comment on column public.email_blocklist.pattern_type is
  'email (exact sender address) or domain (sender domain, e.g. spammer.example). Patterns are stored normalised (trimmed, lowercased; domain without a leading @).';

comment on column public.email_blocklist.pattern is
  'The normalised sender email or domain to block. Matched case-insensitively against the inbound sender at ingestion.';

comment on column public.email_blocklist.hit_count is
  'Number of inbound messages this rule has blocked. Bumped by the ingestion worker; last_hit_at records the most recent block.';

-- ---------------------------------------------------------------- sender_directory

-- ============================================================================
-- WHO IS WRITING TO US — the sender reference table
--
-- Same shape as email_blocklist above (per-shop email-or-domain patterns matched
-- against the inbound sender), and deliberately so: that matching is already
-- built, already tested, and already handles subdomains. This table asks the
-- other question. The blocklist decides whether mail is stored at all; this one
-- says what the sender IS, for mail that passed.
--
-- WHY IT IS A TABLE AND NOT CONFIG. It replaces INTERNAL_EMAIL_DOMAINS, an env
-- var, and the reason is a measured failure rather than a preference. Moving to
-- a new Supabase project carried the data across and left the env behind, so 43
-- inbound messages from our own second domain were counted as customer demand —
-- the clustering report that decides which knowledge article to write next
-- ranked an internal reorder thread sixth. A domain list is a business fact
-- about who we work with; it belongs with the business data, and it travels.
--
-- LABELS ARE CONTEXT, NOT BEHAVIOUR. They exist so an agent in doubt can ask
-- "who is this?" and get an answer — read into the case file deterministically
-- before the model is asked anything, never as a tool call, because a sender is
-- something we always know and a tool call is a round trip to learn it.
--
-- Exactly one pass branches on them, and it is a report rather than a customer
-- outcome: the clustering script drops non-demand labels so the writing order
-- reflects customers. Nothing here should ever gate a reply — a `retailer` is a
-- real correspondent asking real questions, just not consumer ones.
--
-- ROWS ARE EXCEPTIONS. Absence means an ordinary consumer, so this stays a
-- dozen rows a person maintains, never a directory of every gmail address.
create table public.sender_directory (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  pattern_type text not null,
  pattern text not null,

  -- Constrained rather than free text, because code compares against these
  -- values: an unconstrained column would let "Internal" and "internal" mean
  -- the same thing to a person and different things to the clustering filter.
  -- Adding a label is a deliberate migration, which is the right cost when a
  -- pass reads it.
  label text not null,

  -- Free text for whoever reads the ticket, human or model: "3PL warehouse --
  -- parcel disputes are settled here, not with the courier". Optional, and NOT
  -- a second taxonomy: nothing branches on it, it is carried into the case file
  -- verbatim as the context a colleague would have given out loud.
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sender_directory_shop_pattern_unique unique (shop_id, pattern_type, pattern),
  constraint sender_directory_pattern_type_check check (pattern_type in ('email', 'domain')),
  constraint sender_directory_label_check check (
    label in (
      'internal', 'contractor', 'logistics', 'courier',
      'retailer', 'distributor', 'supplier', 'partner', 'other'
    )
  )
);

create index sender_directory_shop_pattern_idx on public.sender_directory (shop_id, pattern_type, pattern);

create trigger sender_directory_set_updated_at
before update on public.sender_directory
for each row
execute function public.set_updated_at();

alter table public.sender_directory enable row level security;

comment on table public.sender_directory is
  'Who a sender is to us, by email address or domain. Read as context (into the investigation case file) and by the clustering report to tell customer demand from our own mail. Replaces the INTERNAL_EMAIL_DOMAINS env var, which did not survive a project move. Rows are exceptions -- an unlisted sender is an ordinary consumer.';

comment on column public.sender_directory.pattern_type is
  'email (exact sender address) or domain (sender domain). Matched exactly like email_blocklist, subdomains included: a domain rule for deret.fr also matches mail.deret.fr.';

comment on column public.sender_directory.label is
  'What this sender is to us. internal and contractor are us; logistics and courier are operational counterparties; retailer, distributor, supplier and partner are commercial ones whose mail is real demand, just not consumer demand.';

comment on column public.sender_directory.note is
  'Optional free text carried verbatim into the case file, for the context a colleague would give out loud. Nothing branches on it.';

-- ---------------------------------------------------------------- spam_audit

-- One row per decision the gate actually made.
--
-- Why this table exists: because both passes drop mail before any write, a
-- blocked email would otherwise leave no trace at all, making a wrong drop
-- invisible and unreviewable. This table is that trace.
--
-- PERSONAL-DATA NOTE. It stores the sender address, the subject AND — on a
-- `blocked` outcome — the cleaned body. The body is here because the one
-- question a reviewer has is *should this have become a ticket?*, and a subject
-- line does not answer it: "Votre commande" is a newsletter or a customer whose
-- parcel is lost, and the corpus contains both. Kept only on a block (a kept
-- email is written to ticket_messages in full a moment later, and copying it
-- here would duplicate personal data into a second table with a second clock),
-- and under its OWN expiry: body_expires_at is nulled by the worker's per-poll
-- purge while the decision row is kept indefinitely. Bounded review window,
-- unbounded audit trail.
create table public.spam_audit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- Idempotency key: re-ingesting the same Graph message re-records the one
  -- decision for it rather than appending a duplicate.
  graph_message_id text not null,
  graph_conversation_id text,

  outcome text not null,
  decided_by text not null,
  reason text not null,
  label text,

  from_email text,
  subject text,

  -- Cleaned plain text, capped in code. Never the raw HTML: the reviewer needs
  -- to read it, not to render it, and stored markup is a payload nobody in this
  -- path asked for. body_captured_at null means never captured, which is a
  -- different state from captured-and-since-expired.
  body_text text,
  body_captured_at timestamptz,
  body_expires_at timestamptz,

  -- Provenance of the decision: which model ruled (LLM pass), or which blocklist
  -- rule matched (deterministic pass). failed_open marks a keep that happened
  -- because the classifier errored, not because the email was judged legitimate.
  model text,
  blocklist_rule_id uuid references public.email_blocklist(id) on delete set null,
  failed_open boolean not null default false,

  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint spam_audit_shop_message_unique unique (shop_id, graph_message_id),
  constraint spam_audit_outcome_check check (outcome in ('kept', 'blocked')),
  constraint spam_audit_decided_by_check check (decided_by in ('blocklist', 'llm')),
  constraint spam_audit_label_check check (label is null or label in ('keep', 'spam', 'irrelevant'))
);

-- Review queries are "what did the gate decide lately" and "show me the blocks".
create index spam_audit_shop_decided_at_idx on public.spam_audit (shop_id, decided_at desc);

create index spam_audit_shop_outcome_idx on public.spam_audit (shop_id, outcome, decided_at desc);

-- The purge's own query: rows whose body has expired. Partial, because once the
-- text is gone the row is of no further interest to that pass and the index
-- should not carry it — on this table the vast majority of rows will be in that
-- state at any time.
create index spam_audit_body_expiry_idx
  on public.spam_audit (shop_id, body_expires_at)
  where body_text is not null;

create trigger spam_audit_set_updated_at
before update on public.spam_audit
for each row
execute function public.set_updated_at();

alter table public.spam_audit enable row level security;

comment on table public.spam_audit is
  'Audit trail for the agent ingestion spam gate: one row per decision, recording kept/blocked and a one-line reason. Exists because both passes drop mail before any ticket is written, so a blocked email would otherwise leave no trace. Stores sender address and subject (never the body) as decision metadata. Service-role worker only until dashboard roles and policies exist.';

comment on column public.spam_audit.outcome is
  'kept (the email was written to tickets/ticket_messages) or blocked (dropped before any write).';

comment on column public.spam_audit.decided_by is
  'blocklist (deterministic email/domain rule, first pass) or llm (cheap-tier classifier, second pass, new conversations only).';

comment on column public.spam_audit.reason is
  'One short line explaining the decision. For an LLM keep the model was not confident about, this is literally "unsure" -- the fail-safe "when in doubt, keep" path is recorded as such rather than as a positive judgement.';

comment on column public.spam_audit.label is
  'The LLM classifier label (keep | spam | irrelevant). Null for blocklist decisions, which have no label.';

comment on column public.spam_audit.failed_open is
  'True when the email was kept only because the classifier errored or was unavailable. The gate fails open by design; this column makes those keeps distinguishable from judged-legitimate ones.';

comment on column public.spam_audit.from_email is
  'Sender address of the audited email. Kept so a decision can be reviewed and a repeat spammer turned into an email_blocklist rule; this is the deliberate narrow exception to not storing blocked mail.';

comment on table public.spam_audit is
  'Audit trail for the agent ingestion spam gate: one row per decision, recording kept/blocked and a one-line reason. Exists because both passes drop mail before any ticket is written, so a blocked email would otherwise leave no trace. Stores sender address, subject AND the cleaned body (see 08) as the evidence a human needs to judge whether a drop was right. The body expires on its own clock (body_expires_at) and is nulled by the worker; the decision row is kept indefinitely. Service-role worker only until dashboard roles and policies exist.';

comment on column public.spam_audit.body_text is
  'Cleaned plain-text body of the dropped email, capped in code. THE REASON THE TABLE IS REVIEWABLE: a subject line cannot distinguish a newsletter from a customer whose parcel is lost, so without this a reviewer cannot judge the gate''s decision at all. Retained personal data with a bounded life -- nulled by the worker''s purge once body_expires_at passes, leaving the decision row intact. Null means never captured, or captured and since expired.';

comment on column public.spam_audit.body_captured_at is
  'When the body was written -- by ingestion at the moment of the decision, or later by the Graph backfill for rows that predate 08. Null on any row whose body was never captured.';

comment on column public.spam_audit.body_expires_at is
  'When body_text becomes purgeable. Set from body_captured_at plus the worker''s retention window (SPAM_AUDIT_BODY_RETENTION_DAYS, default 90). Deliberately separate from the row''s own life: the decision is audit metadata and is kept, the message text is personal data and is not.';

-- ---------------------------------------------------------------- ticket_investigations

-- ============================================================================
-- ticket_investigations — the case file
-- ============================================================================
--
-- IDEMPOTENCY, keyed on the message that triggered the run. `unique (shop_id,
-- trigger_message_id)` means one investigation per inbound email: a re-run over
-- the same thread rewrites its own row instead of adding a second, and a
-- customer's reply produces a new row rather than overwriting what was concluded
-- about the earlier message. Same reasoning as ticket_forwards keying on the
-- message rather than the ticket.
--
-- THE FOUR EVIDENCE COLUMNS ARE SEPARATE ON PURPOSE. established / unverified /
-- missing / do_not_claim could be one jsonb blob; they are not, because the
-- distinction between them is the entire safety property. A fact and a doubt in
-- one list get read as two facts -- measured on the promotion tool, where a
-- merged rendering produced "votre code est valide, réessayez" for a customer
-- whose basket was under a minimum nobody can see.
--
-- PERSONAL DATA. The claims are prose written from tool output, so they inherit
-- the tools' own scope: a customer's name and order state can appear, a street
-- address and a phone number cannot, because no tool returns them. The order
-- bundle itself is NOT copied here -- context_ref points at
-- tickets.resolved_context, so personal data is not duplicated across a row per
-- investigation.

create table public.ticket_investigations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- Denormalised from the ticket, and the seam Phase 7 memory hangs off:
  -- "what did we find and conclude for this customer last time" is a query on
  -- this column. Null for a sender who has never been matched to a customer.
  customer_id uuid references public.customers(id) on delete set null,

  -- The inbound message this run was triggered by. THE IDEMPOTENCY KEY.
  trigger_message_id uuid not null references public.ticket_messages(id) on delete cascade,

  verdict text not null check (
    verdict in ('answerable', 'needs_customer_input', 'needs_human')
  ),

  -- Facts, each carrying the tool-call ids it rests on. A claim whose ids are
  -- not in tool_calls is dropped before it gets here (see dropped_claims).
  established jsonb not null default '[]'::jsonb,
  -- What the customer asserted, or what no tool could settle. Never a fact.
  unverified jsonb not null default '[]'::jsonb,
  -- The specific facts only the customer can supply. The question that asks for
  -- each one is written in code, not stored -- the model names the field.
  missing jsonb not null default '[]'::jsonb,
  -- Derived prohibitions. Generated from the caveats the tools raised, never
  -- asked of the model: it is least likely to remember the caveat covering the
  -- gap it has just filled in.
  do_not_claim jsonb not null default '[]'::jsonb,

  -- Approved knowledge chunks that cleared the answerable band. Weak matches are
  -- deliberately absent rather than included and flagged.
  knowledge jsonb not null default '[]'::jsonb,
  -- A POINTER to tickets.resolved_context, not a copy of it.
  context_ref jsonb not null default '{}'::jsonb,

  -- INTERNAL. What a human must do, and why. Never rendered into anything a
  -- customer receives -- the drafting projection of a case file omits it.
  handoff jsonb,

  -- The ledger: which tools ran, with what outcome. This is what makes an
  -- established claim checkable after the fact.
  tool_calls jsonb not null default '[]'::jsonb,
  -- Claims that cited a call that never ran. Kept rather than discarded: a run
  -- that keeps producing them is a prompt problem worth seeing.
  dropped_claims jsonb not null default '[]'::jsonb,

  -- What answering this ticket REQUIRED, against what the run actually got.
  evidence_gaps jsonb not null default '[]'::jsonb,

  -- WHICH RECURRING SITUATION THIS TICKET IS, from support_exemplars.
  --
  -- RECORDED, NOT ACTED ON. The investigation does not read it: no tool choice,
  -- no need, no verdict depends on it, and the model is never told. It is here
  -- to be compared against what the run decided by itself — the exemplar's
  -- `requirement_needs` beside the model's own `evidence_gaps` is the only
  -- honest measure of whether the corpus describes real tickets, and it cannot
  -- be taken while the exemplar is also steering the run that produces it.
  --
  -- The bands behind `verdict` were calibrated on each ticket's FIRST inbound
  -- message; this is matched on the message that triggered the run, which for a
  -- thread is a later one. Expect the two to disagree, and read a follow-up's
  -- match accordingly.
  exemplar_match jsonb not null default '{}'::jsonb,

  -- Why the level moved, in words. Computed from the evidence by
  -- investigation-rules, never judged by the model.
  escalation_reasons jsonb not null default '[]'::jsonb,
  -- What the evidence implied before the ticket's level ratchet was applied,
  -- mirroring metadata.categorisation.proposed_level: without it a ticket pinned
  -- at 3 by an earlier message hides the fact that this reading was calmer.
  proposed_level smallint check (proposed_level is null or proposed_level between 1 and 4),

  model text,
  investigated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (shop_id, trigger_message_id),

  constraint ticket_investigations_established_array_check check (
    jsonb_typeof(established) = 'array'
  ),
  constraint ticket_investigations_unverified_array_check check (
    jsonb_typeof(unverified) = 'array'
  ),
  constraint ticket_investigations_missing_array_check check (
    jsonb_typeof(missing) = 'array'
  ),
  constraint ticket_investigations_do_not_claim_array_check check (
    jsonb_typeof(do_not_claim) = 'array'
  ),
  constraint ticket_investigations_tool_calls_array_check check (
    jsonb_typeof(tool_calls) = 'array'
  ),
  constraint ticket_investigations_evidence_gaps_array_check check (
    jsonb_typeof(evidence_gaps) = 'array'
  ),
  constraint ticket_investigations_context_ref_object_check check (
    jsonb_typeof(context_ref) = 'object'
  )
);

create index ticket_investigations_ticket_idx on public.ticket_investigations (ticket_id);

create index ticket_investigations_shop_verdict_idx on public.ticket_investigations (shop_id, verdict);

-- The memory seam: prior case files for one customer, newest first.
create index ticket_investigations_customer_idx
  on public.ticket_investigations (customer_id, investigated_at desc);

alter table public.ticket_investigations enable row level security;

comment on table public.ticket_investigations is
  'One case file per investigation run: what the agent established from the retrieval tools, what it could not verify, what is missing, and what must not be claimed. Consumed by the drafting stage and by the human queue. unique(shop_id, trigger_message_id) makes the pass safe to re-run and keeps a thread''s successive readings as separate rows.';

comment on column public.ticket_investigations.trigger_message_id is
  'THE IDEMPOTENCY KEY. The inbound message that put the ticket into the investigation queue. Per message rather than per ticket, so a reply produces a new reading instead of overwriting the previous one.';

comment on column public.ticket_investigations.established is
  'Facts, each with the tool-call ids it rests on. A claim citing a call absent from tool_calls never reaches this column -- it is moved to dropped_claims.';

comment on column public.ticket_investigations.unverified is
  'What the customer asserted, or what no available tool could settle. Kept apart from established because a doubt merged into a list of facts is read as a fact.';

comment on column public.ticket_investigations.do_not_claim is
  'Derived prohibitions for the drafting stage, generated in code from the caveats the tools raised and from the missing fields. Never model-authored.';

comment on column public.ticket_investigations.handoff is
  'Internal instruction for a human when the verdict is needs_human. Excluded from every customer-facing rendering of this row.';

comment on column public.ticket_investigations.evidence_gaps is
  'One entry per fact answering this ticket required, each satisfied / attempted / unavailable / not_attempted. DIAGNOSTIC: it does not move the verdict. The requirements are declared per ticket from a closed vocabulary (agent evidence-rules.mjs) and scored in code against tool_calls, so "there was nothing to find" can be told from "the agent never looked" -- not_attempted is the latter. other_fact is the escape hatch for a requirement the vocabulary cannot name and can never be satisfied.';

comment on column public.ticket_investigations.exemplar_match is
  'Which support_exemplars situation this ticket matched: { verdict, exemplar_key, closest, similarity, margin, runner_up, requirement_needs }. REPORTED, NEVER ACTED ON -- nothing in the investigation reads it and the model is never told, so requirement_needs can be compared against the run''s own evidence_gaps as an independent measure. exemplar_key is the committed match and is null unless the verdict is matched; closest is the nearest situation whatever the verdict, which on a near miss is the diagnostic worth having. verdict is matched / near / weak / none / ambiguous, where ambiguous means two situations were closer together than the margin can separate. Empty when retrieval found nothing or failed -- it is best-effort and never fails a run.';

comment on column public.ticket_investigations.context_ref is
  'Pointer to tickets.resolved_context (order name, customer id, whether a bundle exists) rather than a copy of it -- so personal data is not duplicated per investigation, and a rebuilt bundle is not shadowed by a stale copy.';

comment on column public.ticket_investigations.customer_id is
  'Denormalised link to the customer, and the seam for future per-customer memory: prior case files for this customer are a query on this column.';

-- ---------------------------------------------------------------- category_forwarding

-- ============================================================================
-- 04 — FORWARDING
-- Where mail that is not customer work gets sent, and a record of every forward
-- actually made. Runs after 03: it depends on tickets.category and
-- tickets.request_kind, which 03 constrains.
--
-- WHAT THIS IS FOR. Some support mail is not support at all. A spontaneous job
-- application, a Nocibé reorder PO, a partner's regulatory feedback — nobody
-- owes the sender a customer-service answer; the right outcome is that the
-- person who handles that subject sees it. Measured on the corpus, 38 of 330
-- customer-facing tickets are exactly this shape: careers 11,
-- partner_collaboration 14, b2b 13. That is 12% of the inbox resolved by
-- delivering the mail somewhere, with no order lookup and no drafted reply.
--
-- WHY request_kind, NOT category. The taxonomy already carries this distinction:
-- `contact` means a first approach that asks nothing operational of us, and 03
-- documents it as only ever valid for b2b, partner_collaboration and careers.
-- Routing on the category alone would be wrong — `b2b` also holds genuine B2B
-- problems that need real work, and `payment` holds both supplier invoices and
-- customers whose card was declined. The pair (category has an address,
-- request_kind = 'contact') is the narrow, defensible rule.
--
-- WHY PER CATEGORY, NOT PER TEAM. tickets.responsible_team maps careers to
-- `contact` — the generic bucket — so a team-keyed address would send CVs to the
-- shared inbox they just came from. Categories are what people actually own:
-- careers to HR, b2b to sales, partner_collaboration to marketing.
-- ============================================================================

-- ============================================================================
-- category_forwarding — the address book
-- ============================================================================
--
-- One optional address per (shop, category). A category with no row, or a row
-- whose address is cleared, is never forwarded: absence is the off switch, so a
-- fresh install forwards nothing until somebody fills the form in. There is no
-- `enabled` flag because it would be a second way to express the same thing and
-- the two could disagree.
--
-- The address is a colleague's work address, not customer personal data — it is
-- stored in the clear because the whole point is to send mail to it, and it is
-- the one field an operator has to be able to read back and correct.

create table public.category_forwarding (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- The 14 ticket subjects from scripts/lib/support-taxonomy.mjs. The
  -- knowledge-only shapes (faq, brand_story) are deliberately absent: they are
  -- never ticket subjects, so nothing could ever route to them.
  category text not null check (
    category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),

  -- Null or empty means "do not forward this category". Trimmed and
  -- lowercased by the writer; the check only rejects something that cannot be
  -- an address at all, since real-world validity is decided by Graph accepting
  -- the send, not by a regex.
  forward_email text check (forward_email is null or forward_email like '%_@_%'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (shop_id, category)
);

create index category_forwarding_shop_idx on public.category_forwarding (shop_id);

create trigger category_forwarding_set_updated_at
before update on public.category_forwarding
for each row
execute function public.set_updated_at();

alter table public.category_forwarding enable row level security;

comment on table public.category_forwarding is
  'Per-category forwarding address book: which colleague receives mail of a given subject that asks nothing of customer support. Read by the agent forwarding step, written by the Agent Setup UI. A category with no row or a null address is never forwarded.';

comment on column public.category_forwarding.category is
  'Ticket subject from the shared taxonomy in scripts/lib/support-taxonomy.mjs. Only the 14 ticket subjects -- faq and brand_story are knowledge-only and cannot be a ticket category.';

comment on column public.category_forwarding.forward_email is
  'Internal recipient. Null or absent means this category is never forwarded, which is the default for every category on a fresh install.';

-- ---------------------------------------------------------------- ticket_forwards

-- What was actually sent.
--
-- IDEMPOTENCY, keyed on the MESSAGE not the ticket. `unique (ticket_message_id)`
-- is what stops a re-run, a retry or a replayed poll forwarding the same email
-- twice. Keying on the ticket instead would have meant a candidate's follow-up,
-- or a partner's reply three days later, never reaching the person handling it:
-- the first forward would have "covered" the thread forever. Per message, each
-- new inbound email is delivered once.
--
-- Failures are rows too (`status = 'failed'`), not silence. A send that Graph
-- rejected must be visible and retryable, and a table that only records
-- successes cannot tell "never attempted" from "attempted and lost". The
-- selection step therefore excludes only `sent` rows, and recording upserts on
-- ticket_message_id so a retry updates the existing row instead of colliding
-- with the unique constraint.
--
-- `attempts` is what stops that becoming an infinite retry: a genuinely
-- undeliverable message (a mistyped address, a mailbox that no longer exists)
-- would otherwise be re-sent on every poll forever. After MAX_FORWARD_ATTEMPTS
-- the row is left alone and stays visible as a failure for a human. Transient
-- Graph errors (mailbox move, throttling) are recorded WITHOUT consuming an
-- attempt — found by running it: Exchange was mid-mailbox-move, all 42 sends
-- came back ErrorMailboxMoveInProgress, and a cap of 5 against a 60-second poll
-- would have burned every attempt in five minutes.
create table public.ticket_forwards (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- The specific email forwarded. Unique, and the reason this table is safe to
  -- re-run against.
  ticket_message_id uuid not null unique references public.ticket_messages(id) on delete cascade,

  -- Snapshot of the routing decision at send time. Kept even though it is
  -- derivable, because the address book is editable: changing where careers mail
  -- goes tomorrow must not rewrite where it went yesterday.
  category text not null,
  forward_email text not null,

  status text not null default 'sent' check (status in ('sent', 'failed')),
  -- One line, no stack, no message body. Enough to see why and retry.
  error text,
  attempts integer not null default 1,

  created_at timestamptz not null default now()
);

create index ticket_forwards_shop_idx on public.ticket_forwards (shop_id);

create index ticket_forwards_ticket_idx on public.ticket_forwards (ticket_id);

create index ticket_forwards_failed_idx on public.ticket_forwards (shop_id, status);

-- Lets the selection step find "failed but still worth retrying" without a
-- full scan of the ledger.
create index ticket_forwards_retry_idx
  on public.ticket_forwards (shop_id, status, attempts);

alter table public.ticket_forwards enable row level security;

comment on table public.ticket_forwards is
  'One row per email forwarded to a colleague, successful or not. Doubles as the idempotency ledger: unique(ticket_message_id) is what makes the forwarding step safe to re-run. Holds no message body -- the forwarded mail itself lives in the recipient mailbox and in ticket_messages.';

comment on column public.ticket_forwards.ticket_message_id is
  'THE IDEMPOTENCY KEY. Per message rather than per ticket, so a follow-up on an already-forwarded thread still reaches the recipient exactly once.';

comment on column public.ticket_forwards.category is
  'The category as it was when the forward was sent. Snapshot: editing the address book later must not rewrite history.';

comment on column public.ticket_forwards.status is
  'sent | failed. Failures are recorded rather than dropped, so a Graph rejection is visible and retryable instead of silently never happening.';

comment on column public.ticket_forwards.attempts is
  'How many times this message has been attempted. Retry stops at the cap in agent/src/routing/forwarding-store.mjs, so a permanently undeliverable address fails a bounded number of times and then stays visible instead of being re-sent on every poll.';

comment on column public.ticket_forwards.status is
  'sent | failed. `sent` is final and excludes the message from future passes; `failed` is retried until attempts hits the cap. Recording upserts on ticket_message_id, so a retry updates this row rather than colliding with its unique constraint.';

-- ---------------------------------------------------------------- categorisation_review

-- ============================================================================
-- Human review set
--
-- A TESTING artefact, not part of the runtime pipeline. Nothing in the worker
-- reads it, and rows here are unrelated to tickets / ticket_messages -- the
-- sampler reads the mailbox directly (GET only) and never ingests.
--
-- Blind by design: the human_* columns are filled in first, and the agent_*
-- columns stay empty until the comparison runs. Showing the agent's answer next
-- to an empty box would anchor the reviewer and inflate the agreement score.
--
-- Personal data: rows hold real customer email subjects and bodies, the minimum
-- a human needs to judge a category. The sender is reduced to its DOMAIN (enough
-- to tell a B2B enquiry from a consumer one, not enough to identify the person),
-- and retention is capped at 3 months by default -- shorter than tickets,
-- because a review set has no operational value once it has been scored.
-- ============================================================================

create table public.categorisation_review (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- Idempotency: re-sampling the same message updates the row instead of
  -- duplicating it, so a re-run cannot silently double the review set.
  graph_message_id text not null,
  received_at timestamptz,
  from_domain text,
  subject text,
  body_text text,

  -- ---- Fill these in (leave the agent_* columns alone) --------------------
  human_category text,
  human_request_kind text,
  human_level smallint,
  human_notes text,
  reviewed_at timestamptz,

  -- ---- Written by the comparison run, after labelling ---------------------
  agent_category text,
  agent_request_kind text,
  agent_secondary_category text,
  agent_secondary_request_kind text,
  agent_level smallint,
  agent_reason text,
  agent_model text,
  categorised_at timestamptz,

  -- Whether the deterministic blocklist would have dropped this email before it
  -- ever reached the categoriser. Recorded rather than filtered so the sample
  -- stays honest about what the real inbox contains.
  blocklist_would_drop boolean not null default false,

  sample_batch text,
  retention_delete_after timestamptz not null default (now() + interval '3 months'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint categorisation_review_message_unique unique (shop_id, graph_message_id),

  -- Same vocabulary as tickets, so a label typed here is a label the agent could
  -- have produced. The constraint is what stops a typo becoming a disagreement
  -- the comparison would report as a model error.
  constraint categorisation_review_human_category_check check (
    human_category is null or human_category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  constraint categorisation_review_human_kind_check check (
    human_request_kind is null
      or human_request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  constraint categorisation_review_human_level_check check (
    human_level is null or human_level between 1 and 4
  ),
  constraint categorisation_review_agent_category_check check (
    agent_category is null or agent_category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  constraint categorisation_review_agent_kind_check check (
    agent_request_kind is null
      or agent_request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  constraint categorisation_review_agent_level_check check (
    agent_level is null or agent_level between 1 and 4
  ),
  constraint categorisation_review_agent_secondary_pair_check check (
    agent_secondary_request_kind is null or agent_secondary_category is not null
  )
);

create index categorisation_review_shop_idx on public.categorisation_review (shop_id);

create index categorisation_review_batch_idx on public.categorisation_review (shop_id, sample_batch);

create index categorisation_review_unlabelled_idx
  on public.categorisation_review (shop_id, reviewed_at);

create index categorisation_review_retention_idx
  on public.categorisation_review (retention_delete_after);

create trigger categorisation_review_set_updated_at
before update on public.categorisation_review
for each row
execute function public.set_updated_at();

alter table public.categorisation_review enable row level security;

comment on table public.categorisation_review is
  'Human-labelled review set for the categorising agent: a random sample of real support mail, labelled by a person in the Supabase table editor, then scored against the agent. Testing artefact only -- the worker never reads it. Holds real email subjects and bodies (the minimum needed to judge a category) with the sender reduced to a domain, and a 3-month default retention.';

comment on column public.categorisation_review.human_category is
  'THE COLUMN TO FILL IN: the correct subject, from the same 14 values tickets.category allows. Constrained, so a typo is rejected rather than counted as a disagreement.';

comment on column public.categorisation_review.human_request_kind is
  'THE COLUMN TO FILL IN: question | problem | complaint | contact. `contact` is only for b2b, partner_collaboration and careers.';

comment on column public.categorisation_review.human_level is
  'THE COLUMN TO FILL IN (optional): 1 answerable from knowledge, 2 needs a data lookup or a simple advice reply, 3 needs a state-changing action, 4 severity only -- explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger. Leave null to accept the level derived from (category, kind).';

comment on column public.categorisation_review.agent_category is
  'Written by the comparison run, AFTER labelling. Left empty at sampling time on purpose: an agent answer visible beside an empty box anchors the reviewer and inflates agreement.';

comment on column public.categorisation_review.from_domain is
  'Sender domain only, never the address. Enough to tell a B2B enquiry from a consumer one without identifying the person.';

comment on column public.categorisation_review.blocklist_would_drop is
  'True when email_blocklist would have dropped this message before the categoriser ever saw it. Recorded, not filtered, so the sample stays honest about what the inbox actually contains.';

comment on column public.categorisation_review.retention_delete_after is
  'Default 3 months -- shorter than tickets, since a review set has no operational value once scored. Deleted by the retention cleanup job (not yet built).';


-- ============================================================================
-- Projections
-- ============================================================================
--
-- Shapes that were being assembled on the client by reading rows and throwing
-- most of them away. They are joins and aggregates, not judgement: this project
-- keeps judgement in tested JavaScript and set operations in Postgres (the same
-- split search_knowledge_chunks_text is written to, in 03_knowledge.sql).
-- shouldAutoClose, the level ratchet and the evidence rules stay where they are.
--
-- EVERY VIEW HERE IS security_invoker. A view created without it runs as its
-- OWNER, which means it reads straight past the row-level security on the tables
-- underneath -- and every table in this baseline has RLS enabled with no
-- policies precisely so that only the service role can read it. Without this
-- setting these three views would be the one way an anon key could read the
-- whole ticket table. The revokes below say the same thing a second way.

-- ------------------------------------------------------- ticket_message_counts

-- How many messages a ticket holds.
--
-- Replaces a full read of ticket_messages in web/lib/server/tickets-service.ts,
-- which pulled every id in the shop to count them in a Map -- the alternative
-- there being one count query per ticket, which is 565 round trips on the
-- measured mailbox. Neither is necessary: this is one grouped scan.
--
-- Soft-deleted messages do not count. A compliance delete must not keep
-- inflating the number beside a subject line.
create view public.ticket_message_counts
with (security_invoker = true) as
  select
    m.shop_id as shop_id,
    m.ticket_id as ticket_id,
    count(*) as message_count
  from public.ticket_messages m
  where m.deleted_at is null
  group by m.shop_id, m.ticket_id;

revoke all on public.ticket_message_counts from anon, authenticated;

comment on view public.ticket_message_counts is
  'Message count per ticket, excluding soft-deleted messages. Read by the dashboard queue instead of counting rows client-side.';

-- -------------------------------------------------------- ticket_first_inbound

-- The customer's opening words on a ticket.
--
-- WHY THIS EXISTS. Order resolution needs the FIRST inbound message per ticket,
-- because quoted history is exactly where stale order numbers from previous
-- threads live. Getting it through PostgREST meant reading every inbound message
-- in the shop -- bodies included, 1000 rows per request -- and keeping the first
-- per ticket in a Map. The bodies are the largest thing this database holds and
-- all but one per ticket were discarded on arrival.
--
-- `distinct on (ticket_id)` with a matching leading ORDER BY is the Postgres
-- idiom for "one row per group, the earliest": the sort decides which row
-- survives, so the two clauses have to agree and are written together.
--
-- Nulls sort last under plain ASC, so a message with no received_at is only ever
-- picked when it is the ticket's only inbound message -- which is the right
-- answer rather than an accident.
create view public.ticket_first_inbound
with (security_invoker = true) as
  select distinct on (m.ticket_id)
    m.ticket_id as ticket_id,
    m.shop_id as shop_id,
    m.id as message_id,
    m.subject as subject,
    m.body_text as body_text,
    m.received_at as received_at
  from public.ticket_messages m
  where m.direction = 'inbound'
    and m.deleted_at is null
  order by m.ticket_id, m.received_at asc;

revoke all on public.ticket_first_inbound from anon, authenticated;

comment on view public.ticket_first_inbound is
  'One row per ticket: its earliest inbound message, already stripped of quoted reply chains by ingestion. Read by order resolution, which needs the customer''s own words rather than the thread.';

-- -------------------------------------------------------------- ticket_queue

-- The dashboard queue, as one row per ticket.
--
-- Folds together what the list read was doing in three parts: the ticket
-- columns, the customer resolved over tickets.customer_id, and the message
-- count. The customer join was already free (PostgREST resolved it as an embed
-- in the same request); the count was not.
--
-- SOFT-DELETED TICKETS ARE EXCLUDED IN THE VIEW, not by the caller. A compliance
-- delete must not reach the UI even if a later reader forgets to filter, and
-- that guarantee is worth more here than the flexibility of leaving it out.
-- ARCHIVED TICKETS ARE KEPT: archiving drops a ticket out of the active queue,
-- and the list offers that as a filter rather than hiding it.
--
-- VIP is deliberately not here. It is derived at read time from rfm_group by
-- customer-segments.mjs and nothing stores it -- putting it in the view would
-- make a rule that changes with the business into a schema object.
create view public.ticket_queue
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
    c.display_name as customer_display_name,
    c.first_name as customer_first_name,
    c.last_name as customer_last_name,
    c.rfm_group as customer_rfm_group,
    coalesce(n.message_count, 0) as message_count
  from public.tickets t
  left join public.customers c on c.id = t.customer_id
  left join public.ticket_message_counts n on n.ticket_id = t.id
  where t.deleted_at is null;

revoke all on public.ticket_queue from anon, authenticated;

comment on view public.ticket_queue is
  'One row per live ticket with its customer and message count already joined -- the projection the dashboard list renders and the status write returns. Soft-deleted tickets are excluded here rather than by the caller; archived ones are kept and filtered in the UI. LEFT JOIN on customers: most tickets are unlinked until the customer-resolution pass runs.';
