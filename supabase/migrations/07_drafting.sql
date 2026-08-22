-- ============================================================================
-- 07 — DRAFTING
-- What the agent would send, and where a human's decision about it is recorded.
--
-- ONE TABLE, and it is the seam between the investigation and a person. The
-- case file in 04 says what is TRUE about a ticket; this says what we would
-- WRITE about it. Keeping them apart is what lets a draft be rewritten from an
-- unchanged case file — the wording is the thing being iterated on in Phase 5,
-- and re-running an investigation to change a sentence would spend tool calls
-- to re-derive facts nobody disputed.
--
-- NOTHING HERE CAN SEND. There is no recipient column, no send action and no
-- Graph identifier: a row is text plus a decision about it. The one status
-- value that names sending (`sent`) is written by nothing today and is declared
-- so the lifecycle is legible, not because a send path exists — see
-- AGENT_INTEGRATION_PLAN.md, where the send path is blocked on which mailbox
-- this environment is for.
--
-- Requires: 01_foundation.sql (shops, set_updated_at) and 04_support.sql
-- (tickets, ticket_messages, ticket_investigations).
-- ============================================================================

-- ---------------------------------------------------------------- ticket_drafts

-- ============================================================================
-- ticket_drafts — the reply the agent would send
-- ============================================================================
--
-- IDEMPOTENCY, keyed on the message that triggered the run, exactly as
-- ticket_investigations is. `unique (shop_id, trigger_message_id)` means one
-- draft per inbound email: re-running the pass over the same thread rewrites
-- its own row, and a customer's reply produces a NEW draft rather than
-- silently overwriting the one a human is part-way through reviewing. That
-- second half is the reason it is not keyed on the ticket.
--
-- TWO BODIES, AND THAT IS THE MEASUREMENT. `body_text` is what the model wrote
-- and is never edited; `approved_body_text` is what a human decided to send
-- instead. The distance between them is the only honest read on drafting
-- quality — collapsing them into one column would make every draft look
-- perfect the moment somebody fixed it, which is precisely the number Phase 5
-- needs and the graduation of L1/L2 auto-send depends on.
--
-- WHAT IS DENORMALISED, AND WHY. `source_verdict` and `level` are copied off
-- the case file and the ticket as they stood WHEN THE DRAFT WAS WRITTEN. Both
-- can move afterwards — a re-investigation rewrites its row in place, and the
-- level ratchet only ever climbs — so reading them back through a join would
-- report the gate that applies now rather than the one that actually produced
-- this text.
--
-- PERSONAL DATA. The body is prose written for a customer, so it may carry the
-- customer's name and the state of their order; it may not carry an address, a
-- phone number or an identifier the tool layer withheld, because the drafting
-- prompt is narrower than the human brief on purpose. No recipient address is
-- stored here at all — the ticket already holds a hashed one, and a second,
-- plaintext copy on every draft is exactly the duplication
-- SHOPIFY_PERSONAL_DATA_PROTECTION.md exists to prevent.

