-- Adds a structured "voice profile" column to knowledge_documents for the
-- singleton Brand Voice article (core_topic = 'brand'). That row now holds
-- always-included drafting-agent context (tone, voice description, do's and
-- don'ts) instead of a single freeform rich-text blob. content_html/
-- content_text/sections keep serving this row's "general context" field
-- (freeform guidance that applies to every email regardless of category)
-- exactly as they do for every other article — only voice_profile is new.
--
-- This content is never chunked into knowledge_chunks (see regenerateChunks
-- in web/lib/server/knowledge-service.ts, skipped when core_topic = 'brand'):
-- knowledge_chunks exists for similarity-search retrieval of category-specific
-- articles, not for context that must always be included in full.

alter table public.knowledge_documents
  add column voice_profile jsonb not null default '{}'::jsonb;

comment on column public.knowledge_documents.voice_profile is
  'Structured brand-voice fields for the singleton Brand Voice article (core_topic = ''brand''): { roleDescription: string, toneAndVoice: string }. Empty ({}) on every other article. Always-included drafting-agent context, distinct from content_html (used on this row for freeform general-context guidance) and from ordinary knowledge_documents rows, which are selectively retrieved via knowledge_chunks.';
