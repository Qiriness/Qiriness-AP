-- Initial Supabase schema for Shopify product context and shared metaobjects.
-- Shopify remains the source of truth; this database stores operational snapshots
-- for sync, dashboard, and AI context.

create extension if not exists pgcrypto;
create extension if not exists vector;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_valid_product_faqs(value jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(value) <> 'array' then false
    else not exists (
      select 1
      from jsonb_array_elements(value) as faq(item)
      where jsonb_typeof(faq.item) <> 'object'
        or not (faq.item ? 'faq_id')
        or not (faq.item ? 'question')
        or not (faq.item ? 'answer')
        or not (faq.item ? 'source')
        or not (faq.item ? 'content_hash')
        or not (faq.item ? 'updated_at')
        or not (faq.item ? 'published')
        or jsonb_typeof(faq.item -> 'source') <> 'object'
        or jsonb_typeof(faq.item -> 'published') <> 'boolean'
    )
  end;
$$;

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  shopify_shop_id text,
  shop_domain text not null,
  shop_name text,
  environment text not null default 'development',
  installed_at timestamptz,
  uninstalled_at timestamptz,
  access_scopes text[] not null default '{}',
  sync_cursors jsonb not null default '{}'::jsonb,
  app_settings jsonb not null default '{}'::jsonb,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shops_shop_domain_unique unique (shop_domain),
  constraint shops_environment_check check (
    environment in ('development', 'staging', 'production')
  ),
  constraint shops_sync_cursors_object_check check (
    jsonb_typeof(sync_cursors) = 'object'
  ),
  constraint shops_app_settings_object_check check (
    jsonb_typeof(app_settings) = 'object'
  ),
  constraint shops_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_product_id text not null,
  handle text,
  title text not null,
  status text,
  vendor text,
  product_type text,
  tags text[] not null default '{}',
  description text,
  short_description text,
  usage_instructions text,
  usage_advice text,
  active_ingredients text,
  ingredients_popup text,
  product_ingredients jsonb not null default '[]'::jsonb,
  product_ingredient_metaobject_ids text[] not null default '{}',
  product_faqs jsonb not null default '[]'::jsonb,
  product_faq_metaobject_ids text[] not null default '{}',
  available_stock integer,
  structured_facts jsonb not null default '{}'::jsonb,
  variants jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint products_shopify_product_unique unique (shop_id, shopify_product_id),
  constraint products_status_check check (
    status is null or lower(status) in ('active', 'archived', 'draft', 'unlisted')
  ),
  constraint products_product_ingredients_array_check check (
    jsonb_typeof(product_ingredients) = 'array'
  ),
  constraint products_product_faqs_shape_check check (
    public.is_valid_product_faqs(product_faqs)
  ),
  constraint products_structured_facts_object_check check (
    jsonb_typeof(structured_facts) = 'object'
  ),
  constraint products_variants_array_check check (
    jsonb_typeof(variants) = 'array'
  ),
  constraint products_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.shopify_metaobjects (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_metaobject_id text not null,
  metaobject_type text not null,
  definition_name text,
  definition_fields jsonb not null default '[]'::jsonb,
  handle text,
  display_name text,
  status text,
  fields jsonb not null default '{}'::jsonb,
  content_hash text,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopify_metaobjects_unique unique (shop_id, shopify_metaobject_id),
  constraint shopify_metaobjects_definition_fields_array_check check (
    jsonb_typeof(definition_fields) = 'array'
  ),
  constraint shopify_metaobjects_fields_object_check check (
    jsonb_typeof(fields) = 'object'
  ),
  constraint shopify_metaobjects_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text,
  handle text,
  title text not null,
  url_path text,
  navigation_area text,
  category text,
  locale text not null default 'fr',
  status text,
  content_text text not null,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  synced_at timestamptz not null default now(),
  shopify_updated_at timestamptz,
  source_metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_documents_navigation_area_check check (
    navigation_area is null or navigation_area in ('header', 'footer', 'manual')
  ),
  constraint knowledge_documents_sections_array_check check (
    jsonb_typeof(sections) = 'array'
  ),
  constraint knowledge_documents_source_metadata_object_check check (
    jsonb_typeof(source_metadata) = 'object'
  )
);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  section_index integer,
  section_heading text,
  category text,
  chunk_text text not null,
  token_count integer,
  content_hash text not null,
  embedding vector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_chunks_document_chunk_unique unique (knowledge_document_id, chunk_index),
  constraint knowledge_chunks_chunk_index_check check (chunk_index >= 0),
  constraint knowledge_chunks_section_index_check check (
    section_index is null or section_index >= 0
  ),
  constraint knowledge_chunks_token_count_check check (
    token_count is null or token_count >= 0
  )
);