create table public.ticket_drafts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- THE IDEMPOTENCY KEY. The inbound message this draft answers.
  trigger_message_id uuid not null references public.ticket_messages(id) on delete cascade,

  -- The case file this was written from. A draft with no case file is not a
  -- thing that can exist: the verdict decides what KIND of reply this is, and
  -- the established claims are the only facts the model is allowed to use.
  investigation_id uuid not null
    references public.ticket_investigations(id) on delete cascade,

  -- The verdict AS IT STOOD when this was drafted. All three appear, including
  -- `needs_human`: a ticket a person has to finish still owes the customer an
  -- acknowledgement, and writing one is the difference between silence and
  -- « nous avons bien reçu votre message ». What `needs_human` changes is not
  -- whether a reply is drafted but what the reply may DO — see `disposition`.
  source_verdict text not null,

  -- WHETHER SENDING THIS ENDS THE THREAD, and the reason this is a column rather
  -- than something the send path re-derives.
  --
  --   terminal      the exchange is finished: nothing is expected back from the
  --                 customer and nothing is left for a person to do. Sending it
  --                 is what closes the ticket.
  --   intermediary  something follows. Either the customer owes us an answer, or
  --                 a colleague owes them one. Sending it must NOT close
  --                 anything -- it moves the ticket to who is waited on.
  --
  -- DERIVED IN CODE FROM THE CASE FILE, never chosen by the model: it decides
  -- whether a thread closes, and « is this finished » is exactly the judgement a
  -- drafting model has the least evidence for. Stored rather than recomputed at
  -- send time so the decision travels with the text it was made about -- a
  -- re-investigation can move the verdict under an approved draft, and closing a
  -- ticket on a rule that no longer describes the reply a customer received is
  -- the one mistake here that cannot be taken back.
  disposition text not null,

  -- The level gate that applied, and the language the reply is written in.
  level smallint,
  language text,

  subject text,
  -- What the model wrote. Never edited in place.
  body_text text not null,
  -- What a human decided to send instead, when they changed it.
  approved_body_text text,

  -- The human lifecycle. Independent of `checks_passed` below, which is a
  -- machine outcome — a draft can be mechanically clean and still rejected, and
  -- a person may edit one precisely because a check caught something.
  status text not null default 'pending',

  -- The mechanical post-checks: prohibitions from the case file's do_not_claim,
  -- identifiers the tool layer withheld, the reply language, the signature.
  -- One entry per check, each carrying what it looked for and what it found.
  --
  -- IN CODE, NOT IN THE PROMPT. The plan is explicit that a prohibition living
  -- only as a string in a prompt is the weakest guardrail in this codebase, so
  -- the result of checking it mechanically is recorded beside the text it
  -- checked rather than trusted to have been obeyed.
  checks jsonb not null default '[]'::jsonb,
  -- Every check passed. Stored rather than derived at read time so a reader can
  -- filter on it, and so a change to how a check is judged cannot silently
  -- re-score drafts a human already approved.
  checks_passed boolean not null default false,

  -- Whether the level gate WOULD have auto-sent this, had DRAFT_ONLY been off.
  -- Recorded from the first draft onwards while nothing auto-sends, because
  -- "how often would L1 have been right" is the question the graduation of
  -- auto-send turns on, and it cannot be answered retrospectively.
  auto_send_eligible boolean not null default false,

  -- What went into the prompt: which knowledge chunks cleared the answerable
  -- band, which exemplar matched, whether an order bundle was rendered. The
  -- draft is prose and gives no account of itself; this is what makes "why did
  -- it say that" answerable without re-running the pass.
  prompt_inputs jsonb not null default '{}'::jsonb,

  model text,
  drafted_at timestamptz not null default now(),
  -- When a review copy of this draft was mailed to the reviewer's own inbox.
  -- The review channel is deliberately separate from the support mailbox and
  -- never addresses the customer; this column is what stops one draft being
  -- mailed twice.
  review_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (shop_id, trigger_message_id),

  constraint ticket_drafts_source_verdict_check check (
    source_verdict in ('answerable', 'needs_customer_input', 'needs_human')
  ),
  constraint ticket_drafts_disposition_check check (
    disposition in ('terminal', 'intermediary')
  ),
  -- A reply that could not resolve anything cannot be the end of the exchange.
  -- The two columns are derived from the same case file, so this can only fail
  -- if the derivation is changed carelessly -- which is precisely when a ticket
  -- would start auto-closing on an acknowledgement.
  constraint ticket_drafts_human_is_intermediary_check check (
    source_verdict <> 'needs_human' or disposition = 'intermediary'
  ),
  -- Same argument from the other side: a question is waiting on an answer.
  constraint ticket_drafts_question_is_intermediary_check check (
    source_verdict <> 'needs_customer_input' or disposition = 'intermediary'
  ),
  constraint ticket_drafts_status_check check (
    status in ('pending', 'approved', 'edited', 'rejected', 'sent')
  ),
  -- Level 4 is never drafted: `allowedTools` hands it an empty registry and the
  -- ticket reaches a person untouched. A level 4 draft row would mean that rule
  -- had been bypassed somewhere upstream.
  constraint ticket_drafts_level_check check (level is null or level between 1 and 3),
  -- The same list as tickets.language, mirrored from support-taxonomy.mjs and
  -- held in step by the migration test.
  constraint ticket_drafts_language_check check (
    language is null or language in ('fr', 'en', 'es', 'de', 'it', 'nl', 'pt', 'other')
  ),
  constraint ticket_drafts_body_text_check check (btrim(body_text) <> ''),
  -- `edited` is the status that asserts a human rewrote it, so the rewrite has
  -- to be there. Without this the two bodies could disagree with the status and
  -- the quality measurement above would be reading a column nobody filled in.
  constraint ticket_drafts_edited_has_body_check check (
    status <> 'edited' or btrim(coalesce(approved_body_text, '')) <> ''
  ),
  constraint ticket_drafts_checks_array_check check (
    jsonb_typeof(checks) = 'array'
  ),
  constraint ticket_drafts_prompt_inputs_object_check check (
    jsonb_typeof(prompt_inputs) = 'object'
  )
);

