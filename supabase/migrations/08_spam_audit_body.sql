-- ============================================================================
-- 08 — SPAM AUDIT: THE BODY
-- Runs after 02_spam_filter.sql, which created spam_audit without a body.
--
-- WHAT THIS REVERSES, AND WHY.
--
-- 02 stored the sender and the subject and deliberately not the body, on the
-- reasoning that a decision record is metadata rather than retained mail. That
-- was right about what the table IS and wrong about what it is FOR. The gate's
-- output is reviewed by a human deciding one question — should this have become
-- a ticket? — and a subject line does not answer it. "Votre commande" is a
-- newsletter or a customer whose parcel is lost, and the reviewer cannot tell
-- which without the text. Measured against the corpus the classifier drops
-- automated notices, FYI forwards and genuine customer mail under subjects that
-- read identically, so the audit trail was reviewable in principle and not in
-- practice.
--
-- The alternative was re-fetching each body from Graph on demand, which keeps
-- the database clean and makes the dashboard depend on a live Graph call, an
-- application credential and a message still sitting in the Inbox. That is a
-- worse trade for a table whose entire purpose is being readable after the fact.
--
-- WHAT KEEPS THIS PROPORTIONATE. The body is stored under its own clock, not
-- the row's: `body_expires_at` is set when the text is captured, and the
-- worker's purge nulls `body_text` past it while leaving the decision row
-- standing for ever. So the reviewable window is bounded, the audit trail is
-- not, and the sensitive half disappears on a schedule rather than on somebody
-- remembering. See SHOPIFY_PERSONAL_DATA_PROTECTION.md — this is retained
-- personal data now, which the sender-and-subject exception was written to
-- avoid claiming.
-- ============================================================================

alter table public.spam_audit
  -- Cleaned plain text, the same `htmlToText` output ticket_messages stores, and
  -- capped in code. Never the raw HTML: the reviewer needs to read it, not to
  -- render it, and stored markup is a payload nobody in this path asked for.
  add column if not exists body_text text,
  -- Null means the body was never captured, which is a different state from
  -- captured-and-since-expired (body_text null, body_expires_at in the past) and
  -- from a genuinely empty email. The backfill reads this to know what is left.
  add column if not exists body_captured_at timestamptz,
  add column if not exists body_expires_at timestamptz;

-- The purge's own query: rows whose body has expired. Partial, because once the
-- text is gone the row is of no further interest to that pass and the index
-- should not carry it — on this table the vast majority of rows will be in that
-- state at any time.
create index if not exists spam_audit_body_expiry_idx
  on public.spam_audit (shop_id, body_expires_at)
  where body_text is not null;

comment on table public.spam_audit is
  'Audit trail for the agent ingestion spam gate: one row per decision, recording kept/blocked and a one-line reason. Exists because both passes drop mail before any ticket is written, so a blocked email would otherwise leave no trace. Stores sender address, subject AND the cleaned body (see 08) as the evidence a human needs to judge whether a drop was right. The body expires on its own clock (body_expires_at) and is nulled by the worker; the decision row is kept indefinitely. Service-role worker only until dashboard roles and policies exist.';

comment on column public.spam_audit.body_text is
  'Cleaned plain-text body of the dropped email, capped in code. THE REASON THE TABLE IS REVIEWABLE: a subject line cannot distinguish a newsletter from a customer whose parcel is lost, so without this a reviewer cannot judge the gate''s decision at all. Retained personal data with a bounded life -- nulled by the worker''s purge once body_expires_at passes, leaving the decision row intact. Null means never captured, or captured and since expired.';

comment on column public.spam_audit.body_captured_at is
  'When the body was written -- by ingestion at the moment of the decision, or later by the Graph backfill for rows that predate 08. Null on any row whose body was never captured.';

comment on column public.spam_audit.body_expires_at is
  'When body_text becomes purgeable. Set from body_captured_at plus the worker''s retention window (SPAM_AUDIT_BODY_RETENTION_DAYS, default 90). Deliberately separate from the row''s own life: the decision is audit metadata and is kept, the message text is personal data and is not.';
