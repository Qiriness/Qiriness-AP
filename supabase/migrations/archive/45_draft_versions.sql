-- ============================================================================
-- 45 — ONE DRAFT PER CASE VERSION, AND A DRAFT GOES STALE WHEN THE CASE MOVES
--
-- Stage 6 of codex_plans/Case_State_Plan.md. `ticket_drafts` gains
-- `case_version` (the key, with the ticket), `trigger_event_id` and
-- `stale_reason`; `stale` joins the status check. The old key
-- (shop_id, trigger_message_id) is dropped and kept as a plain index.
--
-- NO ROW CHANGES. Existing drafts keep a null case_version and their status.
-- COPIED FROM 07_drafting.sql (45_draft_versions.test.mjs asserts the two
-- agree). IDEMPOTENT.
--
-- Requires: 07_drafting.sql.
-- ============================================================================

alter table public.ticket_drafts
  add column if not exists case_version integer,
  add column if not exists trigger_event_id uuid references public.ticket_messages(id) on delete set null,
  add column if not exists stale_reason text;

alter table public.ticket_drafts drop constraint if exists ticket_drafts_shop_id_trigger_message_id_key;

-- The old key was declared without a name. Postgres names it as above; this
-- also drops it under any other name, found by its columns, so the new key
-- is never added beside a stale one.
do $$
declare
  old_key text;
begin
  for old_key in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.ticket_drafts'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(c.conkey) as k(attnum)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      ) = array['shop_id', 'trigger_message_id']
  loop
    execute format('alter table public.ticket_drafts drop constraint %I', old_key);
  end loop;
end
$$;

alter table public.ticket_drafts drop constraint if exists ticket_drafts_shop_ticket_version_key;
alter table public.ticket_drafts drop constraint if exists ticket_drafts_status_check;
alter table public.ticket_drafts drop constraint if exists ticket_drafts_stale_reason_check;
alter table public.ticket_drafts drop constraint if exists ticket_drafts_stale_has_reason_check;
alter table public.ticket_drafts drop constraint if exists ticket_drafts_case_version_check;

alter table public.ticket_drafts
  add constraint ticket_drafts_shop_ticket_version_key unique (shop_id, ticket_id, case_version),
  add constraint ticket_drafts_status_check check (
    status in ('pending', 'approved', 'edited', 'rejected', 'sent', 'stale')
  ),
  add constraint ticket_drafts_stale_reason_check check (
    stale_reason is null or stale_reason in ('case_changed', 'superseded_by_outbound')
  ),
  add constraint ticket_drafts_stale_has_reason_check check (
    (status = 'stale') = (stale_reason is not null)
  ),
  add constraint ticket_drafts_case_version_check check (
    case_version is null or case_version >= 1
  );

create index if not exists ticket_drafts_trigger_idx on public.ticket_drafts (shop_id, trigger_message_id);

comment on table public.ticket_drafts is
  'One customer-facing reply per case version: what the agent would send, the mechanical checks it passed, and the human decision about it. Holds no recipient and cannot send. unique(shop_id, ticket_id, case_version) makes the pass safe to re-run and gives a case that moved a new row, leaving the old one stale with what its reviewer saw.';

comment on column public.ticket_drafts.trigger_message_id is
  'The customer message this draft answers. No longer the key since stage 6: two case versions can answer the same message (Deret answered, nothing new from the customer).';

comment on column public.ticket_drafts.case_version is
  'The case_current.version this reply was written against; with the ticket, the key. Null only on rows written before stage 6. A fold that raises the version marks every pending, approved or edited draft of an older one stale.';

comment on column public.ticket_drafts.trigger_event_id is
  'The event that produced case_version: the newest message when the case was folded. The trigger message itself, or a partner''s answer or our Outlook reply when the case moved without the customer.';

comment on column public.ticket_drafts.stale_reason is
  'Why the draft went stale: case_changed (the case moved on) or superseded_by_outbound (we replied ourselves; no guess about whether it was this text). Present exactly when status is stale. A stale draft is never approved; the next version gets its own row.';

comment on column public.ticket_drafts.status is
  'The human decision: pending | approved | edited | rejected | sent, plus stale (set by the fold when the case moved on; see stale_reason). Independent of checks_passed, which is a machine outcome. Nothing writes `sent` today -- there is no send path, and this table cannot address a customer.';