create index shops_shopify_shop_id_idx on public.shops (shopify_shop_id);

create index products_shop_handle_idx on public.products (shop_id, handle);
create index products_shop_status_idx on public.products (shop_id, status);
create index products_shop_deleted_at_idx on public.products (shop_id, deleted_at);
create index products_product_ingredients_gin_idx on public.products using gin (product_ingredients);
create index products_product_ingredient_metaobject_ids_gin_idx on public.products using gin (product_ingredient_metaobject_ids);
create index products_product_faqs_gin_idx on public.products using gin (product_faqs);
create index products_product_faq_metaobject_ids_gin_idx on public.products using gin (product_faq_metaobject_ids);
create index products_structured_facts_gin_idx on public.products using gin (structured_facts);
create index products_variants_gin_idx on public.products using gin (variants);

create index shopify_metaobjects_shop_type_idx on public.shopify_metaobjects (shop_id, metaobject_type);
create index shopify_metaobjects_shop_handle_idx on public.shopify_metaobjects (shop_id, handle);
create index shopify_metaobjects_shop_deleted_at_idx on public.shopify_metaobjects (shop_id, deleted_at);
create index shopify_metaobjects_fields_gin_idx on public.shopify_metaobjects using gin (fields);

create unique index knowledge_documents_shop_source_id_unique
  on public.knowledge_documents (shop_id, source_type, shopify_source_id)
  where shopify_source_id is not null;

create unique index knowledge_documents_shop_source_handle_unique
  on public.knowledge_documents (shop_id, source_type, handle)
  where shopify_source_id is null and handle is not null;

create index knowledge_documents_shop_category_idx on public.knowledge_documents (shop_id, category);
create index knowledge_documents_shop_navigation_area_idx on public.knowledge_documents (shop_id, navigation_area);
create index knowledge_documents_shop_deleted_at_idx on public.knowledge_documents (shop_id, deleted_at);
create index knowledge_documents_sections_gin_idx on public.knowledge_documents using gin (sections);

create index knowledge_chunks_document_id_idx on public.knowledge_chunks (knowledge_document_id);
create index knowledge_chunks_category_idx on public.knowledge_chunks (category);

create trigger shops_set_updated_at
before update on public.shops
for each row
execute function public.set_updated_at();

create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

create trigger shopify_metaobjects_set_updated_at
before update on public.shopify_metaobjects
for each row
execute function public.set_updated_at();

create trigger knowledge_documents_set_updated_at
before update on public.knowledge_documents
for each row
execute function public.set_updated_at();

create trigger knowledge_chunks_set_updated_at
before update on public.knowledge_chunks
for each row
execute function public.set_updated_at();

alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.shopify_metaobjects enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;

comment on table public.shops is
  'Shopify shop records and app-level sync state. Shopify remains the source of truth.';

comment on column public.shops.sync_cursors is
  'Per-resource sync cursors for Shopify imports, webhooks, and reconciliation jobs.';

comment on table public.products is
  'Operational Shopify product snapshots for dashboard and AI context. Product images are intentionally not imported.';

comment on column public.products.short_description is
  'Shopify product metafield: Short description.';

comment on column public.products.usage_instructions is
  'Shopify product metafield: Usage Instructions.';

