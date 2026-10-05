-- ============================================================================
-- 72 — A REFUND RECORDED IN SHOPIFY IS TOLD TO THE CUSTOMER
--
-- `support_answers.notify_on`: the event this rule is the template for, when
-- we write to the customer without being asked. Today one event,
-- `refund_recorded` -- a refund created in Shopify on a ticket in the rule's
-- answer set that no message of ours has reported yet. Null on every rule but
-- the one a shop marks, which is how a shop switches the notice on.
--
-- `ticket_drafts.purpose`: `reply` (every draft so far) or `refund_notice`. The
-- pre-send check reads it: a notice follows a reply of ours by design, so only
-- a message of ours written after the notice counts as « already answered ».
-- A notice is never auto-sent (outbound-record.mjs).
--
-- DECISIONS.md § Refund notice. NO DATA IS WRITTEN: every rule arrives with
-- null, every draft with 'reply'. COPIED FROM 05_exemplars.sql and
-- 07_drafting.sql (72_refund_notice.test.mjs asserts they agree). IDEMPOTENT.
--
-- Requires: 05_exemplars.sql, 07_drafting.sql.
-- ============================================================================

alter table public.support_answers
  add column if not exists notify_on text;

alter table public.support_answers drop constraint if exists support_answers_notify_on_check;

alter table public.support_answers
  add constraint support_answers_notify_on_check check (
    notify_on is null or notify_on in ('refund_recorded')
  );

comment on column public.support_answers.notify_on is
  'The event this rule is the template for when we write to the customer unasked: refund_recorded (a refund created in Shopify that no message of ours has reported, on a ticket in this rule''s answer set). Null on every other rule. The change router (agent/src/casework/change-router.mjs) detects the event; the drafting pass writes the notice with this rule''s skeleton, for a person to approve.';

alter table public.ticket_drafts
  add column if not exists purpose text not null default 'reply';

alter table public.ticket_drafts drop constraint if exists ticket_drafts_purpose_check;

alter table public.ticket_drafts
  add constraint ticket_drafts_purpose_check check (
    purpose in ('reply', 'refund_notice')
  );

comment on column public.ticket_drafts.purpose is
  'reply: an answer to the customer''s latest message. refund_notice: a message of our own telling them a refund was recorded (support_answers.notify_on). A notice is never auto-sent, and only a message of ours written after it counts as already answered.';
