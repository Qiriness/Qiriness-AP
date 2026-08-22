-- ============================================================================
-- 08 — TESTING
-- What happened when an operator put a made-up message through the real agent.
--
-- ONE TABLE, and the interesting thing about it is what it does NOT reference.
-- There is no ticket_id, no ticket_message_id and no investigation_id, because
-- a rehearsal writes none of those rows: the passes run against in-memory
-- stores (agent/src/testing/), so the queue, the case files, the drafts and
-- every Insights view stay untouched by a test. A run is therefore a leaf --
-- nothing in the support schema points at it and it points at nothing there.
--
-- WHY IT IS PERSISTED AT ALL. A rehearsal you cannot look at afterwards can
-- only answer "does it work right now". The two questions worth the table are
-- the ones that need two runs to answer: did changing the prompt / the article
-- / the bands make this better, and what should the agent have said. The second
-- is `ideal_body_text`, which is the same capture as ticket_draft_edits and for
-- the same future -- a corpus of (situation, ideal answer) pairs -- except that
-- here the situation can be INVENTED, so a gap in the agent's behaviour can be
-- written down before a customer has hit it.
--
-- PERSONAL DATA. The operator types an identity so that the customer and order
-- tools have something to resolve, and on a dev store that is usually a real
-- customer's address. Only the MASK is kept -- `j***l@orange.fr`, the same
-- treatment orders gives a contact. Not the plaintext, and not the hash either:
-- nothing here matches on one, so a hash would be a bare identifier with no
-- reader. Re-running an old test therefore means typing the address again,
-- which is the correct price.
--
-- Requires: 01_foundation.sql (shops, set_updated_at) and 03_knowledge.sql
-- (knowledge_documents).
-- ============================================================================

-- ------------------------------------------------------------ agent_test_runs

-- ============================================================================
-- agent_test_runs — one rehearsal of the pipeline
-- ============================================================================
--
-- THE TRACE IS THE RECORD, and the flat columns beside it are an index into it.
-- `trace` holds every step the run emitted: the gate decision, the tool ledger
-- with the exact French text each tool handed back, every model call with its
-- system prompt and its messages, and the composed drafting prompt. That is a
-- large object and it is the entire value of the feature -- the flat columns
-- exist so a list of runs can be rendered without parsing one.
--
-- NOT AN AUDIT TRAIL. Nothing downstream reads these rows, no measurement is
-- taken from them, and they are deletable individually. They are an operator's
-- notebook.
--
-- COST IS RECORDED HERE AND NOT IN llm_usage. A test run spends real money, but
-- `llm_usage` answers "what does handling the real mailbox cost" and its
-- `pass` check constraint admits only the worker's own passes. Folding
-- rehearsal spend into it would move the Agent panel's per-ticket figures
-- without anything saying why -- see DECISIONS.md § Agent test chat.

create table public.agent_test_runs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  -- ---- what was asked ------------------------------------------------------

  -- The identity the operator typed, reduced to what a person needs to
  -- RECOGNISE it: `j***l@orange.fr`. The run resolved a customer from the full
  -- address in memory and kept none of it.
  requester_name text,
  requester_email_masked text,

  subject text,
  -- The typed message. Operator-authored prose about an invented situation, so
  -- unlike ticket_messages.body_text it is not a customer's mail.
  body_text text not null,
  -- An order number the operator supplied as part of the invented situation.
  -- Held apart from the body because on a real email it would be in the body
  -- and the parser would have to find it -- here it is stated, and the run
  -- records which of the two it was.
  order_number text,

  -- ---- what was expected, when the run was testing an article --------------

  -- The knowledge article the operator was testing. Null on a free test.
  -- ON DELETE SET NULL rather than cascade: deleting an article should not
  -- silently delete the evidence of how it behaved.
  expect_document_id uuid references public.knowledge_documents(id) on delete set null,

  -- Whether that article was reached, and how far it got. Five states because
  -- the four failures want four different fixes -- see
  -- agent/src/testing/article-check.mjs, which derives this.
  --
  --   used                 a chunk of it reached the drafting model
  --   retrieved_withheld    found, but banded weak/none, so it was withheld
  --   outranked             found, but below the cut another article took
  --   not_retrieved         no chunk of it was in the candidate pool
  --   not_searched          the knowledge tool never ran for this ticket
  article_verdict text,

  -- ---- what the pipeline did ----------------------------------------------

  -- How far the run got. `gated` is a complete run whose answer is that the
  -- spam gate would have dropped the message: a real outcome, not a failure.
  status text not null default 'complete',

  -- The gate's own verdict, kept even on a run the operator chose to continue
  -- past, because "this would have been dropped" is the finding.
  gate_outcome text,

  -- The labels the categoriser gave it. Denormalised from the trace so a list
  -- of runs reads without opening one.
  category text,
  request_kind text,
  level smallint,
  language text,

  -- The case file's verdict, and the drafting pass's decision about it.
  verdict text,
  -- Null where draftDecision refused; `draft_skipped_reason` says which rule.
  draft_body_text text,
  draft_skipped_reason text,
  draft_checks_passed boolean,
  draft_disposition text,

  -- ---- what a person thought it should have said ---------------------------

  -- THE MEMORY. What the operator would have sent instead, typed in the same
  -- view that showed them the draft. Nothing reads it yet -- it is the corpus
  -- side of the same capture ticket_draft_edits makes for real mail, with the
  -- difference that a rehearsal can be invented, so an ideal answer can be
  -- written for a situation that has not happened.
  ideal_body_text text,
  ideal_saved_at timestamptz,

  -- ---- the record ----------------------------------------------------------

  -- Every step, in order. See agent/src/testing/trace.mjs for the shape.
  trace jsonb not null default '[]'::jsonb,

  -- What the run cost, in tokens. Money is computed at read time from
  -- scripts/lib/llm-rates.mjs, exactly as the Insights panels do it.
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  call_count integer not null default 0,

  -- Present on `status = 'failed'`: which pass threw, and what it said.
  failed_pass text,
  error_message text,

  ran_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agent_test_runs_status_check check (
    status in ('complete', 'gated', 'failed')
  ),
  constraint agent_test_runs_article_verdict_check check (
    article_verdict is null or article_verdict in (
      'used', 'retrieved_withheld', 'outranked', 'not_retrieved', 'not_searched'
    )
  ),
  -- An article verdict without an article is a verdict about nothing.
  constraint agent_test_runs_article_verdict_needs_document_check check (
    article_verdict is null or expect_document_id is not null
  ),
  constraint agent_test_runs_body_text_check check (btrim(body_text) <> ''),
  -- Level 4 is never drafted and the taxonomy has no fifth level; the same
  -- range tickets.level carries.
  constraint agent_test_runs_level_check check (level is null or level between 1 and 4),
  -- The same list as tickets.language, mirrored from support-taxonomy.mjs and
  -- held in step by the migration test.
  constraint agent_test_runs_language_check check (
    language is null or language in ('fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other')
  ),
  constraint agent_test_runs_verdict_check check (
    verdict is null or verdict in ('answerable', 'needs_customer_input', 'needs_human')
  ),
  constraint agent_test_runs_trace_array_check check (
    jsonb_typeof(trace) = 'array'
  ),
  -- An ideal answer that is blank is not an ideal answer, and a stamp without
  -- text (or text without a stamp) means the save path wrote half a row.
  constraint agent_test_runs_ideal_body_check check (
    (ideal_body_text is null and ideal_saved_at is null)
    or (btrim(coalesce(ideal_body_text, '')) <> '' and ideal_saved_at is not null)
  ),
  constraint agent_test_runs_input_tokens_check check (input_tokens >= 0),
  constraint agent_test_runs_output_tokens_check check (output_tokens >= 0),
  constraint agent_test_runs_total_tokens_check check (total_tokens >= 0),
  constraint agent_test_runs_call_count_check check (call_count >= 0)
);

