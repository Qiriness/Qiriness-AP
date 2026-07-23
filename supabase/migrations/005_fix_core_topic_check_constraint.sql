-- 003_knowledge_page_catalog.sql was edited after being applied: it now defines
-- knowledge_documents_core_topic_check with the combined 'delivery_returns' slot
-- (6 slots total), but that ALTER was never re-run against the live database —
-- the live constraint still had the earlier 7-slot version with separate
-- 'delivery' and 'returns_exchanges' values. The app (web/lib/types.ts CoreTopic)
-- only ever sends 'delivery_returns', so saving an article into that core-topic
-- slot failed with a check constraint violation. No existing row used the old
-- 'delivery'/'returns_exchanges' values (confirmed before writing this), so no
-- data backfill is needed — this only recreates the constraint to match what
-- 003 already documents.

alter table public.knowledge_documents
  drop constraint knowledge_documents_core_topic_check,
  add constraint knowledge_documents_core_topic_check check (
    core_topic is null or core_topic in (
      'order_policies',
      'brand',
      'confidentiality',
      'delivery_returns',
      'locations',
      'faqs'
    )
  );
