-- ============================================================================
-- 58 — KNOWLEDGE ARTICLES ARE FAQS: NO `other` ARTICLE CATEGORY
--
-- With company policies read by key (55, 56), every knowledge article but a
-- brand story is an FAQ, shown as « Order FAQ », « Product FAQ » … and the
-- `faq` category as « General FAQ ». The ticket catch-all `other` is no longer
-- an article category: an article with no named subject is a General FAQ.
-- `other` stays a ticket subject (04_support.sql is untouched).
--
-- DATA: one update, moving any article still filed under `other` to `faq`
-- (none on 2026-10-01) and its chunks with it. COPIED FROM 03_knowledge.sql
-- (58_faq_articles.test.mjs asserts they agree). IDEMPOTENT.
--
-- Requires: 03_knowledge.sql.
-- ============================================================================

update public.knowledge_documents set category = 'faq' where category = 'other';
update public.knowledge_chunks set category = 'faq' where category = 'other';

alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_category_check;

alter table public.knowledge_documents
  add constraint knowledge_documents_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'faq', 'brand_story'
    )
  );

comment on column public.knowledge_documents.category is
  'Article subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs. Every article but a brand story is an FAQ, shown as « <subject> FAQ »: the ticket subjects except the catch-all other, plus the knowledge-only shapes faq (General FAQ) and brand_story. Tickets additionally carry a request_kind; an article is reference material and has no kind.';
