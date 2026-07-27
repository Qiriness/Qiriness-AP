-- Human review set for the categorising agent (AGENT_INTEGRATION_PLAN Phase 3
-- exit criterion: "categoriser agrees with human labelling on a review set").
--
-- Until now the review set was 40 invented emails in agent/eval/, which measures
-- the prompt against the taxonomy but not against real customers. This table holds
-- a random sample of REAL support mail so a human can label it in the Supabase
-- table editor, and the agent can then be scored against that labelling.
--
-- Blind by design: the human_* columns are filled in first, and the agent_*
-- columns stay empty until the comparison runs. Showing the agent's answer next
-- to an empty box would anchor the reviewer and inflate the agreement score.
--
-- This is a TESTING artefact, not part of the runtime pipeline. Nothing in the
-- worker reads it, and rows here are unrelated to tickets / ticket_messages --
-- the sampler reads the mailbox directly (GET only) and never ingests.
--
-- Personal data: rows hold real customer email subjects and bodies, which is the
-- minimum a human needs to judge a category. The sender is reduced to its DOMAIN
-- (enough to tell a B2B enquiry from a consumer one, not enough to identify the
-- person), and retention is capped at 3 months by default -- shorter than tickets,
-- because a review set has no operational value once it has been scored.

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

  -- Same vocabulary as tickets (012), so a label typed here is a label the agent
  -- could have produced. The constraint is what stops a typo becoming a
  -- disagreement the comparison would report as a model error.
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
