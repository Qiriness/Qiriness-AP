-- ============================================================================
-- 47 — OUTBOUND ACTIONS: THE ONE WAY A REPLY LEAVES
--
-- `outbound_actions`, with one live or sent action per (shop_id, ticket_id,
-- case_version, action_type), and the new comment on `ticket_drafts.status`
-- now that `sent` has a writer.
--
-- NO DATA IS WRITTEN. COPIED FROM 07_drafting.sql (47_outbound_actions.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 04_support.sql, 07_drafting.sql, 45_draft_versions.sql.
-- ============================================================================

-- ---------------------------------------------------------------- outbound_actions

-- ============================================================================
-- outbound_actions -- a reply we have decided to send, and how far it got
-- ============================================================================
--
-- THE ONLY WAY A REPLY LEAVES. A person approving a draft (or, once DRAFT_ONLY
-- is off, the level gate) creates one row; the outbound worker
-- (agent/src/outbound/outbound-runner.mjs) is the only code that turns a row
-- into mail. The model never sends: it writes ticket_drafts, which cannot.
--
-- IDEMPOTENCY: one live or sent action per (shop_id, ticket_id, case_version,
-- action_type) -- a unique index that ignores cancelled and failed rows. One
-- reply per case version: approving twice, a retried request, or two
-- dashboards clicking at once all hit the key instead of producing a second
-- email. A cancelled or failed action no longer holds the version, so a person
-- can edit and approve again, or retry after a provider refusal.
--
-- THE STATES SEPARATE WHAT WE ASKED FOR FROM WHAT WE KNOW.
--   approved        decided, nothing done at the provider yet
--   draft_created   the reply exists as a draft in the mailbox (provider_draft_id)
--   send_requested  the send call was made, or was about to be. Written BEFORE
--                   the call, so a crash between the two leaves a row that
--                   says "maybe sent" rather than one that says "not sent"
--   sent_confirmed  the sent message was read back from Sent Items by ingestion
--   cancelled       a pre-send check refused (cancel_reason)
--   failed          the provider refused for good, or retries ran out
-- A row in send_requested is never re-sent blind: the worker first asks the
-- mailbox whether that draft is still a draft.
--
-- NO RECIPIENT IS STORED. The reply goes to the sender of the message it
-- answers (`reply_to_message_id` -> ticket_messages.from_email), which for a
-- contact form is already the address from the form, not Shopify's.
create table if not exists public.outbound_actions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  draft_id uuid not null references public.ticket_drafts(id) on delete cascade,

  -- The case version the approved text was written against. With the ticket
  -- and the action type, the key.
  case_version integer not null,
  action_type text not null default 'reply',
  -- human_approved: a person approved or edited it. auto_send: the level gate,
  -- only ever with DRAFT_ONLY off.
  mode text not null,
  -- Who asked: the dashboard user's id, or 'agent'. Never a name or an address.
  requested_by text,

  -- The customer message being answered; the reply is threaded under it.
  reply_to_message_id uuid not null references public.ticket_messages(id) on delete cascade,
  -- The text as approved, copied: the draft's own columns can still move.
  body_text text not null,

  state text not null default 'approved',
  cancel_reason text,
  failure_reason text,

  -- Which provider holds the draft, and its ids there.
  provider text not null default 'outlook',
  provider_draft_id text,
  provider_internet_message_id text,
  -- The ticket_messages row ingestion stored for the sent mail.
  sent_message_id uuid references public.ticket_messages(id) on delete set null,

  draft_created_at timestamptz,
  send_requested_at timestamptz,
  confirmed_at timestamptz,
  closed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint outbound_actions_action_type_check check (action_type in ('reply')),
  constraint outbound_actions_mode_check check (mode in ('human_approved', 'auto_send')),
  constraint outbound_actions_state_check check (
    state in ('approved', 'draft_created', 'send_requested', 'sent_confirmed', 'cancelled', 'failed')
  ),
  constraint outbound_actions_cancel_reason_check check ((state = 'cancelled') = (cancel_reason is not null)),
  constraint outbound_actions_case_version_check check (case_version >= 1),
  constraint outbound_actions_body_check check (btrim(body_text) <> ''),
  constraint outbound_actions_provider_check check (provider in ('outlook'))
);

create unique index if not exists outbound_actions_idempotency_key
  on public.outbound_actions (shop_id, ticket_id, case_version, action_type)
  where state not in ('cancelled', 'failed');

create index if not exists outbound_actions_state_idx on public.outbound_actions (shop_id, state);

create index if not exists outbound_actions_ticket_idx on public.outbound_actions (ticket_id, created_at);

-- What ingestion's confirmation step matches a stored Sent Items message on.
create index if not exists outbound_actions_provider_draft_idx on public.outbound_actions (shop_id, provider_draft_id);

create index if not exists outbound_actions_internet_message_idx
  on public.outbound_actions (shop_id, provider_internet_message_id);

drop trigger if exists outbound_actions_set_updated_at on public.outbound_actions;
create trigger outbound_actions_set_updated_at
before update on public.outbound_actions
for each row
execute function public.set_updated_at();

alter table public.outbound_actions enable row level security;

comment on table public.outbound_actions is
  'A reply we decided to send and how far it got: approved -> draft_created -> send_requested -> sent_confirmed, or cancelled / failed. The unique index on (shop_id, ticket_id, case_version, action_type) over rows not cancelled or failed is what stops a second email for one case version. Carried out only by agent/src/outbound/outbound-runner.mjs; written only by scripts/lib/outbound-record.mjs. Holds no recipient.';

comment on column public.outbound_actions.state is
  'approved | draft_created | send_requested | sent_confirmed | cancelled | failed. send_requested is written BEFORE the send call and means "maybe sent": the worker asks the mailbox before any retry. sent_confirmed only once ingestion has stored the sent mail.';

comment on column public.outbound_actions.cancel_reason is
  'Which pre-send check refused: case_moved, customer_wrote_again, already_answered, draft_withdrawn, auto_send_off. Present exactly when state is cancelled.';

comment on column public.outbound_actions.reply_to_message_id is
  'The customer message this reply answers. The recipient is its from_email, read at send time; no address is stored here.';

comment on column public.outbound_actions.provider_draft_id is
  'The provider''s id for the reply draft. With immutable ids it survives the move to Sent Items, so ingestion''s stored graph_message_id matches it exactly.';

comment on column public.ticket_drafts.status is
  'The human decision: pending | approved | edited | rejected | sent, plus stale (set by the fold when the case moved on; see stale_reason). Independent of checks_passed, which is a machine outcome. `sent` is written only once the outbound worker has read the reply back from Sent Items (outbound_actions.sent_confirmed); this table still cannot address a customer.';