create index ticket_drafts_ticket_idx on public.ticket_drafts (ticket_id);

-- The review queue: what is waiting on a person, newest first.
create index ticket_drafts_shop_status_idx on public.ticket_drafts (shop_id, status, drafted_at desc);

create index ticket_drafts_investigation_idx on public.ticket_drafts (investigation_id);

-- What the review-mail pass claims: drafted, not yet mailed to the reviewer.
create index ticket_drafts_shop_review_pending_idx
  on public.ticket_drafts (shop_id, drafted_at)
  where review_sent_at is null;

create trigger ticket_drafts_set_updated_at
before update on public.ticket_drafts
for each row
execute function public.set_updated_at();

alter table public.ticket_drafts enable row level security;

comment on table public.ticket_drafts is
  'One customer-facing reply per investigated inbound message: what the agent would send, the mechanical checks it passed, and the human decision about it. Holds no recipient and cannot send. unique(shop_id, trigger_message_id) makes the pass safe to re-run and keeps a thread''s successive readings as separate drafts.';

comment on column public.ticket_drafts.trigger_message_id is
  'THE IDEMPOTENCY KEY. The inbound message this draft answers. Per message rather than per ticket, so a customer reply produces a new draft instead of overwriting one a human is reviewing.';

comment on column public.ticket_drafts.investigation_id is
  'The case file this was written from. Not nullable: the verdict decides what kind of reply this is, and the established claims are the only facts the model may use.';

comment on column public.ticket_drafts.source_verdict is
  'The case file''s verdict as it stood when this was drafted: answerable (a reply), needs_customer_input (the question) or needs_human (an acknowledgement). A ticket a person has to finish still owes the customer a reply; what the verdict decides is what that reply may do, not whether it exists.';

comment on column public.ticket_drafts.disposition is
  'Whether sending this ends the thread. terminal = nothing expected back and nothing left to do, so the send is what closes the ticket; intermediary = the customer owes us an answer or a colleague owes them one, so sending moves the ticket to whoever is waited on and closes nothing. Derived in code from the verdict and the case file''s handoff -- never chosen by the model -- and stored so the decision travels with the text it was made about.';

comment on column public.ticket_drafts.body_text is
  'What the MODEL wrote, never edited in place. A human''s rewrite goes to approved_body_text, so the distance between the two stays readable as the drafting quality measure.';

comment on column public.ticket_drafts.approved_body_text is
  'What a human decided to send instead. Null while a draft is untouched or was approved as written; required when status is edited.';

comment on column public.ticket_drafts.status is
  'The human decision: pending | approved | edited | rejected | sent. Independent of checks_passed, which is a machine outcome. Nothing writes `sent` today -- there is no send path, and this table cannot address a customer.';

comment on column public.ticket_drafts.checks is
  'One entry per mechanical post-check run against the body: the prohibitions in the case file''s do_not_claim, identifiers the tool layer withheld, the reply language, the signature. Recorded rather than trusted, because a prohibition that lives only in a prompt is the weakest guardrail in this codebase.';

comment on column public.ticket_drafts.auto_send_eligible is
  'Whether the level gate would have auto-sent this had DRAFT_ONLY been off. Recorded from the start while nothing auto-sends, because how often L1/L2 would have been right is the question graduating auto-send turns on, and it cannot be answered retrospectively.';

comment on column public.ticket_drafts.prompt_inputs is
  'What went into the prompt: the knowledge chunks that cleared the answerable band, the matched exemplar, whether an order bundle was rendered. Makes "why did it say that" answerable without re-running the pass.';

comment on column public.ticket_drafts.review_sent_at is
  'When a review copy was mailed to the reviewer''s own inbox. The review channel never addresses the customer and is disjoint from the support mailbox; this column is what stops one draft being mailed twice.';

-- ---------------------------------------------------------------- ticket_draft_edits

