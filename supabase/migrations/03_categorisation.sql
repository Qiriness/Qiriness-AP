-- ============================================================================
-- 03 — CATEGORISATION
-- The support taxonomy, the ticket categorisation axes, the re-categorisation
-- loop and the human review set. Runs last: it constrains and extends the
-- knowledge and ticket tables created in 01_core_schema.sql.
--
-- ONE VOCABULARY, TWO CONSUMERS. `scripts/lib/support-taxonomy.mjs` is the
-- single JS source of the lists spelled out below; a check constraint cannot
-- import a module, so the values exist twice and the migration tests are what
-- stop the two drifting apart.
--
-- TWO AXES, STORED SEPARATELY:
--   category / secondary_category  -> SUBJECT: what the email is about (14
--                                     values, the same list knowledge articles
--                                     use, so a ticket subject filters straight
--                                     into matching knowledge chunks)
--   request_kind / secondary_...   -> KIND: what the sender wants (question |
--                                     problem | complaint | contact)
--
-- "order_problem" as one composed value would need stripping back to "order" for
-- every knowledge lookup, and would make the categoriser pick 1-of-23 flat
-- strings instead of 1-of-14 plus 1-of-4 (measurably easier for a cheap-tier
-- model, same expressiveness). The composed form is a display concern only.
--
-- `complaint` is a KIND, not a subject, so a delivery complaint is
-- (delivery, complaint). A standalone "complaints" bucket would have overlapped
-- every `problem` value and cost classifier accuracy.
--
-- NOTE ON THE SQUASH: the historical migrations this file replaces also carried
-- one-off DATA statements — renaming the old knowledge categories
-- (shipping_delivery -> delivery, returns_refunds -> return_exchange,
-- product_information -> product, payments -> payment, stock -> product_stock,
-- privacy/legal -> legal_privacy, b2b_partnerships -> b2b, general -> other) and
-- settling already-categorised tickets when needs_categorisation was introduced.
-- Both are omitted here: a database built from these three files has no rows to
-- migrate. They ran once against dev and are preserved in git history.
-- ============================================================================

-- ============================================================================
-- Knowledge side of the taxonomy
-- ============================================================================

-- Nullable: an article can exist before a category is chosen. The check only
-- rejects values outside the finalised vocabulary. Includes the two
-- knowledge-only shapes (faq, brand_story) that are never ticket subjects --
-- nobody emails support "an FAQ", and brand story is drafting context.
alter table public.knowledge_documents
  add constraint knowledge_documents_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other', 'faq', 'brand_story'
    )
  );

comment on column public.knowledge_documents.category is
  'Article subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs. The same 14 subjects the ticket categoriser assigns, plus the knowledge-only shapes faq and brand_story. Tickets additionally carry a request_kind; an article is reference material and has no kind.';

comment on column public.knowledge_chunks.category is
  'Denormalised copy of the parent knowledge_documents.category, kept in step with it. Included in embedded_input_hash, so a category change invalidates the chunk vector and the next embed run refreshes it.';

-- ============================================================================
-- Ticket side of the taxonomy
-- ============================================================================

alter table public.tickets
  add column request_kind text,
  add column secondary_request_kind text,

  -- Re-categorisation. A ticket's labels describe the conversation SO FAR, not
  -- the email that opened it: a thread can turn from an order question into a
  -- lost parcel, or into the threat of legal action that is the only route to
  -- level 4. Ingestion re-raises this flag whenever a new INBOUND message joins
  -- a thread, and the categoriser's batch pass selects on it.
  --
  -- A boolean rather than a `categorised_at < last_message_at` comparison for
  -- two reasons: PostgREST compares a column to a literal, never to another
  -- column, so the worker's REST client cannot express that filter; and
  -- last_message_at also advances on OUR outbound replies, so a timestamp rule
  -- would re-run the model every time the agent answered.
  --
  -- Default true so a newly inserted ticket is pending by construction — a
  -- ticket can never be created in a state the categoriser does not look at.
  add column needs_categorisation boolean not null default true,
  add column categorised_at timestamptz,

  -- Signals the categoriser reads off the same email in the same call.
  add column categorisation_confidence text,
  add column language text,
  add column happiness smallint;

alter table public.tickets
  -- Subjects: the shared 14. Deliberately excludes the knowledge-only faq and
  -- brand_story.
  add constraint tickets_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  add constraint tickets_secondary_category_check check (
    secondary_category is null or secondary_category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other'
    )
  ),
  add constraint tickets_request_kind_check check (
    request_kind is null or request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  add constraint tickets_secondary_request_kind_check check (
    secondary_request_kind is null
      or secondary_request_kind in ('question', 'problem', 'complaint', 'contact')
  ),
  -- A secondary kind without a secondary subject is meaningless; the subject is
  -- what the kind qualifies.
  add constraint tickets_secondary_pair_check check (
    secondary_request_kind is null or secondary_category is not null
  ),
  -- How sure the categoriser was of the pair it produced. Measured subject
  -- agreement with human labelling is ~77%, so roughly one ticket in four is
  -- mislabelled and nothing else in the row says which: this is that signal.
  add constraint tickets_categorisation_confidence_check check (
    categorisation_confidence is null
      or categorisation_confidence in ('high', 'medium', 'low')
  ),
  -- The language to REPLY in, restricted to what the desk can actually write.
  -- 'other' is a routing signal (a human takes it), not a label.
  add constraint tickets_language_check check (
    language is null or language in ('fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other')
  ),
  -- 1 happy .. 4 really unhappy. Same direction as level (1 benign, 4 the one
  -- you want to see) but deliberately independent of it -- see the comment below.
  add constraint tickets_happiness_check check (
    happiness is null or happiness between 1 and 4
  );

-- The queue filters and groups on (subject, kind) together.
create index tickets_shop_category_kind_idx
  on public.tickets (shop_id, category, request_kind);

-- The worker's pending query: pending tickets only, oldest first. Partial, so
-- the index holds the backlog rather than the whole table -- in steady state
-- almost every ticket is already categorised and drops straight out of it.
create index tickets_pending_categorisation_idx
  on public.tickets (shop_id, first_message_at)
  where needs_categorisation;

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
  'How sure the categoriser was of (category, request_kind): high, medium or low. Stored because measured subject agreement with human labelling on real mail is ~77% -- a label is not self-evidently right, and this is the only field that says which ones to distrust. Phase 5 gates auto-drafting on high. Low is also the fallback when the model returns an unusable value, so an unreadable answer is never recorded as a confident one.';

comment on column public.tickets.language is
  'Language the reply should be written in (fr, en, es, de, it, nl, pt, other), read from the customer''s own message by the categoriser. The mailbox is mostly French but not exclusively, and the drafting agent needs this before it writes a word. ''other'' means the desk cannot answer natively -- route to a human rather than guessing.';

comment on column public.tickets.happiness is
  'How the customer feels: 1 happy, 2 neutral, 3 discontent expressed, 4 really unhappy (threatening to stop buying, calling the situation unacceptable, or chasing an unanswered thread). Same direction as level, but NOT derived from it and it does not feed it: level is what WORK the ticket needs, happiness is how the customer feels about it. An angry customer with a simple tracking question is happiness 4, level 2 -- both true. Deriving one from the other would make a mood imply a severity and fill the manager queue with routine mail. Consumed by the drafting agent to set tone.';

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
