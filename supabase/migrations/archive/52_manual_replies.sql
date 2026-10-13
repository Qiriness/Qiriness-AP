-- ============================================================================
-- 52 — A PERSON'S OWN REPLY, AND REPLIES AS HTML
--
-- `outbound_actions` accepts a reply a person wrote on the ticket page:
-- mode `manual`, action_type `manual_reply`, no draft, keyed on `client_key`
-- rather than on the case version (a person may add twice to one version).
-- Every action gains `body_html`, the sanitised HTML that is sent, and
-- `ticket_drafts` gains `approved_body_html` for a formatted rewrite.
--
-- The case-version key is narrowed to `reply`, which every existing row is:
-- it keeps exactly the rows it kept. NO DATA IS WRITTEN.
-- COPIED FROM 07_drafting.sql (52_manual_replies.test.mjs asserts the two
-- agree). IDEMPOTENT.
--
-- Requires: 07_drafting.sql, 47_outbound_actions.sql.
-- ============================================================================

alter table public.ticket_drafts
  add column if not exists approved_body_html text;

alter table public.outbound_actions
  add column if not exists client_key uuid,
  add column if not exists body_html text;

alter table public.outbound_actions alter column draft_id drop not null;

alter table public.outbound_actions drop constraint if exists outbound_actions_action_type_check;
alter table public.outbound_actions drop constraint if exists outbound_actions_mode_check;
alter table public.outbound_actions drop constraint if exists outbound_actions_manual_shape_check;

alter table public.outbound_actions
  add constraint outbound_actions_action_type_check check (action_type in ('reply', 'manual_reply')),
  add constraint outbound_actions_mode_check check (mode in ('human_approved', 'auto_send', 'manual')),
  add constraint outbound_actions_manual_shape_check check (
    (mode = 'manual') = (action_type = 'manual_reply')
    and (mode = 'manual') = (draft_id is null)
    and (mode = 'manual') = (client_key is not null)
  );

drop index if exists public.outbound_actions_idempotency_key;
create unique index if not exists outbound_actions_idempotency_key
  on public.outbound_actions (shop_id, ticket_id, case_version, action_type)
  where state not in ('cancelled', 'failed') and action_type = 'reply';

create unique index if not exists outbound_actions_client_key on public.outbound_actions (shop_id, client_key);

comment on column public.ticket_drafts.approved_body_html is
  'The reviewer''s rewrite as the reply HTML the editor produced (bold, italics, underline, lists, links), sanitised by scripts/lib/reply-html.mjs. approved_body_text holds its plain text, which is what the edit log and every reader compare. Null when the rewrite was plain text or there is none.';

comment on column public.outbound_actions.mode is
  'human_approved (a person approved or edited a draft) | auto_send (the level gate, only with DRAFT_ONLY off) | manual (a person wrote the reply on the ticket page; no draft, action_type manual_reply, keyed on client_key).';

comment on column public.outbound_actions.client_key is
  'A manual reply''s idempotency key, minted by the dashboard composer once per reply, so a double click or a retried request is one email. Present exactly on manual rows, which the case-version index leaves out.';

comment on column public.outbound_actions.body_html is
  'What is sent: the reply as HTML, sanitised by scripts/lib/reply-html.mjs (paragraphs, bold, italics, underline, lists, https/mailto links; no attributes but href). body_text is its plain text. Null only on rows written before the column, which are sent from body_text.';
