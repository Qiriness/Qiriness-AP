-- ============================================================================
-- 02 — SPAM FILTER
-- The two-pass ingestion gate and its audit trail. Runs after 01_core_schema.sql
-- (spam_audit references shops) and before 03_categorisation.sql.
--
-- Both passes drop mail BEFORE anything is written to tickets/ticket_messages,
-- so blocked spam never consumes storage:
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

-- One row per decision the gate actually made.
--
-- Why this table exists: because both passes drop mail before any write, a
-- blocked email would otherwise leave no trace at all, making a wrong drop
-- invisible and unreviewable. This table is that trace.
--
-- Personal-data note: this stores the sender address and subject line, a narrow
-- and deliberate exception to "blocked spam is not stored". They are the minimum
-- needed to judge whether a decision was right and to turn a repeat offender
-- into a blocklist rule. The message body is never stored here. Treat this as
-- decision metadata (like integration_events), not as retained mail.
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

create index email_blocklist_shop_pattern_idx on public.email_blocklist (shop_id, pattern_type, pattern);

-- Review queries are "what did the gate decide lately" and "show me the blocks".
create index spam_audit_shop_decided_at_idx on public.spam_audit (shop_id, decided_at desc);
create index spam_audit_shop_outcome_idx on public.spam_audit (shop_id, outcome, decided_at desc);

create trigger email_blocklist_set_updated_at
before update on public.email_blocklist
for each row
execute function public.set_updated_at();

create trigger spam_audit_set_updated_at
before update on public.spam_audit
for each row
execute function public.set_updated_at();

alter table public.email_blocklist enable row level security;
alter table public.spam_audit enable row level security;

comment on table public.email_blocklist is
  'Deterministic sender blocklist for the agent email workflow. Matched senders are dropped at ingestion before any ticket/message is stored, so blocked spam never consumes storage. Service-role worker only until dashboard roles and policies exist.';

comment on column public.email_blocklist.pattern_type is
  'email (exact sender address) or domain (sender domain, e.g. spammer.example). Patterns are stored normalised (trimmed, lowercased; domain without a leading @).';

comment on column public.email_blocklist.pattern is
  'The normalised sender email or domain to block. Matched case-insensitively against the inbound sender at ingestion.';

comment on column public.email_blocklist.hit_count is
  'Number of inbound messages this rule has blocked. Bumped by the ingestion worker; last_hit_at records the most recent block.';

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
