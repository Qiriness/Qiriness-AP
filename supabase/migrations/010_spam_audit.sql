-- Audit trail for the Phase 2 spam gate (see AGENT_INTEGRATION_PLAN.md): one row
-- per decision the gate actually made, recording whether the email was kept or
-- blocked, and a one-line reason.
--
-- Why this table exists: both spam passes drop mail *before* anything is written
-- to tickets/ticket_messages. That is deliberate (spam never consumes storage),
-- but it also means a blocked email otherwise leaves no trace at all, so a wrong
-- drop is invisible and unreviewable. This table is that trace.
--
-- Personal-data note: this stores the sender address and subject line, which is a
-- narrow, deliberate exception to "blocked spam is not stored". They are the
-- minimum needed to judge whether a decision was right and to turn a repeat
-- offender into an email_blocklist rule. The message body is never stored here,
-- and no ticket or ticket_messages row is created for dropped mail. Treat this as
-- decision metadata (like integration_events), not retained mail.
--
-- Scope: only decisions the gate actually made. Replies into an existing ticket
-- are never triaged (a genuine follow-up must not be discardable), so they
-- produce no row here -- absence means "no decision was made", not "kept".

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