comment on column public.products.usage_advice is
  'Shopify product metafield: Conseils d''utilisation.';

comment on column public.products.active_ingredients is
  'Shopify product metafield: Actifs & ingredients.';

comment on column public.products.ingredients_popup is
  'Shopify product metafield: ingredients popup.';

comment on column public.products.product_ingredients is
  'Optional denormalized product ingredient snapshot for AI/search. Canonical linked ingredient metaobjects are referenced by product_ingredient_metaobject_ids.';

comment on column public.products.product_ingredient_metaobject_ids is
  'Shopify metaobject IDs linked from the Product Ingredients metafield. Canonical ingredient content lives in shopify_metaobjects.';

comment on column public.products.product_faqs is
  'Optional denormalized product FAQ snapshot for AI/search. Canonical linked FAQ metaobjects are referenced by product_faq_metaobject_ids.';

comment on column public.products.product_faq_metaobject_ids is
  'Shopify metaobject IDs linked from the product FAQ list metafield. Canonical FAQ content lives in shopify_metaobjects.';

comment on column public.products.available_stock is
  'Product-level available stock summary, currently synced as the sum of Shopify variant inventory quantities when available.';

comment on column public.products.structured_facts is
  'AI-safe structured product facts extracted from Shopify fields, metafields, or metaobjects.';

comment on column public.products.variants is
  'Structured Shopify variant snapshots as JSONB. Keep query-critical fields duplicated here before adding more tables.';

comment on column public.products.raw_shopify_payload is
  'Sanitized raw Shopify product payload for traceability. Do not include image binaries or unnecessary personal data.';

comment on table public.shopify_metaobjects is
  'Shopify metaobject snapshots shared across products, such as predefined product FAQs and ingredients.';

comment on column public.shopify_metaobjects.shopify_metaobject_id is
  'Stable Shopify metaobject ID/GID used by products to reference this shared content.';

comment on column public.shopify_metaobjects.metaobject_type is
  'Shopify metaobject type, for example product FAQ or ingredient.';

comment on column public.shopify_metaobjects.definition_name is
  'Human-readable Shopify metaobject definition name, for example Product FAQ or Ingredients List.';

comment on column public.shopify_metaobjects.definition_fields is
  'Shopify metaobject definition field schema snapshot for interpreting fields JSONB.';

comment on column public.shopify_metaobjects.fields is
  'Structured metaobject field values synced from Shopify.';

comment on column public.shopify_metaobjects.raw_shopify_payload is
  'Sanitized raw Shopify metaobject payload for traceability. Do not store image binaries or unnecessary personal data.';

comment on table public.knowledge_documents is
  'Cleaned Shopify header/footer page and policy content used as source material for AI support context.';

comment on column public.knowledge_documents.source_type is
  'Source content type, such as shopify_page, shopify_policy, or shopify_menu_page.';

comment on column public.knowledge_documents.navigation_area is
  'Where the page is exposed in the storefront navigation: header, footer, or manual.';

comment on column public.knowledge_documents.category is
  'Loose knowledge category for routing and retrieval. This is intentionally unrestricted until the support taxonomy is finalized.';

comment on column public.knowledge_documents.content_text is
  'Cleaned canonical plain text used for AI context.';

comment on column public.knowledge_documents.sections is
  'Ordered section objects parsed from the page content, usually containing heading, text, order, and anchor.';

comment on column public.knowledge_documents.source_metadata is
  'Small sanitized source metadata snapshot. Do not store full page HTML or unnecessary raw payloads here.';

comment on table public.knowledge_chunks is
  'AI retrieval chunks generated from knowledge_documents sections.';

comment on column public.knowledge_chunks.category is
  'Chunk category copied from the source document for direct filtering during retrieval.';

comment on column public.knowledge_chunks.token_count is
  'Approximate token count used to tune chunking and prompt budgets.';

comment on column public.knowledge_chunks.embedding is
  'Optional pgvector embedding for semantic retrieval. Stored without fixed dimensions until the embedding model is finalized.';
