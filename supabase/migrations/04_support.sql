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

-- ---------------------------------------------------------------- cases

-- THE CUSTOMER'S PROBLEM, as opposed to the email thread it arrived on.
-- Message -> thread (`tickets`, one per Graph conversation) -> case. Several
-- threads may point at one case; threads are never merged or deleted, and each
-- message stays on the thread it arrived on.
--
-- Created with its first ticket, one case per new conversation. A thread joins
-- an older case only through agent/src/cases/ (deterministic rules first, a
-- model only between a handful of candidates), and every decision is recorded
-- in `case_links`.
--
-- THE REPLY TARGET IS CODE'S, NEVER A MODEL'S: the newest customer message in
-- the case that no later message of ours answers, on whichever thread it
-- arrived (scripts/lib/case-reply-target.mjs). Only its thread is drafted.
--
-- The two pointers below are plain uuids, not foreign keys: `tickets`
-- references this table, so a key back would be a cycle the baseline cannot
-- state without an `alter table`. The writer recomputes both whenever the case
-- changes, and every reader treats a pointer to nothing as « no target ».
create table public.cases (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- `requester hash | order number | issue family`, when all three are known.
  -- A strong signal for linking, never the only one: a message may name no
  -- order, and one order can carry two unrelated problems.
  case_key text,
  issue_family text,

  -- Where the reply goes: the message, and the thread holding it. Null when
  -- every customer message in the case has been answered.
  latest_actionable_inbound_message_id uuid,
  reply_thread_id uuid,
  target_computed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cases_shop_idx on public.cases (shop_id);

create index cases_shop_key_idx on public.cases (shop_id, case_key) where case_key is not null;

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

-- ---------------------------------------------------------------- issue families

-- Which subjects and situations belong to which family of problems, and which
-- family may turn into which. CONFIGURATION, per shop: a delivery that becomes
-- a refund is one case here, and another business may draw the line elsewhere.
-- Read by agent/src/cases/case-link-rules.mjs; a model is never asked.
create table public.issue_family_members (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- `subject`: a tickets.category value. `situation`: a support_exemplars key.
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

-- A family that may become another within one case (delivery late -> parcel
-- lost -> refund). A family is always compatible with itself; the table holds
-- only the moves between two.
create table public.issue_family_transitions (
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
  -- THE CASE THIS THREAD BELONGS TO. Every thread has one: a new conversation
  -- opens its own, and the linker (agent/src/cases/) may move the thread into an
  -- older case of the same customer. `case_link_state` is `pending` until that
  -- decision is made, once, and `decided` after.
  case_id uuid not null references public.cases(id) on delete restrict,
  case_link_state text not null default 'pending',
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
  -- WHO OPENED THIS THREAD, when the answer is "one of us". Copied from
  -- sender_directory at ticket creation and never revised: a colleague's thread
  -- does not become a customer's because a customer was later cc'd.
  --
  -- Null is the ordinary case and means a consumer — the same convention
  -- `senderDirectory.lookup()` uses for an unlisted address. Only the labels
  -- that mean "our own side" are stamped (OWN_SIDE_LABELS): colleagues, the
  -- agency, and the 3PL whose threads are the back office working a customer's
  -- return. A retailer writing in is a real external correspondent with real
  -- demand, and marking their mail non-customer would hide a class of work.
  sender_label text,

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

  -- THE SAME CONVERSATION, ARRIVING TWICE. Threading is on Graph's
  -- `conversationId`, which is right and is not always enough: a customer who
  -- writes through the contact form and then replies to our answer can arrive
  -- under a different one, and a mail system can double-post a submission
  -- outright. Measured 2026-08-19: 72 consecutive ticket pairs from one sender
  -- within 30 days, 48 sharing a category.
  --
  -- LINKED, NEVER MERGED. A wrong merge cannot be undone and a wrong link is a
  -- column: both threads stay whole, and a person decides. What the link
  -- actually prevents is the harm -- the drafting queue skips a linked ticket,
  -- so one customer cannot receive two replies to one message.
  --
  -- Set by deterministic rules only (identical body inside an hour, or an RFC
  -- reply chain pointing at a message we already store). Nothing infers it.
  duplicate_of_ticket_id uuid references public.tickets(id) on delete set null,
  -- Which rule fired. Kept because "why is this linked" is the first question a
  -- reviewer asks, and a boolean cannot answer it.
  duplicate_reason text,
  duplicate_detected_at timestamptz,

  -- THE SAME CONVERSATION, BUT NOT THE SAME MESSAGE. A duplicate is one email
  -- arriving twice and is answered by silence; this is the customer writing
  -- AGAIN -- a chase, or a thread that split across conversation ids -- and is
  -- answered by a reply that opens with an apology. Nothing about this link
  -- suppresses a draft, which is the only reason a similarity score is allowed
  -- to set it at all: a wrong duplicate costs a customer their answer, a wrong
  -- related link costs an unnecessary apology.
  --
  -- Consumers only. A retailer's weekly purchase-order template scores higher
  -- against its own past orders (0.994-0.998) than any genuine consumer match,
  -- and scoping to one sender is exactly what fails to separate them, so a
  -- sender listed in sender_directory is never linked. See related-rules.mjs.
  related_ticket_id uuid references public.tickets(id) on delete set null,
  -- The cosine that produced the link, kept because the threshold will move and
  -- a score recorded under the old one must stay interpretable.
  related_score real,
  related_detected_at timestamptz,

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

  -- A person's corrections, per field: { value, ai_value, set_by, set_at, source }.
  -- The column of an overridden field holds the person's value; `ai_value` keeps
  -- the pipeline's. See scripts/lib/ticket-overrides.mjs and 48_ticket_overrides.sql.
  overrides jsonb not null default '{}'::jsonb,

  -- The change router's record of order states that moved since the latest case
  -- file. Null until something moves. See agent/src/casework/change-router.mjs
  -- and 69_fact_drift.sql.
  fact_drift jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tickets_overrides_object_check check (jsonb_typeof(overrides) = 'object'),
  constraint tickets_fact_drift_object_check check (fact_drift is null or jsonb_typeof(fact_drift) = 'object'),
  constraint tickets_shop_conversation_unique unique (shop_id, graph_conversation_id),
  constraint tickets_case_link_state_check check (case_link_state in ('pending', 'decided')),
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
  -- A ticket cannot be its own duplicate. The rules compare against OTHER
  -- tickets, so this can only fire if one is changed carelessly -- which is
  -- exactly when a self-link would silently remove a ticket from drafting.
  constraint tickets_duplicate_not_self_check check (
    duplicate_of_ticket_id is null or duplicate_of_ticket_id <> id
  ),
  -- A link carries its reason and its timestamp, or none of the three is set.
  -- A link with no reason is unreviewable, and the reason is what a person needs
  -- before they undo it.
  constraint tickets_duplicate_complete_check check (
    (duplicate_of_ticket_id is null and duplicate_reason is null and duplicate_detected_at is null)
    or (duplicate_of_ticket_id is not null and duplicate_reason is not null
        and duplicate_detected_at is not null)
  ),
  constraint tickets_duplicate_reason_check check (
    duplicate_reason is null or duplicate_reason in ('identical_body', 'reply_chain')
  ),
  -- Same reasoning as the duplicate self-check: a self-link here would make a
  -- ticket its own prior and report every customer as chasing themselves.
  -- The full sender_directory vocabulary is accepted even though ingestion only
  -- writes two of them, so widening the rule later is a code change rather than
  -- a migration on a live table.
  constraint tickets_sender_label_check check (
    sender_label is null
    or sender_label in ('internal', 'contractor', 'logistics', 'courier',
                        'retailer', 'distributor', 'supplier', 'partner')
  ),
  constraint tickets_related_not_self_check check (
    related_ticket_id is null or related_ticket_id <> id
  ),
  constraint tickets_related_complete_check check (
    (related_ticket_id is null and related_score is null and related_detected_at is null)
    or (related_ticket_id is not null and related_score is not null
        and related_detected_at is not null)
  ),
  -- A cosine, so anything outside [-1, 1] means the writer sent the wrong number.
  constraint tickets_related_score_range_check check (
    related_score is null or (related_score >= -1 and related_score <= 1)
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

-- Every thread of one case, and the linker's queue.
create index tickets_case_idx on public.tickets (case_id);

create index tickets_case_link_pending_idx
  on public.tickets (shop_id)
  where case_link_state = 'pending';

-- The drafting queue's exclusion, and the "what was linked to this" read.
create index tickets_duplicate_of_idx
  on public.tickets (duplicate_of_ticket_id)
  where duplicate_of_ticket_id is not null;

create index tickets_related_ticket_idx
  on public.tickets (related_ticket_id)
  where related_ticket_id is not null;

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

create trigger tickets_open_case
before insert on public.tickets
for each row
execute function public.tickets_open_case();

alter table public.tickets enable row level security;

comment on table public.tickets is
  'Support conversations for the agent email workflow. One ticket per Microsoft Graph conversationId; the categorising agent fills category, request_kind, level, responsible_team, and the resolved Shopify order number. Access through the service-role worker only until dashboard roles and policies are implemented.';

comment on column public.tickets.case_id is
  'The case this thread belongs to. A new conversation opens its own case; the case linker (agent/src/cases/) may move the thread into an older case of the same customer, recorded in case_links. Threads are never merged: several tickets share a case_id.';

comment on column public.tickets.case_link_state is
  'pending until the case linker has decided, once, whether this thread continues an older case; decided after. Tickets that predate cases were marked decided by 61_cases.sql.';

comment on column public.tickets.duplicate_of_ticket_id is
  'The ticket this one duplicates, set by deterministic rules only: an identical body from the same sender within an hour, or an RFC reply chain pointing at a message already stored. LINKED, NEVER MERGED -- both threads stay whole and a person decides. The drafting queue skips a linked ticket, which is what stops one customer receiving two replies.';

comment on column public.tickets.overrides is
  'A person''s corrections, per field: { value, ai_value, set_by, set_at, source }. The column of an overridden field holds the person''s value; ai_value keeps the pipeline''s, and the categoriser keeps it current. Empty object when nothing is overridden.';

comment on column public.tickets.fact_drift is
  'The change router''s record of order states that moved since the latest case file: { changed: { state: { from, to } }, outcome (redraft | reinvestigate), reason, case_file_at, checked_at }. Null until something moves. The fold hashes it, so a drift raises the case version once.';

comment on column public.tickets.sender_label is
  'The sender_directory label of the address that OPENED this thread, when that address is one of ours -- internal (qiriness.com, lap-groupe.com), contractor, or logistics (the 3PL running the warehouse). Null means a consumer, the ordinary case. Set deterministically at ticket creation from the address, never by a model: who wrote to us is a fact we hold before any pass runs. The drafting queue skips a labelled ticket, because a customer-voice reply addressed to a colleague is never the right output; investigation still runs, because a colleague chasing a real order still needs the order facts gathered for whoever picks it up.';

comment on column public.tickets.related_ticket_id is
  'An earlier ticket from the SAME consumer sender that this one continues -- a chase, or a thread split across conversation ids. Set from a message-embedding cosine at or above 0.90 within 30 days, and never for a sender listed in sender_directory (a retailer''s repeated purchase-order template outscores every genuine consumer match). UNLIKE duplicate_of_ticket_id THIS NEVER SUPPRESSES A DRAFT: it adds thread context for the reviewer and tells the drafting agent the customer was left waiting, so the reply opens with an apology.';

comment on column public.tickets.related_score is
  'The cosine that produced related_ticket_id, kept so a link made under one threshold stays interpretable after the threshold moves.';

comment on column public.tickets.related_detected_at is
  'When the related link was written. Separate from the ticket clock because a link can be made long after both tickets were created.';

comment on column public.tickets.duplicate_reason is
  'Which rule linked this ticket: identical_body or reply_chain. Kept because "why is this linked" is the first question a reviewer asks, and a boolean cannot answer it.';

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
  -- THE RFC 5322 REPLY CHAIN, and the reason it is captured is deduplication.
  --
  -- Threading here is done on Graph's `conversationId`, and it is the right
  -- primary key for it. But it is Exchange's own notion of a conversation, and
  -- a customer who writes through the contact form and then replies to our
  -- answer can arrive under a DIFFERENT one -- which becomes a second ticket
  -- for a single conversation. Measured on the corpus: 72 consecutive ticket
  -- pairs from one sender within 30 days, 48 of them sharing a category, which
  -- is the shape of one conversation split rather than two problems.
  --
  -- `In-Reply-To` and `References` are how every mail client threads, and they
  -- point at `internet_message_id` values we already store. They are therefore
  -- the deterministic link between the two halves of a split thread -- no
  -- similarity, no model.
  --
  -- ONLY THESE TWO HEADERS ARE KEPT. Graph returns the whole header set and
  -- most of it is `Received` chains carrying relay IPs and hostnames, which is
  -- personal data this system has no use for.
  in_reply_to text,
  reference_ids text[] not null default '{}',

  direction text not null,
  -- Who wrote it, in the case vocabulary: outbound is support, an inbound sender
  -- is mapped through sender_directory and AGENT_ACTOR_BY_LABEL
  -- (agent/src/casework/actors.mjs). Stored at arrival like sender_label, so
  -- relabelling the directory never rewrites history. Null on a row written
  -- before the column; `actors:backfill` fills it. `automated` is an automatic
  -- reply (an out-of-office): kept in the thread, never a case actor (73).
  actor text,
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text,
  body_text text,
  body_preview text,
  has_attachments boolean not null default false,
  -- NULLABLE ON PURPOSE, and the null is the point. `[]` means "we asked Graph
  -- and there was nothing"; null means "we never asked" -- which is every row
  -- ingested before this column existed. A `not null default '[]'` would render
  -- those two identical and let the photo check report "no photo attached" for a
  -- message whose attachments were simply never fetched.
  attachments jsonb,

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
  constraint ticket_messages_actor_check check (
    actor is null or actor in ('customer', 'support', 'colleague', 'partner', 'automated')
  ),
  constraint ticket_messages_raw_payload_object_check check (
    jsonb_typeof(raw_graph_payload) = 'object'
  ),
  -- Same guard the orders snapshot puts on line_items, returns and refunds: a
  -- column that is read with array semantics has to be an array, or the first
  -- object written there becomes a runtime error somewhere far away.
  constraint ticket_messages_attachments_array_check check (
    attachments is null or jsonb_typeof(attachments) = 'array'
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

-- The dedup lookup: "does any stored message carry a Message-ID this new one
-- replies to". Answered against this index rather than by scanning the shop's
-- mail, which is the difference between a threading check and a table scan.
create index ticket_messages_shop_internet_id_idx
  on public.ticket_messages (shop_id, internet_message_id)
  where internet_message_id is not null;

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

comment on column public.ticket_messages.attachments is
  'Attachment METADATA only, one object per part: name, contentType, size, isInline. Never the bytes -- Graph''s attachment resource carries contentBytes and the fetch $selects around it. `has_attachments` says something is there; this says whether it is a photo of a broken bottle or a CV, a distinction the boolean cannot make, and the two largest attachment groups in this mailbox are careers CVs and b2b catalogues. NULL means never fetched (every row predating this column); `[]` means fetched and empty. Those are different answers and the photo check reports the first as unknown rather than as "no photo".';

comment on column public.ticket_messages.graph_message_id is
  'Microsoft Graph message id. The idempotency key: re-ingesting the same email is a no-op via the shop_id + graph_message_id unique constraint.';

comment on column public.ticket_messages.reference_ids is
  'The RFC 5322 `References` chain: every Message-ID this email is a reply within, oldest first. Captured for deduplication -- a contact-form ticket and the customer''s emailed reply can arrive under different Graph conversationIds, and these headers are the deterministic link between them. Only In-Reply-To and References are kept from the header set; the rest is Received chains carrying relay IPs.';

comment on column public.ticket_messages.in_reply_to is
  'The RFC 5322 `In-Reply-To` header: the Message-ID this email directly answers. Null on a thread''s first message, and on any mail whose client omitted it.';

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

  -- What `recommendProducts` put forward, as the tool rendered it: one entry per
  -- type of care the customer asked for, with the product lines a reply quotes.
  -- Written by code from the tool ledger, never by the model — the same
  -- treatment `knowledge` gets, because both are text a reply repeats closely
  -- and a paraphrase of either loses the part that mattered (see 32).
  recommendations jsonb not null default '[]'::jsonb,
  -- A POINTER to tickets.resolved_context, not a copy of it.
  context_ref jsonb not null default '{}'::jsonb,

  -- INTERNAL. What a human must do, and why. Never rendered into anything a
  -- customer receives -- the drafting projection of a case file omits it.
  handoff jsonb,

  -- INTERNAL, AND A CANDIDATE RATHER THAN A FACT. When the customer named no
  -- order, `verifyPurchase` has already fetched their most recent one to
  -- cross-check the product; this is that order, kept so a human does not repeat
  -- the search by hand. It is NOT evidence: the customer may mean an earlier
  -- order, or a purchase made in a shop Shopify never saw.
  --
  -- Excluded from the drafting projection for the same reason `handoff` is: a
  -- number a model can see is a number it can quote, and quoting the wrong order
  -- number at a customer is worse than quoting none. Empty when an order WAS
  -- confirmed -- the bundle then says everything this could.
  candidate_order jsonb not null default '{}'::jsonb,

  -- WHAT THE CUSTOMER BLAMES, AND FOR WHAT. Null on every ticket outside
  -- cosmetovigilance, and on a cosmetovigilance ticket where the reaction tool
  -- never ran -- which is why it is nullable rather than defaulted to '{}': an
  -- empty object here would read as "a reaction was reported and nothing was
  -- found", and the commonest reason for no row is that no reaction was
  -- reported at all.
  --
  -- ATTRIBUTION, NOT CAUSATION. `product` is the catalogue title the customer's
  -- own words resolved to, `claimed` is those words, and both are stored because
  -- a resolution is a match rather than a fact. Nothing in this column says the
  -- product caused anything, and the case file carries a prohibition
  -- (`reaction_cause_unestablished`) saying so in as many words.
  --
  -- IT EXISTS TO BE READ BY A PERSON AND COUNTED ACROSS ROWS. A reaction record
  -- buried in a tool ledger is neither: `tool_calls` drops every tool's `data`,
  -- so without this column the product and the symptoms are gone the moment the
  -- run ends.
  reaction_report jsonb,

  -- The ledger: which tools ran, with what outcome. This is what makes an
  -- established claim checkable after the fact.
  tool_calls jsonb not null default '[]'::jsonb,
  -- Claims that cited a call that never ran. Kept rather than discarded: a run
  -- that keeps producing them is a prompt problem worth seeing.
  dropped_claims jsonb not null default '[]'::jsonb,

  -- What answering this ticket REQUIRED, against what the run actually got.
  evidence_gaps jsonb not null default '[]'::jsonb,

  -- THE DERIVED FINDINGS AFTER EACH TOOL CALL, IN CALL ORDER. One snapshot per
  -- entry in tool_calls, each `{call, tool, findings}`.
  --
  -- IT EXISTS BECAUSE A RUN CANNOT BE REPLAYED FROM ANYTHING ELSE HERE.
  -- `tool_calls` drops every tool's `data` on purpose, and 8 of the 30 finding
  -- derivations read it -- buyer_type, product_identity, promotion_validity,
  -- promotion_eligibility, customer_account_state, product_availability,
  -- photo_evidence, checkout_state, which is the whole discriminator for
  -- promotions and for accounts. A replay over `tool_calls` would score those as
  -- absent, fire fewer rules and stop earlier -- flattering rule-guided
  -- collection exactly where it is most likely to under-collect.
  --
  -- FINDINGS, NOT DATA, is what makes this safe to keep where `data` was
  -- correctly dropped: a closed enum of a few dozen values carrying no personal
  -- data. Widening `tool_calls` instead would have been the other, wrong fix.
  --
  -- NULLABLE, AND THE NULL IS LOAD-BEARING, same as `reaction_report` below and
  -- `ticket_messages.attachments`. NULL means this run predates the trace; `[]`
  -- means the run made no tool calls. A `not null default '[]'` would state the
  -- second about every row written before this column existed, and their `data`
  -- is gone, so no backfill could ever correct it.
  findings_trace jsonb,

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

  -- Which company policies this case read, and why:
  -- [{ key, version, source: situation | rule | agent }].
  company_policies jsonb not null default '[]'::jsonb,

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
  -- Nullable, so the null is spelled out rather than left to the fact that a
  -- check evaluating to null passes -- the same reasoning the reaction_report
  -- check states below.
  constraint ticket_investigations_findings_trace_array_check check (
    findings_trace is null or jsonb_typeof(findings_trace) = 'array'
  ),
  constraint ticket_investigations_context_ref_object_check check (
    jsonb_typeof(context_ref) = 'object'
  ),
  constraint ticket_investigations_candidate_order_object_check check (
    jsonb_typeof(candidate_order) = 'object'
  ),
  -- Nullable, so the check has to allow null explicitly: `jsonb_typeof(null)`
  -- is null, and a check evaluating to null passes -- but writing it out is the
  -- difference between a constraint that is right and one that is right by
  -- accident.
  constraint ticket_investigations_reaction_report_object_check check (
    reaction_report is null or jsonb_typeof(reaction_report) = 'object'
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

comment on column public.ticket_investigations.candidate_order is
  'INTERNAL. The customer''s most recent order, kept as a CANDIDATE when they named none -- verifyPurchase already fetched it to cross-check the product, so this saves a human repeating that search. Never evidence: they may mean an earlier order, or a shop purchase Shopify never saw. Excluded from the drafting projection like handoff, because a number a model can see is one it can quote. Empty when an order was confirmed.';

comment on column public.ticket_investigations.reaction_report is
  'COSMETOVIGILANCE ONLY, and null everywhere else including on a reaction ticket where the tool never ran. What the customer BLAMES and the symptoms they describe: product is the catalogue title their words resolved to, claimed is the words themselves, outcome is identified / ambiguous / not_in_catalogue / not_attributed. Attribution, never causation -- the case file carries reaction_cause_unestablished for exactly that reason. Held here rather than in tool_calls because that column drops every tool''s data, which would lose the product and the symptoms at the end of the run.';

comment on column public.ticket_investigations.handoff is
  'Internal instruction for a human when the verdict is needs_human. Excluded from every customer-facing rendering of this row.';

comment on column public.ticket_investigations.evidence_gaps is
  'One entry per fact answering this ticket required, each satisfied / attempted / unavailable / not_attempted. DIAGNOSTIC: it does not move the verdict. The requirements are declared per ticket from a closed vocabulary (agent evidence-rules.mjs) and scored in code against tool_calls, so "there was nothing to find" can be told from "the agent never looked" -- not_attempted is the latter. other_fact is the escape hatch for a requirement the vocabulary cannot name and can never be satisfied.';

comment on column public.ticket_investigations.findings_trace is
  'The derived findings after each tool call, in call order: one entry per tool_calls entry, each { call, tool, findings }. THE REPLAY TAPE. tool_calls drops every tool''s data on purpose, and 8 of the finding derivations read it -- buyer_type, product_identity, promotion_validity, promotion_eligibility, customer_account_state, product_availability, photo_evidence, checkout_state -- so a replay over tool_calls alone would score those as absent, fire fewer rules and stop earlier, flattering rule-guided collection exactly where it is most likely to under-collect. Findings are a closed enum carrying no personal data, which is why they are safe to keep where data was correctly dropped. NULL means the row predates this column and can never be filled, since the data it derives from is gone; [] means the run made no tool calls.';
comment on column public.ticket_investigations.exemplar_match is
  'Which support_exemplars situation this ticket matched: { verdict, exemplar_key, closest, similarity, margin, runner_up, requirement_needs }. REPORTED, NEVER ACTED ON -- nothing in the investigation reads it and the model is never told, so requirement_needs can be compared against the run''s own evidence_gaps as an independent measure. exemplar_key is the committed match and is null unless the verdict is matched; closest is the nearest situation whatever the verdict, which on a near miss is the diagnostic worth having. verdict is matched / near / weak / none / ambiguous, where ambiguous means two situations were closer together than the margin can separate. Empty when retrieval found nothing or failed -- it is best-effort and never fails a run.';

comment on column public.ticket_investigations.company_policies is
  'The company policies this case read: [{ key, version, source }], source situation (linked to the matched situation), rule (linked to the selected rule) or agent (fetched by the model with getPolicy). Drafting reads each policy''s current text by key; the version says which text the investigation saw.';

comment on column public.ticket_investigations.context_ref is
  'Pointer to tickets.resolved_context (order name, customer id, whether a bundle exists) rather than a copy of it -- so personal data is not duplicated per investigation, and a rebuilt bundle is not shadowed by a stale copy.';

comment on column public.ticket_investigations.customer_id is
  'Denormalised link to the customer, and the seam for future per-customer memory: prior case files for this customer are a query on this column.';

-- ---------------------------------------------------------------- ticket_case_state

-- ============================================================================
-- WHAT A NEW MESSAGE CHANGED ABOUT AN ONGOING CASE
--
-- One row per inbound message that arrived on a ticket which had already been
-- read once. The first message of a thread has no row: there is no prior case
-- for it to change, and the case file already says everything a first reading
-- can.
--
-- WHY IT IS NOT A DOCUMENT ON `tickets`. Two shapes already exist side by side
-- in this schema and they answer different questions. `resolved_context` is a
-- snapshot overwritten in place, because "the current state of the order" has
-- one correct value. This is a READING of a message, and a thread's readings
-- are a trajectory — the same reason `ticket_investigations` is keyed per
-- trigger message rather than per ticket. A mutable `metadata.case_state` would
-- have lost which message established what, which is the one thing a follow-up
-- needs to know.
--
-- IT IS NOT A SECOND WORKFLOW ENGINE. Nothing here decides what happens next.
-- The situation and the verdict stay where they are; this records what the
-- newest message did to a case, and the existing rules read it.
-- ============================================================================
create table public.ticket_case_state (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  trigger_message_id uuid not null references public.ticket_messages(id) on delete cascade,

  -- How this message relates to the case that already existed. A closed
  -- vocabulary: the model picks which, and this codebase owns what each means.
  -- Null on a reading of OUR message or a colleague's/partner's (stage 5): it
  -- is the customer's relationship to their own case, and drives the categoriser.
  case_relationship text,

  -- STAGE 5 (migration 42): who wrote the message, what it did (`effect`, from
  -- agent/src/casework/effects.mjs), the customer questions OUR message asked,
  -- and the checks it opened ({ owner, need, quote }) and cleared (ids). The
  -- fold (case-fold.mjs) turns these into obligations and who acts next.
  actor text,
  effect text,
  asked jsonb not null default '[]'::jsonb,
  obligations_opened jsonb not null default '[]'::jsonb,
  obligations_cleared jsonb not null default '[]'::jsonb,

  -- The situation carried forward from the previous reading, so a follow-up is
  -- answered as the case it belongs to rather than re-matched from the opening
  -- message every run. Null when no situation was ever matched, which is the
  -- honest state for a thread the library does not cover.
  situation_key text,

  -- What we asked for and whether this message answered it. The whole reason
  -- this table exists: recovered from prose afterwards the question is a guess,
  -- recorded when it is asked it is a fact.
  resolved_inputs jsonb not null default '[]'::jsonb,
  pending_customer_inputs jsonb not null default '[]'::jsonb,

  -- What the message added, what we have promised, and where the two disagree.
  new_facts jsonb not null default '[]'::jsonb,
  commitments jsonb not null default '[]'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,

  -- Which needs a prior run already established, as OUTCOME BUCKETS only:
  -- { need, tool, argsHash, outcome, run_at, status }. Never the tool's data.
  -- `ticket_investigations.tool_calls` drops that deliberately and `context_ref`
  -- points at `resolved_context` rather than copying it, both so personal data
  -- is not duplicated per run. This table does not reopen that.
  evidence_reuse jsonb not null default '{}'::jsonb,

  case_summary text,
  model text,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- The same idempotency key as `ticket_investigations` and `ticket_drafts`:
  -- one reading per message, so a re-run rewrites its own row and a reply adds
  -- a new one.
  unique (shop_id, trigger_message_id),

  constraint ticket_case_state_relationship_check check (
    case_relationship is null or case_relationship in ('continuation', 'new_information', 'new_issue', 'unclear')
  ),
  constraint ticket_case_state_actor_check check (
    actor is null or actor in ('customer', 'support', 'colleague', 'partner')
  ),
  constraint ticket_case_state_effect_check check (
    effect is null or effect in ('continuation', 'chase', 'new_information', 'new_issue', 'closes_case', 'internal_note', 'noise', 'answers', 'asks_customer', 'holding', 'internal_request')
  ),
  constraint ticket_case_state_asked_array_check check (
    jsonb_typeof(asked) = 'array'
  ),
  constraint ticket_case_state_obligations_opened_array_check check (
    jsonb_typeof(obligations_opened) = 'array'
  ),
  constraint ticket_case_state_obligations_cleared_array_check check (
    jsonb_typeof(obligations_cleared) = 'array'
  ),
  constraint ticket_case_state_resolved_inputs_array_check check (
    jsonb_typeof(resolved_inputs) = 'array'
  ),
  constraint ticket_case_state_pending_inputs_array_check check (
    jsonb_typeof(pending_customer_inputs) = 'array'
  ),
  constraint ticket_case_state_new_facts_array_check check (
    jsonb_typeof(new_facts) = 'array'
  ),
  constraint ticket_case_state_commitments_array_check check (
    jsonb_typeof(commitments) = 'array'
  ),
  constraint ticket_case_state_contradictions_array_check check (
    jsonb_typeof(contradictions) = 'array'
  ),
  constraint ticket_case_state_evidence_reuse_object_check check (
    jsonb_typeof(evidence_reuse) = 'object'
  )
);

create index ticket_case_state_ticket_idx
  on public.ticket_case_state (ticket_id, read_at desc);

alter table public.ticket_case_state enable row level security;

comment on table public.ticket_case_state is
  'One reading per inbound message that landed on a ticket already read once: what the message changed about the case. Keyed per trigger message like ticket_investigations, because a thread''s readings are a trajectory rather than a current value. Records what was asked and answered, what was promised, and which prior evidence may be reused -- never what a tool returned.';

comment on column public.ticket_case_state.case_relationship is
  'continuation | new_information | new_issue | unclear. Drives whether the categoriser re-runs and whether the situation is carried forward; a closed vocabulary the model selects from and this codebase defines.';

comment on column public.ticket_case_state.situation_key is
  'The situation carried forward from the previous reading, so a follow-up is not re-matched on the opening message every run. Null when none was ever matched.';

comment on column public.ticket_case_state.resolved_inputs is
  'MISSING_FIELDS keys this message answered. Recorded when the question is answered rather than recovered from prose later, which is what makes it a fact rather than a guess.';

comment on column public.ticket_case_state.evidence_reuse is
  'Per need a prior run touched: { tool, argsHash, outcome, run_at, status }. Outcome buckets only, never tool data -- the same personal-data boundary tool_calls and context_ref already hold.';

-- ---------------------------------------------------------------- case_current
--
-- The current state of each case (codex_plans/Case_State_Plan.md, stage 4).
-- 41_case_current.sql carries a populated database to it; 41's test asserts the
-- two agree.

create table public.case_current (
  ticket_id uuid primary key references public.tickets(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,

  version integer not null default 1,
  as_of_message_id uuid references public.ticket_messages(id) on delete set null,
  as_of_at timestamptz,
  last_actor text,

  pending_customer_inputs jsonb not null default '[]'::jsonb,
  commitments jsonb not null default '[]'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,
  obligations jsonb not null default '[]'::jsonb,

  next_actor text,
  resolved boolean not null default false,

  material_hash text not null,
  folded_at timestamptz not null default now(),

  constraint case_current_last_actor_check check (
    last_actor is null or last_actor in ('customer', 'support', 'colleague', 'partner')
  ),
  constraint case_current_next_actor_check check (
    next_actor is null or next_actor in ('customer', 'support', 'colleague', 'partner', 'nobody')
  ),
  constraint case_current_pending_inputs_array_check check (
    jsonb_typeof(pending_customer_inputs) = 'array'
  ),
  constraint case_current_commitments_array_check check (
    jsonb_typeof(commitments) = 'array'
  ),
  constraint case_current_contradictions_array_check check (
    jsonb_typeof(contradictions) = 'array'
  ),
  constraint case_current_obligations_array_check check (
    jsonb_typeof(obligations) = 'array'
  )
);

create index case_current_shop_next_actor_idx
  on public.case_current (shop_id, next_actor);

alter table public.case_current enable row level security;

comment on table public.case_current is
  'The current state of each case, one row per ticket, overwritten in place like resolved_context: folded in code (agent/src/casework/case-fold.mjs) from the ticket''s messages, its Case Manager readings and its latest case file. No model writes it. ticket_case_state stays the per-message trajectory.';

comment on column public.case_current.version is
  'Raised only when material_hash changes, so a thank-you that changes nothing does not make a draft stale (codex_plans/Case_State_Plan.md, stage 6).';

comment on column public.case_current.next_actor is
  'Who owes the next step: customer | support | colleague | partner | nobody. Derived by the fold; nothing reads it to change a ticket''s status yet (stage 5).';

comment on column public.case_current.obligations is
  'Checks owed by support, a colleague or an operations partner. Empty until stage 5 creates them.';

-- ---------------------------------------------------------------- ticket_case_actions
--
-- Stage 5 of codex_plans/Case_State_Plan.md. 43_case_actions.sql carries a
-- populated database to it; 43's test asserts the two agree.

create table public.ticket_case_actions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- The obligation it settles, by the id the fold gives it (`o-<message>-<n>`).
  obligation_id text not null,
  action text not null,
  note text,

  -- The dashboard user's id, never a name or an address.
  acted_by text,
  acted_at timestamptz not null default now(),

  constraint ticket_case_actions_action_check check (
    action in ('fulfilled', 'cancelled')
  )
);

create index ticket_case_actions_ticket_idx
  on public.ticket_case_actions (ticket_id, acted_at);

alter table public.ticket_case_actions enable row level security;

comment on table public.ticket_case_actions is
  'What a person did to a case from the dashboard: an open check marked done or cancelled. The fold (agent/src/casework/case-fold.mjs) applies these after the readings, so a check that was settled by phone or in Shopify stops being owed. Append-only.';

-- ---------------------------------------------------------------- ticket_snoozes
--
-- Snooze: a case hidden from the queue until a message, a change of case or
-- its deadline brings it back. 54_ticket_snoozes.sql carries a populated
-- database to it; 54's test asserts the two agree.

create table public.ticket_snoozes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- `auto`: the fold, after a message of ours was sent. `manual`: a person.
  source text not null,
  waiting_for text not null,
  reason text,

  -- Every snooze has a deadline: a failed webhook or a partner who never
  -- answers must not hide a case for ever. A new message wakes it sooner.
  wake_at timestamptz not null,

  -- Auto only: the message of ours that was sent, and the case version then.
  trigger_message_id uuid references public.ticket_messages(id) on delete set null,
  case_version integer,

  -- 'agent', or the dashboard user's id. Never a name or an address.
  snoozed_by text,
  snoozed_at timestamptz not null default now(),

  -- Null while the snooze is open.
  woke_at timestamptz,
  wake_reason text,
  woken_by text,

  constraint ticket_snoozes_source_check check (
    source in ('auto', 'manual')
  ),
  constraint ticket_snoozes_waiting_for_check check (
    waiting_for in ('customer', 'colleague', 'partner', 'date')
  ),
  constraint ticket_snoozes_wake_reason_check check (
    wake_reason is null or wake_reason in (
      'customer_message',
      'colleague_message',
      'partner_message',
      'deadline',
      'manual',
      'case_changed',
      'resolved',
      'order_update'
    )
  ),
  constraint ticket_snoozes_woke_check check (
    (woke_at is null) = (wake_reason is null)
  )
);

-- At most one open snooze per ticket.
create unique index ticket_snoozes_open_key
  on public.ticket_snoozes (ticket_id) where woke_at is null;

-- One automatic snooze per message of ours: a ticket woken by its deadline is
-- not snoozed again until something new happens.
create unique index ticket_snoozes_auto_trigger_key
  on public.ticket_snoozes (ticket_id, trigger_message_id) where source = 'auto';

-- The deadline sweep.
create index ticket_snoozes_due_idx
  on public.ticket_snoozes (shop_id, wake_at) where woke_at is null;

alter table public.ticket_snoozes enable row level security;

comment on table public.ticket_snoozes is
  'A case hidden from the queue until something happens: one row per snooze, the open one (woke_at null) being the current. Not a ticket status: the status still says who acts next. Written only by scripts/lib/snooze-record.mjs. History is kept, so an automatic snooze a person undid early stays visible.';
comment on column public.ticket_snoozes.waiting_for is
  'customer | colleague | partner (an operations partner: 3PL or carrier) | date (a person chose a time).';
comment on column public.ticket_snoozes.wake_at is
  'The fallback deadline. The worker wakes the ticket then (wake_reason deadline) without calling a model.';
comment on column public.ticket_snoozes.wake_reason is
  'Why it came back: a new message by actor, the deadline, a person, the case moving to us (case_changed) or to nobody (resolved), or an order update.';

-- ---------------------------------------------------------------- case_links

-- EVERY CASE-LINKING DECISION, append-only: which thread, from which case to
-- which, by what rule, and what the candidates were. A new case is a decision
-- too and is recorded, so « why was this not linked » has an answer. The
-- model's raw answer is kept when one was asked.
create table public.case_links (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  -- The case the thread was in before, and the one it is in after. Equal for a
  -- new case. Not foreign keys: an emptied case is deleted and its id stays
  -- here as history.
  from_case_id uuid not null,
  to_case_id uuid not null,
  decision text not null,
  method text not null,
  -- [{ case_id, reasons: [...] }] as retrieved. Ids and reasons only, no text.
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

create index case_links_ticket_idx on public.case_links (ticket_id, decided_at desc);

alter table public.case_links enable row level security;

comment on table public.case_links is
  'Append-only: every case-linking decision, a new case included, with the rule (method) and the candidates considered. Written only by scripts/lib/case-record.mjs.';
comment on column public.case_links.method is
  'first_contact (no other case for this customer) · reply_chain / identical_body (the duplicate rules) · tracking / order_family / unique_match (deterministic identifiers) · model (the Case Linker chose) · model_off (ambiguous, model switched off, so a new case) · no_candidates · excluded_sender (a listed sender or one of our own threads) · backfill (61_cases.sql).';

-- ---------------------------------------------------------------- ticket_overrides
--
-- 48_ticket_overrides.sql carries a populated database to it; 48's test asserts
-- the two agree.

create table public.ticket_overrides (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  field text not null,
  action text not null,
  -- Null on a reset. Text whatever the field: a level is stored as '3'.
  value text,
  -- What the pipeline said at the time, so a correction can be measured against it.
  ai_value text,
  source text,

  -- The dashboard user's id, never a name or an address.
  set_by text,
  set_at timestamptz not null default now(),

  constraint ticket_overrides_field_check check (
    field in ('situation', 'category', 'level', 'status', 'responsible_team', 'priority')
  ),
  constraint ticket_overrides_action_check check (action in ('set', 'cleared')),
  constraint ticket_overrides_value_check check ((action = 'set') = (value is not null))
);

create index ticket_overrides_ticket_idx
  on public.ticket_overrides (ticket_id, set_at);

alter table public.ticket_overrides enable row level security;

comment on table public.ticket_overrides is
  'Every correction a person made to a ticket from the dashboard, and every reset to automatic. Append-only audit: the active values live in tickets.overrides.';

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
  -- The destination it went to, as named then. Null on rows from before
  -- destinations existed.
  destination_label text,

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

comment on column public.ticket_forwards.destination_label is
  'The destination this forward went to, as named when it was sent. Null on rows written before destinations existed.';

comment on column public.ticket_forwards.attempts is
  'How many times this message has been attempted. Retry stops at the cap in agent/src/routing/forwarding-store.mjs, so a permanently undeliverable address fails a bounded number of times and then stays visible instead of being re-sent on every poll.';

comment on column public.ticket_forwards.status is
  'sent | failed. `sent` is final and excludes the message from future passes; `failed` is retried until attempts hits the cap. Recording upserts on ticket_message_id, so a retry updates this row rather than colliding with its unique constraint.';

-- ---------------------------------------------------------------- forwarding_destinations

-- Named destinations: who receives mail the contact team does not own, which
-- categories and kinds they may take, and what they handle in the business's
-- words. Replaces category_forwarding, which stays until the router reads
-- these (migration 49).

create table public.forwarding_destinations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- What the dashboard calls it: « Comptabilité », « Export ».
  label text not null,
  -- Null is the off switch, as in category_forwarding: a destination can be
  -- described before its address is known, and switched off without losing it.
  forward_email text check (forward_email is null or forward_email like '%_@_%'),
  -- What it handles, in the business's words. The router's only guide when a
  -- category has several destinations, so it is written for a reader, not a rule.
  description text not null default '',

  categories text[] not null,
  -- Empty means any kind.
  request_kinds text[] not null default '{}',
  -- The agent checks the mail against the description even when this is the
  -- category's only destination, and keeps the ticket when it does not fit.
  -- Without it, one destination takes the whole category unread: right for
  -- careers, wrong for defects, where `product` problems also hold a customer
  -- who cannot reach the phone line.
  match_description boolean not null default false,

  timing text not null default 'immediate',
  acknowledge boolean not null default true,
  -- The destination's switch: null is off, otherwise the moment it was switched
  -- on; it receives only mail received from then (migration 51).
  active_since timestamptz,

  -- Customer-facing name in the acknowledgement. The French one carries its
  -- own preposition (« au service comptabilité »), since « à le » is wrong.
  public_name_fr text,
  public_name_en text,
  -- An extra paragraph in that destination's acknowledgement only.
  ack_note_fr text,
  ack_note_en text,

  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint forwarding_destinations_label_unique unique (shop_id, label),
  constraint forwarding_destinations_categories_check check (
    cardinality(categories) > 0
    and categories <@ array[
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    ]::text[]
  ),
  constraint forwarding_destinations_request_kinds_check check (
    request_kinds <@ array['question', 'problem', 'complaint', 'contact']::text[]
  ),
  constraint forwarding_destinations_timing_check check (
    timing in ('immediate', 'after_first_reply')
  ),
  -- A destination that waits for our first reply has already written to the
  -- sender; a templated acknowledgement on top would repeat it.
  constraint forwarding_destinations_acknowledge_check check (
    not acknowledge or timing = 'immediate'
  ),
  constraint forwarding_destinations_active_needs_address_check check (
    active_since is null or forward_email is not null
  )
);

create index forwarding_destinations_shop_idx
  on public.forwarding_destinations (shop_id, position);

create trigger forwarding_destinations_set_updated_at
before update on public.forwarding_destinations
for each row
execute function public.set_updated_at();

alter table public.forwarding_destinations enable row level security;

comment on table public.forwarding_destinations is
  'Who receives mail the contact team does not own: a name, an address (null = off), the categories and request kinds it may take, and a description in the business''s words that the router reads when a category has several destinations. Written by Agent Setup > Forwarding.';

comment on column public.forwarding_destinations.timing is
  'immediate: forwarded as soon as routed, with the acknowledgement. after_first_reply: forwarded once the contact team''s first reply has gone out (cosmetovigilance and defects ask for information first).';

comment on column public.forwarding_destinations.public_name_fr is
  'The phrase that follows « Nous l''avons transmis » in the acknowledgement, preposition included: « au service comptabilité ». Null reads « au service concerné ».';

create table public.forwarding_settings (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  -- Off by default: this is the one email the system sends with no person
  -- approving it, so it is switched on deliberately.
  ack_enabled boolean not null default false,
  -- Null means the default template in scripts/lib/forwarding-destinations.mjs.
  ack_template_fr text,
  ack_template_en text,
  -- The master switch. Null forwards nothing; otherwise only mail received
  -- from this instant on, so turning forwarding on never sends the backlog.
  forward_since timestamptz,
  updated_at timestamptz not null default now()
);

create trigger forwarding_settings_set_updated_at
before update on public.forwarding_settings
for each row
execute function public.set_updated_at();

alter table public.forwarding_settings enable row level security;

comment on column public.forwarding_settings.forward_since is
  'The master switch. Null forwards nothing. Otherwise only inbound mail received at or after this instant is forwarded, so turning forwarding on never sends the backlog.';

comment on table public.forwarding_settings is
  'Shop-wide acknowledgement for forwarded mail: whether it is sent, and the FR/EN templates ({service}, {note}, {shop}). Null templates use the defaults in code.';

-- ---------------------------------------------------------------- agent_models

-- The model an agent runs on, chosen in Settings → Agent settings (migration
-- 53). No row means the env var (AGENT_*_MODEL, CHAT_MODEL) decides, so an
-- empty table changes nothing. Read by the worker every poll.

create table public.agent_models (
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The agent's id, the same one it records under in llm_usage.pass
  -- (scripts/lib/agent-models.mjs, AGENT_MODEL_KEYS). Embeddings are not
  -- here: the stored vectors were made with one model.
  agent text not null,
  -- An OpenAI model id. Only a name: a row can never switch an agent off.
  model text not null,
  -- The Supabase auth.users id of who chose it. No foreign key: auth is
  -- another schema, and the choice outlives the account.
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (shop_id, agent),
  constraint agent_models_agent_check check (
    agent in ('spam', 'categorise', 'situation', 'decompose', 'investigate', 'draft', 'chat', 'case_link')
  ),
  constraint agent_models_model_check check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
);

create trigger agent_models_set_updated_at
before update on public.agent_models
for each row
execute function public.set_updated_at();

alter table public.agent_models enable row level security;

comment on table public.agent_models is
  'The model each agent runs on, when chosen in Settings. Overrides the worker''s AGENT_*_MODEL and the dashboard''s CHAT_MODEL; no row means the env var decides.';

-- ---------------------------------------------------------------- ticket_routing

-- The router's decision per ticket and the once-per-ticket acknowledgement
-- (migration 50).

create table public.ticket_routing (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null unique references public.tickets(id) on delete cascade,

  -- What the decision was made on. A different category or kind on the ticket
  -- means the decision is stale and is taken again.
  category text not null,
  request_kind text,

  outcome text not null,
  method text not null,
  -- Null when the ticket stays, or when the destination was deleted since.
  destination_id uuid references public.forwarding_destinations(id) on delete set null,
  destination_label text,
  -- The model's one line; null on a fixed route.
  reason text,
  model text,
  decided_at timestamptz not null default now(),

  -- The acknowledgement, at most once per ticket. `requested` is written BEFORE
  -- the send, so a crash between the two is never retried into a second mail.
  ack_state text,
  ack_at timestamptz,
  ack_error text,
  ack_attempts integer not null default 0,

  constraint ticket_routing_outcome_check check (outcome in ('forward', 'keep')),
  constraint ticket_routing_method_check check (method in ('fixed', 'model')),
  constraint ticket_routing_destination_check check (outcome = 'keep' or destination_label is not null),
  constraint ticket_routing_ack_state_check check (
    ack_state is null or ack_state in ('requested', 'sent', 'failed', 'skipped')
  )
);

create index ticket_routing_shop_idx on public.ticket_routing (shop_id);

alter table public.ticket_routing enable row level security;

comment on table public.ticket_routing is
  'The forwarding router''s decision per ticket (forward to a destination, or keep), taken once and re-taken when the category or kind changes; and the once-per-ticket acknowledgement state.';

comment on column public.ticket_routing.ack_state is
  'requested (written before sending; never retried) | sent | failed (retried up to the cap) | skipped (automated or internal sender, or acknowledgements off). Null until the first forward.';

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

-- ---------------------------------------------------------------- mail_jobs

-- The durable queue between whatever asks for mail work and the worker that
-- does it. Two kinds, and only two:
--
--   sync_mailbox   "read this folder now". Enqueued by a provider change
--                  notification (the webhook). The worker's own poll reads
--                  both folders on a timer anyway, so this only shortens the
--                  wait: the poll is the truth, a job is a nudge.
--   send_outbound  "carry out this outbound action". Enqueued when a reply is
--                  approved; the action row (outbound_actions, 07) holds the
--                  business state, this row holds the attempts.
--
-- CASE PROCESSING IS NOT A JOB KIND. The pipeline's queues are derived from
-- the `needs_*` flags on `tickets`, which ingestion raises only for mail it
-- did not already hold (DECISIONS.md § Re-delivery is not arrival). A job per
-- message beside them would be a second source of truth for the same fact.
--
-- DEDUPED AMONG QUEUED ROWS ONLY. A burst of notifications for one folder
-- collapses into one queued job. A job already RUNNING does not absorb a new
-- one: its read may already be past the mail the notification is about.
--
-- Retries: `fail` pushes `next_attempt_at` out with backoff and counts the
-- attempt; past the cap the row goes `dead` and stays, visible, for a person.
-- A running row whose lease ran out (the worker died mid-job) is claimable
-- again, and that reclaim counts as an attempt, so a job that kills the worker
-- every time still reaches the cap.
create table public.mail_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  -- `sync:<folder>` or `send:<outbound action id>`.
  dedupe_key text not null,

  state text not null default 'queued',
  retry_count integer not null default 0,
  -- One line, no stack, no message body.
  last_error text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mail_jobs_kind_check check (kind in ('sync_mailbox', 'send_outbound', 'sync_social')),
  constraint mail_jobs_state_check check (state in ('queued', 'running', 'done', 'dead')),
  constraint mail_jobs_retry_count_check check (retry_count >= 0),
  constraint mail_jobs_payload_check check (jsonb_typeof(payload) = 'object')
);

create unique index mail_jobs_queued_dedupe_idx
  on public.mail_jobs (shop_id, dedupe_key)
  where state = 'queued';

create index mail_jobs_due_idx on public.mail_jobs (shop_id, state, next_attempt_at);

create trigger mail_jobs_set_updated_at
before update on public.mail_jobs
for each row
execute function public.set_updated_at();

alter table public.mail_jobs enable row level security;

comment on table public.mail_jobs is
  'Durable queue for mail work: sync_mailbox (a change notification asking for a folder to be read now) and send_outbound (carry out one outbound_actions row). Retries with backoff, dead after a cap, every attempt recorded. Case processing is deliberately not a kind: it runs off the needs_* flags ingestion raises only for new mail. Written only by scripts/lib/mail-job-record.mjs.';

comment on column public.mail_jobs.dedupe_key is
  'sync:<folder> or send:<outbound action id>. Unique among QUEUED rows only, so a burst of notifications collapses into one job while a job already running never swallows a newer request.';

comment on column public.mail_jobs.state is
  'queued -> running -> done, or dead once retry_count reaches the cap. A running row whose locked_until has passed is claimable again (the worker died holding it).';

comment on column public.mail_jobs.retry_count is
  'Failed attempts so far, including a lease that ran out. Compared against MAIL_JOB_MAX_ATTEMPTS by the worker.';

comment on column public.mail_jobs.next_attempt_at is
  'Not claimable before this. Pushed out with exponential backoff on each failure (scripts/lib/mail-job-record.mjs backoffMs).';

-- Enqueue, collapsing into a job already queued under the same key. PostgREST
-- cannot name a partial index as its conflict target, hence a function. On a
-- collision the queued row keeps its id and is brought forward if the new
-- request is due sooner, so a notification never waits out a retry backoff.
create or replace function public.enqueue_mail_job(
  p_shop_id uuid,
  p_kind text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default now()
)
returns setof public.mail_jobs
language sql
volatile
set search_path = public
as $$
  with queued as (insert into public.mail_jobs (shop_id, kind, dedupe_key, payload, next_attempt_at)
    values (p_shop_id, p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()))
    on conflict (shop_id, dedupe_key) where state = 'queued'
    do update set next_attempt_at = least(public.mail_jobs.next_attempt_at, excluded.next_attempt_at)
    returning *
  )
  select * from queued;
$$;

comment on function public.enqueue_mail_job is
  'Queue one mail job, or bring an already-queued job with the same dedupe_key forward. Returns the queued row.';

-- Claim due jobs for this worker, atomically. SKIP LOCKED so two workers never
-- take the same row; the lease (`locked_until`) is how a dead worker's job
-- comes back.
create or replace function public.claim_mail_jobs(
  p_shop_id uuid,
  p_kinds text[],
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.mail_jobs
language sql
volatile
set search_path = public
as $$
  with claimed as (update public.mail_jobs j
    set state = 'running',
        locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
        last_attempt_at = now(),
        retry_count = j.retry_count + case when j.state = 'running' then 1 else 0 end
    where j.id in (
      select c.id
      from public.mail_jobs c
      where c.shop_id = p_shop_id
        and c.kind = any (p_kinds)
        and (
          (c.state = 'queued' and c.next_attempt_at <= now())
          or (c.state = 'running' and c.locked_until < now())
        )
      order by c.next_attempt_at, c.created_at
      limit greatest(p_limit, 0)
      for update skip locked
    )
    returning j.*
  )
  select * from claimed;
$$;

comment on function public.claim_mail_jobs is
  'Take up to p_limit due jobs of the given kinds: queued and due, or running with an expired lease (counted as a failed attempt). Marks them running with a lease of p_lease_seconds.';

-- ---------------------------------------------------------------- mail_subscriptions

-- One provider change-notification subscription per shop and folder. The
-- subscription is only a trigger (see mail_jobs); losing one costs latency,
-- never mail, because the poll reads both folders regardless.
--
-- THE CLIENT STATE IS STORED HASHED. It is the shared secret a notification
-- must echo to be believed; the webhook hashes what arrives and compares.
create table public.mail_subscriptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  provider text not null,
  folder text not null,
  -- The provider's id for the subscription. Replaced in place when it is
  -- recreated, so there is one row per shop, provider and folder.
  subscription_id text not null unique,
  client_state_hash text not null,
  expires_at timestamptz not null,
  last_renewed_at timestamptz,
  -- Set by a lifecycle notification (reauthorisation required, removed);
  -- cleared by the next successful renewal.
  needs_renewal boolean not null default false,
  last_error text,
  last_error_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mail_subscriptions_provider_check check (provider in ('outlook')),
  constraint mail_subscriptions_folder_check check (folder in ('inbox', 'sentitems')),
  constraint mail_subscriptions_shop_folder_key unique (shop_id, provider, folder)
);

create trigger mail_subscriptions_set_updated_at
before update on public.mail_subscriptions
for each row
execute function public.set_updated_at();

alter table public.mail_subscriptions enable row level security;

comment on table public.mail_subscriptions is
  'Provider change-notification subscriptions, one per shop, provider and folder. Created and renewed by agent/src/mail/subscription-manager.mjs only when MAIL_WEBHOOK_URL is set. A trigger, never the truth: a lost subscription costs latency, not mail.';

comment on column public.mail_subscriptions.client_state_hash is
  'sha256 of the clientState secret given to the provider at creation. The webhook hashes the clientState a notification carries and compares; the secret itself is never stored.';

comment on column public.mail_subscriptions.last_error is
  'The last create or renew failure, one line. Paired with an error-level log (mail.subscription_renew_failed): the alert, until the project has an alert channel.';


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

-- How many messages a ticket holds, and the inbound/outbound activity facts
-- the read-time priority scorer needs.
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
    count(*) as message_count,
    count(*) filter (where m.direction = 'inbound') as inbound_count,
    max(m.received_at) filter (where m.direction = 'inbound') as latest_inbound_at,
    max(m.sent_at) filter (where m.direction = 'outbound') as latest_outbound_at
  from public.ticket_messages m
  where m.deleted_at is null
  group by m.shop_id, m.ticket_id;

revoke all on public.ticket_message_counts from anon, authenticated;

comment on view public.ticket_message_counts is
  'Message count and inbound/outbound activity per ticket, excluding soft-deleted messages. Read by the dashboard queue instead of counting rows client-side.';

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
    -- WHO OPENED THE THREAD. `tickets` deliberately keeps only a hash of the
    -- requester, which is right for the row but leaves no way to ask "is this
    -- one of ours" -- `sender_directory` matches on an address or a domain, and
    -- a hash matches neither. The address lives on the message already; this
    -- carries it up to the one place a per-ticket question can reach it.
    -- Server-side only: the tickets service resolves it to a label and sends
    -- the label, never the address, to the browser.
    m.from_email as from_email,
    m.received_at as received_at
  from public.ticket_messages m
  where m.direction = 'inbound'
    and m.deleted_at is null
  order by m.ticket_id, m.received_at asc;

revoke all on public.ticket_first_inbound from anon, authenticated;

comment on view public.ticket_first_inbound is
  'One row per ticket: its earliest inbound message, already stripped of quoted reply chains by ingestion. Read by order resolution, which needs the customer''s own words rather than the thread.';

-- -------------------------------------------------------- case_message_counts

-- ticket_message_counts, one level up: every message of every live thread of a
-- case. What the queue's priority reads once a case spans several threads --
-- a customer who wrote twice on two threads has written four times, not twice.
create view public.case_message_counts
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

-- ------------------------------------------------------------------ case_facts

-- ONE ROW PER CASE, for everything that counts cases rather than threads: the
-- queue's case columns and the Insights support figures. The rules for folding
-- several threads into one row live here, once:
--   what it is about   the EARLIEST thread's labels (what the customer first
--                      came about -- the situation is matched on the opening
--                      message for the same reason)
--   how serious, how   the highest level and the worst mood of any thread
--   unhappy
--   status             awaiting_human if any thread is; resolved/closed only
--                      when every thread is; otherwise the most recently
--                      active open thread's
--   lead               the reply thread when it is live, else the most
--                      recently active thread still live (not resolved or
--                      closed), else the most recently active. A case with a
--                      thread still open never leads with a finished one: the
--                      queue shows lead rows only, so it would vanish (62)
--   first reply        the case's first inbound message to our first outbound
--                      after it, on any thread
create view public.case_facts
with (security_invoker = true) as
  select
    k.id as case_id,
    k.shop_id as shop_id,
    case when a.has_reply_thread then k.reply_thread_id else a.fallback_lead_id end as lead_ticket_id,
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
      (array_agg(t.id order by (t.status not in ('resolved', 'closed')) desc, t.last_message_at desc nulls last))[1] as fallback_lead_id,
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
  'One row per case with at least one live thread: the earliest thread''s subject, the highest level and worst mood of any thread, a status folded across threads, the lead thread (the reply thread, else the most recently active thread still live, else the most recently active), and the case''s first-reply time across threads. Read by the queue and by the Insights support figures, which count cases.';

-- -------------------------------------------------------------- ticket_queue

-- The dashboard queue, as one row per ticket.
--
-- Folds together what the list read was doing in three parts: the ticket
-- columns, the customer resolved over tickets.customer_id, and the message
-- count plus the priority scorer's activity facts. The customer join was already free (PostgREST resolved it as an embed
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

revoke all on public.ticket_queue from anon, authenticated;

comment on view public.ticket_queue is
  'One row per live ticket with its customer, message count and priority activity facts already joined -- the projection the dashboard list renders and the status write returns. Soft-deleted tickets are excluded here rather than by the caller; archived ones are kept and filtered in the UI. LEFT JOIN on customers: most tickets are unlinked until the customer-resolution pass runs.';