-- The history list: this shop's runs, newest first.
create index agent_test_runs_shop_ran_idx on public.agent_test_runs (shop_id, ran_at desc);

-- "How has this article behaved?" -- every run that was testing one, newest
-- first. Partial, because most runs are free tests and carry no article.
create index agent_test_runs_document_idx
  on public.agent_test_runs (expect_document_id, ran_at desc)
  where expect_document_id is not null;

-- The corpus read: the runs somebody wrote an ideal answer for.
create index agent_test_runs_ideal_idx
  on public.agent_test_runs (shop_id, ideal_saved_at desc)
  where ideal_body_text is not null;

create trigger agent_test_runs_set_updated_at
  before update on public.agent_test_runs
  for each row execute function public.set_updated_at();

alter table public.agent_test_runs enable row level security;

comment on table public.agent_test_runs is
  'One rehearsal of the agent pipeline against a message an operator typed, from the Agent Setup test chat. References no ticket, message, investigation or draft because a rehearsal writes none of them -- the passes run against in-memory stores, so the queue and every Insights view are untouched by a test. Nothing downstream reads these rows: they are an operator''s notebook, plus the ideal-answer capture that is the invented-situation half of ticket_draft_edits.';

comment on column public.agent_test_runs.requester_email_masked is
  'j***l@orange.fr -- which address this run was made with, and nothing more. Same treatment as orders.customer_email_masked. Neither the plaintext nor a hash is kept: the run matched a customer from the address in memory, and a stored hash would be a bare identifier nothing here reads.';

comment on column public.agent_test_runs.order_number is
  'An order number the operator supplied as part of the invented situation, held apart from the body. On a real email it would be inside the text and the parser would have to find it; the run records which of the two happened.';

comment on column public.agent_test_runs.expect_document_id is
  'The knowledge article this run was testing. Null on a free test. ON DELETE SET NULL: deleting an article must not delete the evidence of how it behaved.';

comment on column public.agent_test_runs.article_verdict is
  'How far the tested article got: used, retrieved_withheld, outranked, not_retrieved, not_searched. Five states because the four failures point at four different fixes -- the wording, a competing article, the category or the embedding, and the ticket''s subject not permitting the knowledge tool at all. Derived by agent/src/testing/article-check.mjs.';

comment on column public.agent_test_runs.status is
  'complete, gated (the spam gate would have dropped the message -- a real outcome, not a failure) or failed.';

comment on column public.agent_test_runs.ideal_body_text is
  'What the operator would have sent instead. The memory this table exists for: the same (model text, human text) capture ticket_draft_edits makes for real mail, except the situation can be invented, so an ideal answer can be written for a case no customer has hit yet. Nothing reads it.';

comment on column public.agent_test_runs.trace is
  'Every step the run emitted, in order: the gate decision, the tool ledger with the exact text each tool returned, every model call with its system prompt and messages, and the composed drafting prompt. The flat columns beside it are an index into this, so a list of runs renders without parsing one. Shape in agent/src/testing/trace.mjs.';

comment on column public.agent_test_runs.total_tokens is
  'What the run cost, in tokens. Deliberately NOT in llm_usage: that table answers what handling the real mailbox costs, and rehearsal spend folded into it would move the Agent panel''s per-ticket figures with nothing saying why.';
