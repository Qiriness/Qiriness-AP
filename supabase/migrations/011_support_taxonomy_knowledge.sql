-- Finalises the support taxonomy on the knowledge side and constrains it.
--
-- 001 and 007 both left category as unrestricted text "until the support taxonomy
-- is finalised". It is now finalised (see scripts/lib/support-taxonomy.mjs): one
-- shared *subject* vocabulary for knowledge articles and ticket categorisation, so
-- a ticket categorised `delivery` filters straight into the `delivery` knowledge
-- chunks with no mapping table in between. Ticket-side columns land in 012.
--
-- Renames applied here (old -> new):
--   shipping_delivery   -> delivery
--   returns_refunds     -> return_exchange
--   product_information -> product
--   payments            -> payment
--   stock               -> product_stock
--   privacy             -> legal_privacy   (merged)
--   legal               -> legal_privacy   (merged)
--   b2b_partnerships    -> b2b
--   general             -> other
-- Unchanged: faq, brand_story. New with no predecessor: order, account,
-- cosmetovigilance, partner_collaboration, careers.
--
-- knowledge_chunks.category is denormalised from the parent document, so it is
-- renamed in step with it. Note this invalidates those chunks' embeddings:
-- embedded_input_hash covers the category, so the next `npm run embed:knowledge`
-- re-embeds the affected chunks (by design — see 006).

-- Documents ----------------------------------------------------------------
update public.knowledge_documents set category = 'delivery' where category = 'shipping_delivery';
update public.knowledge_documents set category = 'return_exchange' where category = 'returns_refunds';
update public.knowledge_documents set category = 'product' where category = 'product_information';
update public.knowledge_documents set category = 'payment' where category = 'payments';
update public.knowledge_documents set category = 'product_stock' where category = 'stock';
update public.knowledge_documents set category = 'legal_privacy' where category in ('privacy', 'legal');
update public.knowledge_documents set category = 'b2b' where category = 'b2b_partnerships';
-- NULL is left as NULL on purpose: an uncategorised article is a real state, and
-- the constraint below permits it. Only the old 'general' catch-all is renamed.
update public.knowledge_documents set category = 'other' where category = 'general';

-- Anything not in the final vocabulary becomes the catch-all rather than blocking
-- the constraint below. Keeps the migration safe against hand-edited rows.
update public.knowledge_documents
set category = 'other'
where category is not null
  and category not in (
    'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
    'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
    'partner_collaboration', 'careers', 'other', 'faq', 'brand_story'
  );

-- Chunks -------------------------------------------------------------------
update public.knowledge_chunks set category = 'delivery' where category = 'shipping_delivery';
update public.knowledge_chunks set category = 'return_exchange' where category = 'returns_refunds';
update public.knowledge_chunks set category = 'product' where category = 'product_information';
update public.knowledge_chunks set category = 'payment' where category = 'payments';
update public.knowledge_chunks set category = 'product_stock' where category = 'stock';
update public.knowledge_chunks set category = 'legal_privacy' where category in ('privacy', 'legal');
update public.knowledge_chunks set category = 'b2b' where category = 'b2b_partnerships';
update public.knowledge_chunks set category = 'other' where category = 'general';

-- Constraint ---------------------------------------------------------------
-- Nullable: an article can exist before a category is chosen. The check only
-- rejects values outside the finalised vocabulary.
alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_category_check,
  add constraint knowledge_documents_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other', 'faq', 'brand_story'
    )
  );

comment on column public.knowledge_documents.category is
  'Article subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs. The same 14 subjects the ticket categoriser assigns, plus the knowledge-only shapes faq and brand_story. Constrained since 011 (previously free text pending the taxonomy). Tickets additionally carry a request_kind; an article is reference material and has no kind.';

comment on column public.knowledge_chunks.category is
  'Denormalised copy of the parent knowledge_documents.category, kept in step with it. Included in embedded_input_hash, so a category change invalidates the chunk vector and the next embed run refreshes it.';
