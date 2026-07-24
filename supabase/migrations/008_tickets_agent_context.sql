-- Agent-workflow additions to the ticketing tables from 007_tickets.sql:
--   * resolved_context: the order/customer bundle the order-context resolver
--     assembles once shopify_order_number is set, handed to the drafting agent
--     so it does not query fields one-by-one (see AGENT_INTEGRATION_PLAN.md).
--   * secondary_category: a second topic when one email spans two.
--   * priority + retention lifecycle (archival then deletion of old tickets).
--   * ticket_messages embeddings: semantic vectors of the email body for
--     similar-ticket retrieval, reusing the knowledge_chunks vector pattern
--     (migration 006). Cheap at support-email volume, so applied broadly.
--
-- Split from 007 because 007 was already applied to the dev database before
-- these columns existed; keeping each migration equal to what actually ran
-- avoids the edit-after-apply drift that 003/005 had to reconcile.

alter table public.tickets
  add column secondary_category text,
  add column priority smallint not null default 3,
  add column resolved_context jsonb not null default '{}'::jsonb,
  add column context_resolved_at timestamptz,
  add column resolved_at timestamptz,
  add column closed_at timestamptz,
  add column archived_at timestamptz,
  add column retention_delete_after timestamptz,
  add constraint tickets_priority_check check (priority between 1 and 5),
  add constraint tickets_resolved_context_object_check check (
    jsonb_typeof(resolved_context) = 'object'
  );

create index tickets_shop_secondary_category_idx on public.tickets (shop_id, secondary_category);
create index tickets_shop_priority_idx on public.tickets (shop_id, priority);
create index tickets_shop_archived_at_idx on public.tickets (shop_id, archived_at);
create index tickets_retention_delete_after_idx on public.tickets (shop_id, retention_delete_after);

alter table public.ticket_messages
  add column embedding vector(1536),
  add column embedding_model text,
  add column embedding_dimensions integer,
  add column embedded_input_hash text,
  add column embedded_at timestamptz;

create index ticket_messages_embedding_hnsw_idx on public.ticket_messages using hnsw (embedding vector_cosine_ops);

comment on column public.tickets.secondary_category is
  'Optional second category when one email spans two topics (e.g. order status plus product advice for a future purchase). Same free-form values as category.';

comment on column public.tickets.priority is
  'Queue priority 1 (highest) to 5 (lowest), set by the prioritiser from RFM group, level, and age. Defaults to 3 (normal) so the queue sorts before prioritisation runs.';

comment on column public.tickets.resolved_context is
  'Order/customer context bundle the order-context resolver assembles from the synced orders/customers rows once shopify_order_number is set (tracking, order name, order-customer name, RFM group, etc.), handed to the drafting agent so it does not query fields individually. A re-resolvable snapshot, not a source of truth and not a duplicate of first-class order columns; may be edited for human-in-the-loop review. Holds personal data, so it must be scoped, kept out of prompts unless strictly required, and redacted on compliance requests. Excludes billing/street address (never synced; gated live Shopify lookup only).';

comment on column public.tickets.context_resolved_at is
  'When resolved_context was last assembled. Lets the worker re-resolve stale context rather than trusting the snapshot as source of truth.';

comment on column public.tickets.resolved_at is
  'When the ticket moved to resolved. Retention anchor for how long resolved tickets are kept.';

comment on column public.tickets.closed_at is
  'When the ticket was closed. Retention anchor for archival and eventual deletion.';

comment on column public.tickets.archived_at is
  'When the ticket was archived out of the active queue while still retained. Set by the archival job for old tickets; distinct from deleted_at.';

comment on column public.tickets.retention_delete_after is
  'Timestamp after which the ticket may be hard-deleted by the retention cleanup job. Durations are policy-driven and set later; the column is the mechanism, not a fixed rule.';

comment on column public.tickets.deleted_at is
  'Soft-delete / compliance-redaction flag. Distinct from archived_at (archival keeps the ticket; deletion removes it, e.g. on a customer redact request).';

comment on column public.ticket_messages.embedding is
  'pgvector(1536) embedding of the email body (text-embedding-3-small) for similar-ticket retrieval and clustering, populated primarily for inbound messages. Matches the knowledge_chunks embedding pipeline; a row holds a vector iff embedded_input_hash/model/dimensions match the current input and model.';

comment on column public.ticket_messages.embedded_input_hash is
  'Hash of the embedded input (body text + relevant metadata) so a reconciler can detect stale vectors and re-embed on model or content changes, mirroring knowledge_chunks determinism metadata.';
