-- ============================================================================
-- 25 — A RULE MAY OFFER A LINK, AND A DRAFT KEEPS THE ONE IT WAS WRITTEN ABOUT
--
-- WHAT THIS CHANGES. `support_answers` gains `link_url` and `link_label`: an
-- https page the rule's reply offers, and what it opens. The drafting model is
-- given only the label and writes a `[[ici]]` marker; `ticket_drafts` gains
-- `reply_link`, the `{ url, label }` copied at drafting time, which the
-- dashboard puts on the marked word. See scripts/lib/reply-link.mjs.
--
-- COPIED FROM 05_exemplars.sql AND 07_drafting.sql, NOT RETYPED, and
-- 25_rule_links.test.mjs holds the checks and comments equal.
--
-- NO RULE OR DRAFT CHANGES. Every column arrives null.
--
-- IDEMPOTENT: `add column if not exists`, constraints dropped and re-added —
-- a no-op on a fresh baseline.
--
-- Requires: 05_exemplars.sql, 07_drafting.sql.
-- ============================================================================

alter table public.support_answers
  add column if not exists link_url text,
  add column if not exists link_label text;

alter table public.support_answers drop constraint if exists support_answers_link_url_check;
alter table public.support_answers drop constraint if exists support_answers_link_pair_check;

alter table public.support_answers
  add constraint support_answers_link_url_check check (
    link_url is null or link_url ~ '^https://[^[:space:]]+$'
  ),
  add constraint support_answers_link_pair_check check (
    (link_url is null) = (link_label is null)
    and (link_label is null or length(btrim(link_label)) between 1 and 120)
  );

comment on column public.support_answers.link_url is
  'An https page this rule''s reply offers the customer, or null. Never shown to the drafting model: it is given link_label and writes a [[marker]], and code puts this address on the marked word wherever the draft is shown, so no_web_link still holds. Copied onto ticket_drafts.reply_link at drafting time, so editing the rule never re-points a draft already written.';

comment on column public.support_answers.link_label is
  'What link_url opens, in the words the reply uses (« le guide d''utilisation »). Present exactly when link_url is.';

alter table public.ticket_drafts
  add column if not exists reply_link jsonb;

alter table public.ticket_drafts drop constraint if exists ticket_drafts_reply_link_object_check;

alter table public.ticket_drafts
  add constraint ticket_drafts_reply_link_object_check check (
    reply_link is null or jsonb_typeof(reply_link) = 'object'
  );