-- ============================================================================
-- ticket_draft_edits -- what a person changed, and what they changed it from
-- ============================================================================
--
-- ONE ROW PER EDIT, APPEND-ONLY. `ticket_drafts` already holds the current
-- pair -- `body_text` as the model wrote it, `approved_body_text` as a person
-- rewrote it -- and that pair is what the review surface needs. It is NOT what
-- a learning signal needs, for one specific reason:
--
--   A RE-DRAFT REPLACES `body_text` AND LEAVES `approved_body_text` ALONE.
--   That is deliberate (an operator's rewrite must survive the worker running),
--   and it means the two columns drift apart the moment the agent revises a
--   draft somebody had already edited. Read later, they look like a pair. They
--   are the agent's second attempt beside a human's correction of the first --
--   a pair that never existed, which is the worst possible thing to train on.
--
-- So the edit is recorded at the moment it happens, with the model text it was
-- an edit OF copied in beside it. That snapshot is the whole point of the
-- table; without it this would be a slower way of reading two columns.
--
-- APPEND-ONLY ALSO MEANS EVERY PASS IS KEPT. A reviewer who edits, sends,
-- and edits again on the next inbound message leaves two rows, and the
-- trajectory is the interesting part -- "what do people keep changing" is a
-- question about repetition, not about the latest state.
--
-- NOTHING READS THIS YET. Phase 7 memory is where it is consumed; capture has
-- to start first, because an edit not recorded when it happened cannot be
-- recovered afterwards. Same argument as `auto_send_eligible`.
--
-- PERSONAL DATA. Both columns are customer-facing prose and inherit the
-- drafting projection's scope: a name and an order state may appear, an address
-- or a withheld identifier may not. A compliance delete of the ticket cascades
-- through `ticket_drafts`.

create table public.ticket_draft_edits (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  draft_id uuid not null references public.ticket_drafts(id) on delete cascade,

  -- THE SNAPSHOT. What the agent had written at the moment this edit was made,
  -- copied rather than referenced, because the column it came from is rewritten
  -- by the next drafting run.
  model_body_text text not null,
  -- What the person saved instead.
  human_body_text text not null,

  -- WHERE THE EDIT WAS MADE. `dashboard` is the only writer today; `mailbox` is
  -- declared because editing a review copy in Outlook and having that come back
  -- is the intended second source, and a value added later would otherwise be a
  -- constraint change on a populated table.
  source text not null default 'dashboard',

  -- WHO. Null on every row, and it will stay null until the dashboard has
  -- authentication -- there is no user identity to attribute an action to yet
  -- (see AGENT_INTEGRATION_PLAN.md, Phase 6). Declared now because a learning
  -- signal that cannot tell two reviewers apart is a weaker signal, and adding
  -- the column later is an alteration this avoids.
  edited_by text,

  edited_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint ticket_draft_edits_source_check check (
    source in ('dashboard', 'mailbox')
  ),
  -- An edit that changed nothing is not an edit. It would also be the most
  -- misleading kind of training row: a pair implying the agent's text needed
  -- correcting into itself.
  constraint ticket_draft_edits_changed_check check (
    btrim(human_body_text) <> '' and btrim(human_body_text) <> btrim(model_body_text)
  )
);

create index ticket_draft_edits_draft_idx on public.ticket_draft_edits (draft_id);

create index ticket_draft_edits_ticket_idx on public.ticket_draft_edits (ticket_id);

-- The learning read: every edit for this shop, newest first.
create index ticket_draft_edits_shop_edited_idx
  on public.ticket_draft_edits (shop_id, edited_at desc);

alter table public.ticket_draft_edits enable row level security;

comment on table public.ticket_draft_edits is
  'Append-only record of every human rewrite of a drafted reply, each carrying the model text it was an edit OF. The snapshot is the point: ticket_drafts.body_text is replaced by the next drafting run while approved_body_text is deliberately kept, so those two columns stop being a pair the moment a draft is re-run. Capture for Phase 7 memory; nothing reads it yet.';

comment on column public.ticket_draft_edits.model_body_text is
  'What the agent had written when this edit was made, COPIED rather than referenced -- the column it came from is rewritten by the next drafting run.';

comment on column public.ticket_draft_edits.source is
  'Where the edit was made: dashboard (the only writer today) or mailbox (editing a review copy in Outlook, the intended second source). Declared now so adding it is not a constraint change on a populated table.';

comment on column public.ticket_draft_edits.edited_by is
  'Who made the edit. Null on every row until the dashboard has authentication -- there is no user identity to attribute an action to yet.';
