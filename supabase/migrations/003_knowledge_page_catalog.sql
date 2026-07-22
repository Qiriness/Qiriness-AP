-- Unified, lightweight Shopify content catalog (pages + shop policies) for the
-- Agent Setup knowledge dropdown, plus the knowledge_documents columns needed
-- for the curated article workflow: HTML editing, agent-approval status, and
-- core-topic slots. Nothing auto-syncs into knowledge_documents; a row is only
-- ever created there by an explicit import or a manually written article (see
-- web/app/api/knowledge/articles). Editing an imported article converts its
-- knowledge_documents.source_type to 'manual', which is what stops it from
-- syncing further — there is no separate "locally modified" flag.

create table public.shopify_content_sources (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text not null,
  handle text not null,
  title text not null,
  status text not null default 'unpublished',
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopify_content_sources_shop_source_unique unique (shop_id, source_type, shopify_source_id),
  constraint shopify_content_sources_source_type_check check (source_type in ('shopify_page', 'shopify_policy')),
  constraint shopify_content_sources_status_check check (status in ('published', 'unpublished'))
);

create index shopify_content_sources_shop_type_idx on public.shopify_content_sources (shop_id, source_type);

create trigger shopify_content_sources_set_updated_at
before update on public.shopify_content_sources
for each row
execute function public.set_updated_at();

alter table public.shopify_content_sources enable row level security;

comment on table public.shopify_content_sources is
  'Lightweight index of live Shopify Online Store pages and shop policies (refund, privacy, shipping, terms of service, etc.), used to populate the Agent Setup source dropdown. Holds identity only; content is resolved on demand at import/resync time and is not stored here.';

comment on column public.shopify_content_sources.source_type is
  'shopify_page or shopify_policy. Distinguishes which Shopify resource this row indexes, since pages and policies are fetched and resolved through different Shopify Admin API calls.';

comment on column public.shopify_content_sources.status is
  'Shopify publish state: published or unpublished. Policies are always published (Shopify has no draft state for a filled-in policy); pages derive this from publishedAt presence.';

alter table public.knowledge_documents
  add column content_html text,
  add column approval_status text not null default 'draft',
  add column core_topic text;

alter table public.knowledge_documents
  add constraint knowledge_documents_approval_status_check check (
    approval_status in ('draft', 'in_review', 'approved', 'needs_optimization')
  ),
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

create unique index knowledge_documents_shop_core_topic_unique
  on public.knowledge_documents (shop_id, core_topic)
  where core_topic is not null;

comment on column public.knowledge_documents.content_html is
  'Rich-text HTML as edited in the Agent Setup dashboard. Source of truth for the editor; content_text and sections are regenerated from this on every save, import, or resync.';

comment on column public.knowledge_documents.approval_status is
  'Team review state for agent usage: draft, in_review, approved, or needs_optimization. Independent of status, which holds the Shopify publish state for Shopify-sourced articles.';

comment on column public.knowledge_documents.core_topic is
  'Optional required-knowledge slot this article fulfills (order_policies, brand, confidentiality, delivery_returns, locations, faqs). At most one active article per shop per slot. Distinct from the free-form category column.';

comment on column public.knowledge_documents.source_type is
  'shopify_page, shopify_policy, or manual. Editing an imported article in the dashboard converts this to manual (shopify_source_id/handle are kept for provenance), which is what stops it from being resynced from Shopify going forward.';
