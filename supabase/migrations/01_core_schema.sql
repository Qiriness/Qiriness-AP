-- ============================================================================
-- 01 — CORE SCHEMA
-- Everything the support platform needs before the spam filter exists: the
-- Shopify operational snapshots, the knowledge library, the compliance/audit
-- tables, and the email ticketing tables.
--
-- BASELINE, NOT A PATCH. These three files describe the schema as it should be,
-- not the order it was historically built in. Run them in order against an empty
-- database:
--     01_core_schema.sql  ->  02_spam_filter.sql  ->  03_categorisation.sql
-- The order is load-bearing: 03 constrains and extends tables created here, and
-- 02's spam_audit references email_blocklist, which 02 itself creates.
--
-- They are NOT idempotent — re-running one against a database that already has
-- these objects will error. That is deliberate: guarding every statement with
-- `if not exists` would have obscured the schema this file exists to document.
--
-- Shopify stays the source of truth for products, variants, customers, orders,
-- fulfilments and refunds. Everything here is an operational snapshot for sync,
-- dashboard and AI context.
--
-- Two columns are deliberately left undocumented and unconstrained here because
-- 03 owns them: knowledge_documents.category / knowledge_chunks.category (the
-- shared support taxonomy) and tickets.category / .level / .secondary_category
-- (the ticket axes). They are created here, given meaning there.
-- ============================================================================

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

-- ============================================================================
-- Shopify operational snapshots
-- ============================================================================

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

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_customer_id text not null,
  legacy_resource_id text,
  display_name text,
  first_name text,
  last_name text,
  email text,
  phone text,
  locale text,
  state text,
  verified_email boolean,
  valid_email_address boolean,
  tags text[] not null default '{}',
  email_marketing_state text,
  email_marketing_opt_in_level text,
  email_marketing_consent_updated_at timestamptz,
  on_email_marketing_list boolean generated always as (
    coalesce(email_marketing_state = 'SUBSCRIBED', false)
  ) stored,
  default_address_city text,
  default_address_province text,
  default_address_country text,
  default_address_country_code text,
  default_address_formatted_area text,
  number_of_orders integer not null default 0,
  amount_spent numeric(12, 2) not null default 0,
  amount_spent_currency text,
  last_order_id text,
  last_order_name text,
  last_order_at timestamptz,
  last_order_total numeric(12, 2),
  last_order_currency text,
  rfm_group text,
  synced_at timestamptz not null default now(),
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_shopify_customer_unique unique (shop_id, shopify_customer_id),
  constraint customers_state_check check (
    state is null or state in ('DECLINED', 'DISABLED', 'ENABLED', 'INVITED')
  ),
  constraint customers_email_marketing_state_check check (
    email_marketing_state is null
      or email_marketing_state in ('INVALID', 'NOT_SUBSCRIBED', 'PENDING', 'REDACTED', 'SUBSCRIBED', 'UNSUBSCRIBED')
  ),
  constraint customers_number_of_orders_check check (number_of_orders >= 0),
  constraint customers_amount_spent_check check (amount_spent >= 0),
  constraint customers_last_order_total_check check (
    last_order_total is null or last_order_total >= 0
  ),
  constraint customers_rfm_group_check check (
    rfm_group is null
      or rfm_group in (
        'ACTIVE',
        'ALMOST_LOST',
        'AT_RISK',
        'CHAMPIONS',
        'DORMANT',
        'LOYAL',
        'NEEDS_ATTENTION',
        'NEW',
        'PREVIOUSLY_LOYAL',
        'PROMISING',
        'PROSPECTS'
      )
  ),
  constraint customers_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  shopify_order_id text not null,
  shopify_customer_id text,
  legacy_resource_id text,
  name text not null,
  order_number integer,
  source_name text,
  sales_channel text,
  sales_channel_handle text,
  financial_status text,
  fulfillment_status text,
  return_status text,
  order_status text,
  cancel_reason text,
  currency_code text,
  presentment_currency_code text,
  subtotal_price numeric(12, 2),
  total_discounts numeric(12, 2),
  total_shipping_price numeric(12, 2),
  total_tax numeric(12, 2),
  total_price numeric(12, 2),
  total_refunded numeric(12, 2),
  total_outstanding numeric(12, 2),
  total_weight_grams integer,
  tags text[] not null default '{}',
  customer_email_hash text,
  customer_phone_hash text,
  shipping_destination jsonb not null default '{}'::jsonb,
  line_items jsonb not null default '[]'::jsonb,
  fulfillments jsonb not null default '[]'::jsonb,
  returns jsonb not null default '[]'::jsonb,
  refunds jsonb not null default '[]'::jsonb,
  delivered_at timestamptz,
  return_refund_opened_at timestamptz,
  return_refund_completed_at timestamptz,
  retention_rule text,
  retention_delete_after timestamptz,
  processed_at timestamptz,
  cancelled_at timestamptz,
  closed_at timestamptz,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_shopify_order_unique unique (shop_id, shopify_order_id),
  constraint orders_order_number_check check (
    order_number is null or order_number >= 0
  ),
  constraint orders_subtotal_price_check check (
    subtotal_price is null or subtotal_price >= 0
  ),
  constraint orders_total_discounts_check check (
    total_discounts is null or total_discounts >= 0
  ),
  constraint orders_total_shipping_price_check check (
    total_shipping_price is null or total_shipping_price >= 0
  ),
  constraint orders_total_tax_check check (
    total_tax is null or total_tax >= 0
  ),
  constraint orders_total_price_check check (
    total_price is null or total_price >= 0
  ),
  constraint orders_total_refunded_check check (
    total_refunded is null or total_refunded >= 0
  ),
  constraint orders_total_weight_grams_check check (
    total_weight_grams is null or total_weight_grams >= 0
  ),
  constraint orders_order_status_check check (
    order_status is null
      or order_status in (
        'cancelled',
        'return_refund_in_progress',
        'return_refund_completed',
        'delivered',
        'in_transit',
        'fulfilled',
        'partially_fulfilled',
        'unfulfilled',
        'closed',
        'open'
      )
  ),
  constraint orders_retention_rule_check check (
    retention_rule is null
      or retention_rule in (
        'delivered_plus_3_months',
        'undelivered_plus_6_months',
        'return_refund_completed_plus_3_months',
        'return_refund_open_plus_6_months'
      )
  ),
  constraint orders_shipping_destination_object_check check (
    jsonb_typeof(shipping_destination) = 'object'
  ),
  constraint orders_line_items_array_check check (
    jsonb_typeof(line_items) = 'array'
  ),
  constraint orders_fulfillments_array_check check (
    jsonb_typeof(fulfillments) = 'array'
  ),
  constraint orders_returns_array_check check (
    jsonb_typeof(returns) = 'array'
  ),
  constraint orders_refunds_array_check check (
    jsonb_typeof(refunds) = 'array'
  ),
  constraint orders_raw_payload_object_check check (
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

-- Promotion metadata needed for support lookup and manual filtering. Customer
-- targeting details, customer IDs, emails and phone numbers are never stored.
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_discount_node_id text not null,
  shopify_redeem_code_id text,
  promotion_key text not null,
  title text not null,
  code text,
  method text not null,
  discount_type text not null,
  status text,
  summary text,
  short_summary text,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer,
  discount_usage_count integer,
  code_usage_count integer,
  applies_once_per_customer boolean,
  discount_classes text[] not null default '{}',
  combines_with jsonb not null default '{}'::jsonb,
  source_app_name text,
  rule_snapshot jsonb not null default '{}'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint promotions_promotion_key_unique unique (shop_id, promotion_key),
  constraint promotions_method_check check (
    method in ('code', 'automatic')
  ),
  constraint promotions_usage_limit_check check (
    usage_limit is null or usage_limit >= 0
  ),
  constraint promotions_discount_usage_count_check check (
    discount_usage_count is null or discount_usage_count >= 0
  ),
  constraint promotions_code_usage_count_check check (
    code_usage_count is null or code_usage_count >= 0
  ),
  constraint promotions_combines_with_object_check check (
    jsonb_typeof(combines_with) = 'object'
  ),
  constraint promotions_rule_snapshot_object_check check (
    jsonb_typeof(rule_snapshot) = 'object'
  ),
  constraint promotions_source_metadata_object_check check (
    jsonb_typeof(source_metadata) = 'object'
  ),
  constraint promotions_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

-- ============================================================================
-- Knowledge library
--
-- Nothing auto-syncs into knowledge_documents: a row is only ever created by an
-- explicit import or a manually written article. Editing an imported article
-- converts source_type to 'manual', which is what stops it from resyncing --
-- there is no separate "locally modified" flag.
-- ============================================================================

-- Identity-only index of live Shopify pages and policies, used to populate the
-- Agent Setup source dropdown. Content is resolved on demand at import time.
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

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text,
  handle text,
  title text not null,
  url_path text,
  navigation_area text,
  -- Constrained to the shared support taxonomy in 03.
  category text,
  locale text not null default 'fr',
  status text,
  content_html text,
  content_text text not null,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  approval_status text not null default 'draft',
  core_topic text,
  voice_profile jsonb not null default '{}'::jsonb,
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
  ),
  constraint knowledge_documents_approval_status_check check (
    approval_status in ('draft', 'in_review', 'approved', 'needs_optimization')
  ),
  -- Six slots, with delivery and returns combined into one. The app's CoreTopic
  -- type is the other copy of this list; they must agree or saving an article
  -- into a slot fails with a check violation.
  constraint knowledge_documents_core_topic_check check (
    core_topic is null or core_topic in (
      'order_policies',
      'brand',
      'confidentiality',
      'delivery_returns',
      'locations',
      'faqs'
    )
  )
);

-- Retrieval chunks generated from knowledge_documents sections.
--
-- Determinism: a vector is stored with the exact composed-input hash, model and
-- dimension count it was produced for, so re-running the embedder over unchanged
-- content is a no-op. Only chunks whose parent document is approved and is not
-- the brand-voice document ever hold a vector -- the pipeline gates on that.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  section_index integer,
  section_heading text,
  -- Denormalised from the parent document; constrained with it in 03.
  category text,
  chunk_text text not null,
  token_count integer,
  content_hash text not null,
  embedding vector(1536),
  embedding_model text,
  embedding_dimensions integer,
  embedded_input_hash text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_chunks_document_chunk_unique unique (knowledge_document_id, chunk_index),
  constraint knowledge_chunks_chunk_index_check check (chunk_index >= 0),
  constraint knowledge_chunks_section_index_check check (
    section_index is null or section_index >= 0
  ),
  constraint knowledge_chunks_token_count_check check (
    token_count is null or token_count >= 0
  ),
  constraint knowledge_chunks_embedding_dimensions_check check (
    embedding_dimensions is null or embedding_dimensions = 1536
  )
);

-- ============================================================================
-- Integration, compliance and audit
-- ============================================================================

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  event_key text not null,
  source text not null,
  event_type text not null,
  status text not null default 'received',
  idempotency_key text,
  topic text,
  actor_type text not null default 'system',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint integration_events_event_key_unique unique (event_key),
  constraint integration_events_status_check check (
    status in ('received', 'processing', 'completed', 'failed', 'skipped')
  ),
  constraint integration_events_counts_object_check check (
    jsonb_typeof(counts) = 'object'
  ),
  constraint integration_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  integration_event_id uuid references public.integration_events(id) on delete set null,
  request_key text not null,
  topic text not null,
  shopify_shop_id text,
  shop_domain text,
  shopify_customer_id text,
  customer_email_hash text,
  customer_phone_hash text,
  status text not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  deleted_customer_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint privacy_requests_request_key_unique unique (request_key),
  constraint privacy_requests_topic_check check (
    topic in ('customers/data_request', 'customers/redact', 'shop/redact')
  ),
  constraint privacy_requests_status_check check (
    status in ('received', 'processing', 'pending_merchant_response', 'completed', 'failed', 'skipped')
  ),
  constraint privacy_requests_deleted_customer_count_check check (
    deleted_customer_count >= 0
  ),
  constraint privacy_requests_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create table public.data_access_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  integration_event_id uuid references public.integration_events(id) on delete set null,
  actor_type text not null,
  actor_id text not null,
  action text not null,
  resource_type text not null,
  resource_id_hash text,
  purpose text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint data_access_events_actor_type_check check (
    actor_type in ('system', 'service', 'user')
  ),
  constraint data_access_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

-- ============================================================================
-- Support ticketing
--
-- A ticket is a CONVERSATION, not a single email: inbound mail is grouped by
-- Microsoft Graph conversationId, so a back-and-forth thread is one ticket with
-- many ticket_messages.
--
-- Personal-data minimisation: the ticket row stores only a hash of the requester
-- email (for order matching and dedup) plus a display name. The raw addresses
-- needed to actually send replies live on ticket_messages, where they are
-- strictly required. Nothing here goes into an AI prompt unless the task needs it.
-- ============================================================================

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,

  graph_conversation_id text not null,
  subject text,
  status text not null default 'open',

  -- The categorisation axes. Vocabulary, constraints and meaning all land in 03.
  category text,
  secondary_category text,
  level smallint,
  responsible_team text,

  -- Source-of-truth lookup key resolved by the order-number tool.
  shopify_order_number text,
  customer_id uuid references public.customers(id) on delete set null,

  -- Hash of the requester email: lets us match against orders.customer_email_hash
  -- and dedup by sender without duplicating the raw address on this row.
  requester_email_hash text,
  requester_name text,

  priority smallint not null default 3,
  resolved_context jsonb not null default '{}'::jsonb,
  context_resolved_at timestamptz,

  first_message_at timestamptz,
  last_message_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,

  -- Retention lifecycle. archived_at keeps the ticket but drops it out of the
  -- active queue; deleted_at is the separate compliance soft-delete.
  resolved_at timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,
  retention_delete_after timestamptz,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tickets_shop_conversation_unique unique (shop_id, graph_conversation_id),
  constraint tickets_status_check check (
    status in (
      'open',
      'awaiting_customer',
      'awaiting_human',
      'forwarded',
      'resolved',
      'closed',
      'spam'
    )
  ),
  constraint tickets_level_check check (level is null or level between 1 and 4),
  constraint tickets_priority_check check (priority between 1 and 5),
  constraint tickets_responsible_team_check check (
    responsible_team is null
      or responsible_team in ('finance', 'marketing', 'sales', 'logistics', 'contact')
  ),
  constraint tickets_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint tickets_resolved_context_object_check check (
    jsonb_typeof(resolved_context) = 'object'
  )
);

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,

  graph_message_id text not null,
  graph_conversation_id text not null,
  internet_message_id text,
  in_reply_to text,

  direction text not null,
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text,
  body_text text,
  body_preview text,
  has_attachments boolean not null default false,

  received_at timestamptz,
  sent_at timestamptz,

  -- Semantic vectors of the email body for similar-ticket retrieval, reusing the
  -- knowledge_chunks determinism pattern. Cheap at support-email volume.
  embedding vector(1536),
  embedding_model text,
  embedding_dimensions integer,
  embedded_input_hash text,
  embedded_at timestamptz,

  raw_graph_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ticket_messages_shop_message_unique unique (shop_id, graph_message_id),
  constraint ticket_messages_direction_check check (
    direction in ('inbound', 'outbound')
  ),
  constraint ticket_messages_raw_payload_object_check check (
    jsonb_typeof(raw_graph_payload) = 'object'
  )
);

-- ============================================================================
-- Indexes
-- ============================================================================

create index shops_shopify_shop_id_idx on public.shops (shopify_shop_id);

create index customers_shop_email_idx on public.customers (shop_id, email);
create index customers_shop_email_marketing_idx on public.customers (shop_id, on_email_marketing_list);
create index customers_shop_location_idx on public.customers (shop_id, default_address_country_code, default_address_city);
create index customers_shop_orders_idx on public.customers (shop_id, number_of_orders);
create index customers_shop_amount_spent_idx on public.customers (shop_id, amount_spent);
create index customers_shop_rfm_group_idx on public.customers (shop_id, rfm_group);
create index customers_shop_last_order_at_idx on public.customers (shop_id, last_order_at);
create index customers_shop_deleted_at_idx on public.customers (shop_id, deleted_at);
create index customers_tags_gin_idx on public.customers using gin (tags);

create index orders_shop_name_idx on public.orders (shop_id, name);
create index orders_shop_order_number_idx on public.orders (shop_id, order_number);
create index orders_sales_channel_idx on public.orders (shop_id, sales_channel);
create index orders_sales_channel_handle_idx on public.orders (shop_id, sales_channel_handle);
create index orders_customer_id_idx on public.orders (customer_id);
create index orders_shopify_customer_id_idx on public.orders (shop_id, shopify_customer_id);
create index orders_financial_status_idx on public.orders (shop_id, financial_status);
create index orders_fulfillment_status_idx on public.orders (shop_id, fulfillment_status);
create index orders_return_status_idx on public.orders (shop_id, return_status);
create index orders_order_status_idx on public.orders (shop_id, order_status);
create index orders_delivered_at_idx on public.orders (shop_id, delivered_at);
create index orders_return_refund_opened_at_idx on public.orders (shop_id, return_refund_opened_at);
create index orders_return_refund_completed_at_idx on public.orders (shop_id, return_refund_completed_at);
create index orders_retention_delete_after_idx on public.orders (shop_id, retention_delete_after);
create index orders_processed_at_idx on public.orders (shop_id, processed_at);
create index orders_deleted_at_idx on public.orders (shop_id, deleted_at);
create index orders_tags_gin_idx on public.orders using gin (tags);
create index orders_line_items_gin_idx on public.orders using gin (line_items);
create index orders_fulfillments_gin_idx on public.orders using gin (fulfillments);
create index orders_returns_gin_idx on public.orders using gin (returns);
create index orders_refunds_gin_idx on public.orders using gin (refunds);

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

create index promotions_shop_status_idx on public.promotions (shop_id, status);
create index promotions_shop_code_idx on public.promotions (shop_id, code);
create index promotions_shop_method_idx on public.promotions (shop_id, method);
create index promotions_shop_discount_type_idx on public.promotions (shop_id, discount_type);
create index promotions_shop_applies_once_idx on public.promotions (shop_id, applies_once_per_customer);
create index promotions_shop_source_app_name_idx on public.promotions (shop_id, source_app_name);
create index promotions_shop_synced_at_idx on public.promotions (shop_id, synced_at);
create index promotions_shop_deleted_at_idx on public.promotions (shop_id, deleted_at);
create index promotions_discount_classes_gin_idx on public.promotions using gin (discount_classes);
create index promotions_combines_with_gin_idx on public.promotions using gin (combines_with);
create index promotions_rule_snapshot_gin_idx on public.promotions using gin (rule_snapshot);

create index shopify_content_sources_shop_type_idx on public.shopify_content_sources (shop_id, source_type);

create unique index knowledge_documents_shop_source_id_unique
  on public.knowledge_documents (shop_id, source_type, shopify_source_id)
  where shopify_source_id is not null;

create unique index knowledge_documents_shop_source_handle_unique
  on public.knowledge_documents (shop_id, source_type, handle)
  where shopify_source_id is null and handle is not null;

-- At most one active article per shop per core-topic slot.
create unique index knowledge_documents_shop_core_topic_unique
  on public.knowledge_documents (shop_id, core_topic)
  where core_topic is not null;

create index knowledge_documents_shop_category_idx on public.knowledge_documents (shop_id, category);
create index knowledge_documents_shop_navigation_area_idx on public.knowledge_documents (shop_id, navigation_area);
create index knowledge_documents_shop_deleted_at_idx on public.knowledge_documents (shop_id, deleted_at);
create index knowledge_documents_sections_gin_idx on public.knowledge_documents using gin (sections);

create index knowledge_chunks_document_id_idx on public.knowledge_chunks (knowledge_document_id);
create index knowledge_chunks_category_idx on public.knowledge_chunks (category);

-- Approximate-nearest-neighbour index for cosine retrieval. HNSW needs pgvector
-- >= 0.5.0 (Supabase's managed pgvector has it); on an older target, swap for
-- ivfflat.
create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

create index integration_events_shop_status_idx on public.integration_events (shop_id, status);
create index integration_events_source_type_idx on public.integration_events (source, event_type);
create index integration_events_topic_idx on public.integration_events (topic);
create index integration_events_started_at_idx on public.integration_events (started_at);

create index privacy_requests_shop_topic_idx on public.privacy_requests (shop_id, topic);
create index privacy_requests_status_idx on public.privacy_requests (status);
create index privacy_requests_shopify_customer_id_idx on public.privacy_requests (shopify_customer_id);
create index privacy_requests_received_at_idx on public.privacy_requests (received_at);

create index data_access_events_shop_action_idx on public.data_access_events (shop_id, action);
create index data_access_events_resource_idx on public.data_access_events (resource_type, resource_id_hash);
create index data_access_events_occurred_at_idx on public.data_access_events (occurred_at);

create index tickets_shop_status_idx on public.tickets (shop_id, status);
create index tickets_shop_category_idx on public.tickets (shop_id, category);
create index tickets_shop_secondary_category_idx on public.tickets (shop_id, secondary_category);
create index tickets_shop_level_idx on public.tickets (shop_id, level);
create index tickets_shop_priority_idx on public.tickets (shop_id, priority);
create index tickets_shop_responsible_team_idx on public.tickets (shop_id, responsible_team);
create index tickets_shop_order_number_idx on public.tickets (shop_id, shopify_order_number);
create index tickets_shop_requester_email_hash_idx on public.tickets (shop_id, requester_email_hash);
create index tickets_customer_id_idx on public.tickets (customer_id);
create index tickets_shop_last_message_at_idx on public.tickets (shop_id, last_message_at);
create index tickets_shop_archived_at_idx on public.tickets (shop_id, archived_at);
create index tickets_retention_delete_after_idx on public.tickets (shop_id, retention_delete_after);
create index tickets_shop_deleted_at_idx on public.tickets (shop_id, deleted_at);

create index ticket_messages_ticket_id_idx on public.ticket_messages (ticket_id);
create index ticket_messages_shop_conversation_idx on public.ticket_messages (shop_id, graph_conversation_id);
create index ticket_messages_shop_received_at_idx on public.ticket_messages (shop_id, received_at);
create index ticket_messages_shop_deleted_at_idx on public.ticket_messages (shop_id, deleted_at);
create index ticket_messages_embedding_hnsw_idx on public.ticket_messages using hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- Triggers
-- ============================================================================

create trigger shops_set_updated_at
before update on public.shops
for each row
execute function public.set_updated_at();

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();

create trigger orders_set_updated_at
before update on public.orders
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

create trigger promotions_set_updated_at
before update on public.promotions
for each row
execute function public.set_updated_at();

create trigger shopify_content_sources_set_updated_at
before update on public.shopify_content_sources
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

create trigger integration_events_set_updated_at
before update on public.integration_events
for each row
execute function public.set_updated_at();

create trigger privacy_requests_set_updated_at
before update on public.privacy_requests
for each row
execute function public.set_updated_at();

create trigger tickets_set_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

create trigger ticket_messages_set_updated_at
before update on public.ticket_messages
for each row
execute function public.set_updated_at();

-- ============================================================================
-- Row level security
--
-- Enabled with no policies: the service-role worker bypasses RLS, and every
-- other role is denied by default until dashboard roles and policies exist.
-- ============================================================================

alter table public.shops enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.products enable row level security;
alter table public.shopify_metaobjects enable row level security;
alter table public.promotions enable row level security;
alter table public.shopify_content_sources enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.integration_events enable row level security;
alter table public.privacy_requests enable row level security;
alter table public.data_access_events enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;

-- ============================================================================
-- Comments
-- ============================================================================

comment on table public.shops is
  'Shopify shop records and app-level sync state. Shopify remains the source of truth.';

comment on column public.shops.sync_cursors is
  'Per-resource sync cursors for Shopify imports, webhooks, and reconciliation jobs.';

comment on table public.customers is
  'Lean Shopify customer snapshots for support dashboards and segmentation. Access through service-role sync paths only until dashboard roles and policies are implemented.';

comment on column public.customers.email is
  'Customer email for support lookup. Do not include this field in AI prompts unless strictly required.';

comment on column public.customers.phone is
  'Customer phone for support lookup. Do not include this field in AI prompts unless strictly required.';

comment on column public.customers.on_email_marketing_list is
  'Generated from Shopify defaultEmailAddress.marketingState = SUBSCRIBED.';

comment on column public.customers.default_address_formatted_area is
  'Coarse customer location from the default address. Street address and postcode are intentionally not stored here.';

comment on column public.customers.number_of_orders is
  'Lifetime Shopify order count from Customer.numberOfOrders.';

comment on column public.customers.amount_spent is
  'Lifetime Shopify amount spent from Customer.amountSpent.';

comment on column public.customers.rfm_group is
  'Shopify-computed Customer.statistics.rfmGroup category used by Shopify customer segmentation as rfm_group.';

comment on column public.customers.raw_shopify_payload is
  'Small sanitized customer payload for traceability. Avoid full addresses, notes, and unnecessary personal data.';

comment on table public.orders is
  'Lean Shopify order snapshots for support workflows. Shopify remains the source of truth.';

comment on column public.orders.customer_id is
  'Optional link to the local customer snapshot. Guest orders or unsynced customers may only have shopify_customer_id or hashed contact fields.';

comment on column public.orders.source_name is
  'Raw Shopify order source name, such as web, pos, mobile_app, or a third-party source identifier. This is not always the merchant-facing sales channel label.';

comment on column public.orders.sales_channel is
  'Merchant-facing sales channel label shown in Shopify Admin order lists, such as Online Store, POS, Amazon, or another marketplace.';

comment on column public.orders.sales_channel_handle is
  'Stable Shopify sales channel or order attribution handle when available, useful for filtering and matching channel-specific workflows.';

comment on column public.orders.order_status is
  'Dashboard-facing order lifecycle stage derived from cancellation, return/refund, delivery, and fulfillment state.';

comment on column public.orders.customer_email_hash is
  'Hash of the order contact email for support lookup without duplicating raw email on the order row.';

comment on column public.orders.customer_phone_hash is
  'Hash of the order contact phone for support lookup without duplicating raw phone on the order row.';

comment on column public.orders.shipping_destination is
  'Coarse shipping destination only, such as city, province, country, and country code. Do not store street address or postcode here.';

comment on column public.orders.line_items is
  'Sanitized Shopify line item snapshots for support workflows, excluding customer personal data.';

comment on column public.orders.fulfillments is
  'Sanitized fulfillment and tracking summaries needed for order tracking support.';

comment on column public.orders.returns is
  'Sanitized return summaries needed for support workflows and order retention decisions.';

comment on column public.orders.refunds is
  'Sanitized refund summaries needed for support workflows.';

comment on column public.orders.delivered_at is
  'Timestamp when the order was confirmed delivered from Shopify fulfillment/tracking data. Used as the retention anchor for completed delivered orders.';

comment on column public.orders.return_refund_opened_at is
  'Timestamp when a return or refund process was first detected. Used as the retention anchor for unresolved return/refund cases.';

comment on column public.orders.return_refund_completed_at is
  'Timestamp when a return or refund process was completed. Used as the retention anchor before deleting completed return/refund cases.';

comment on column public.orders.retention_rule is
  'Order retention rule selected by sync: delivered_plus_3_months, undelivered_plus_6_months, return_refund_completed_plus_3_months, or return_refund_open_plus_6_months.';

comment on column public.orders.retention_delete_after is
  'Timestamp after which the local operational order snapshot can be deleted: delivered_at plus 3 months, return/refund completion plus 3 months, order creation/processing plus 6 months if not delivered, or return/refund opening plus 6 months if unresolved.';

comment on column public.orders.raw_shopify_payload is
  'Sanitized raw Shopify order payload for traceability. Exclude street addresses, raw contact values, payment details, and other unnecessary personal data.';

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

comment on table public.promotions is
  'Shopify discount and promotion snapshots for support workflows. Shopify remains the source of truth.';

comment on column public.promotions.promotion_key is
  'Stable local unique key: redeem-code ID for code discounts, or discount node ID for automatic discounts.';

comment on column public.promotions.code is
  'Customer-entered promotion code when method = code. Automatic discounts store null.';

comment on column public.promotions.applies_once_per_customer is
  'Shopify appliesOncePerCustomer flag for manual filtering of customer-specific or one-use promotions.';

comment on column public.promotions.rule_snapshot is
  'Sanitized promotion rule metadata such as discount classes, combines-with flags, context type, and requirement types. Do not store customer targeting details.';

comment on column public.promotions.source_metadata is
  'Small source metadata snapshot such as code count and creator app name. Do not store customer IDs, emails, phone numbers, or customer selection payloads.';

comment on column public.promotions.raw_shopify_payload is
  'Sanitized raw Shopify discount payload for traceability. Exclude customer targeting details and personal data.';

comment on table public.shopify_content_sources is
  'Lightweight index of live Shopify Online Store pages and shop policies (refund, privacy, shipping, terms of service, etc.), used to populate the Agent Setup source dropdown. Holds identity only; content is resolved on demand at import/resync time and is not stored here.';

comment on column public.shopify_content_sources.source_type is
  'shopify_page or shopify_policy. Distinguishes which Shopify resource this row indexes, since pages and policies are fetched and resolved through different Shopify Admin API calls.';

comment on column public.shopify_content_sources.status is
  'Shopify publish state: published or unpublished. Policies are always published (Shopify has no draft state for a filled-in policy); pages derive this from publishedAt presence.';

comment on table public.knowledge_documents is
  'Cleaned Shopify header/footer page and policy content used as source material for AI support context.';

comment on column public.knowledge_documents.source_type is
  'shopify_page, shopify_policy, or manual. Editing an imported article in the dashboard converts this to manual (shopify_source_id/handle are kept for provenance), which is what stops it from being resynced from Shopify going forward.';

comment on column public.knowledge_documents.navigation_area is
  'Where the page is exposed in the storefront navigation: header, footer, or manual.';

comment on column public.knowledge_documents.content_html is
  'Rich-text HTML as edited in the Agent Setup dashboard. Source of truth for the editor; content_text and sections are regenerated from this on every save, import, or resync.';

comment on column public.knowledge_documents.content_text is
  'Cleaned canonical plain text used for AI context.';

comment on column public.knowledge_documents.sections is
  'Ordered section objects parsed from the page content, usually containing heading, text, order, and anchor.';

comment on column public.knowledge_documents.approval_status is
  'Team review state for agent usage: draft, in_review, approved, or needs_optimization. Independent of status, which holds the Shopify publish state for Shopify-sourced articles.';

comment on column public.knowledge_documents.core_topic is
  'Optional required-knowledge slot this article fulfills (order_policies, brand, confidentiality, delivery_returns, locations, faqs). At most one active article per shop per slot. Distinct from the category column.';

comment on column public.knowledge_documents.voice_profile is
  'Structured brand-voice fields for the singleton Brand Voice article (core_topic = ''brand''): { roleDescription: string, toneAndVoice: string }. Empty ({}) on every other article. Always-included drafting-agent context, distinct from content_html (used on this row for freeform general-context guidance) and from ordinary knowledge_documents rows, which are selectively retrieved via knowledge_chunks.';

comment on column public.knowledge_documents.source_metadata is
  'Small sanitized source metadata snapshot. Do not store full page HTML or unnecessary raw payloads here.';

comment on table public.knowledge_chunks is
  'AI retrieval chunks generated from knowledge_documents sections.';

comment on column public.knowledge_chunks.token_count is
  'Approximate token count used to tune chunking and prompt budgets.';

comment on column public.knowledge_chunks.embedding is
  'pgvector embedding (text-embedding-3-small, 1536 dims) for cosine retrieval. Present only while the parent document is approved and the vector matches the current composed input; cleared when the document leaves approved.';

comment on column public.knowledge_chunks.embedding_model is
  'OpenAI model the embedding was produced with, e.g. text-embedding-3-small. Used to detect stale vectors after a model change.';

comment on column public.knowledge_chunks.embedding_dimensions is
  'Dimension count requested for the embedding (1536). Used alongside embedding_model to detect vectors that must be recomputed.';

comment on column public.knowledge_chunks.embedded_input_hash is
  'Hash of the exact composed input text sent to the embedding model (title + category + section heading + chunk text). Distinct from content_hash, which ignores title/category/heading; a category rename changes this hash and invalidates the vector.';

comment on column public.knowledge_chunks.embedded_at is
  'Timestamp the embedding was last computed.';

comment on table public.integration_events is
  'Metadata-only log of Shopify sync, webhook, and reconciliation events. Do not store raw payloads or personal data here.';

comment on table public.privacy_requests is
  'Lifecycle records for Shopify compliance webhooks. Customer contact values are hashed, not stored verbatim.';

comment on table public.data_access_events is
  'Audit trail for service-level personal-data access. Future dashboard human views must write here as user events.';

comment on column public.data_access_events.resource_id_hash is
  'Stable hash of the accessed resource identifier. Avoid storing direct customer email, phone, or address values.';

comment on table public.tickets is
  'Support conversations for the agent email workflow. One ticket per Microsoft Graph conversationId; the categorising agent fills category, request_kind, level, responsible_team, and the resolved Shopify order number. Access through the service-role worker only until dashboard roles and policies are implemented.';

comment on column public.tickets.graph_conversation_id is
  'Microsoft Graph conversationId. The threading key: all emails in one thread share this value and roll up to a single ticket, so tickets behave as conversations rather than individual emails.';

comment on column public.tickets.status is
  'Ticket lifecycle: open, awaiting_customer, awaiting_human, forwarded, resolved, closed, or spam. In draft-only mode nothing is auto-sent, so agent-drafted replies sit at awaiting_human until approved.';

comment on column public.tickets.responsible_team is
  'Team a forwarded ticket belongs to: finance, marketing, sales, logistics, or contact. The worker forwards B2B/invoice/marketing-type mail to the implicated person and tags the ticket here.';

comment on column public.tickets.shopify_order_number is
  'Shopify order number resolved for this ticket (the workflow''s source-of-truth lookup key). Stored as text to preserve the customer-facing #XXXX form; matched against orders.name / orders.order_number by the order-lookup tool.';

comment on column public.tickets.customer_id is
  'Optional link to the local customer snapshot once the requester is matched. Null for unresolved or guest requesters.';

comment on column public.tickets.requester_email_hash is
  'Hash of the requester email, for matching against orders.customer_email_hash and deduping by sender without storing the raw address on the ticket. The raw reply address lives on the latest inbound ticket_messages row.';

comment on column public.tickets.requester_name is
  'Display name of the requester for the dashboard queue. Do not include in AI prompts unless strictly required.';

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

comment on table public.ticket_messages is
  'Individual emails belonging to a ticket, one row per Microsoft Graph message. Inbound mail is ingested here idempotently (unique on shop_id + graph_message_id); outbound rows are the agent replies and team forwards.';

comment on column public.ticket_messages.graph_message_id is
  'Microsoft Graph message id. The idempotency key: re-ingesting the same email is a no-op via the shop_id + graph_message_id unique constraint.';

comment on column public.ticket_messages.internet_message_id is
  'RFC 5322 Message-ID header, stable across mail systems. Useful for threading and correlating replies independently of Graph ids.';

comment on column public.ticket_messages.direction is
  'inbound (from the customer/third party) or outbound (agent reply or team forward sent from the support mailbox).';

comment on column public.ticket_messages.from_email is
  'Raw sender email. Required to reply to the requester; do not include in AI prompts unless strictly required.';

comment on column public.ticket_messages.body_text is
  'Cleaned plain-text email body used for triage, categorisation, and drafting. Minimise personal data and keep it out of AI prompts unless strictly required for the task.';

comment on column public.ticket_messages.embedding is
  'pgvector(1536) embedding of the email body (text-embedding-3-small) for similar-ticket retrieval and clustering, populated primarily for inbound messages. Matches the knowledge_chunks embedding pipeline; a row holds a vector iff embedded_input_hash/model/dimensions match the current input and model.';

comment on column public.ticket_messages.embedded_input_hash is
  'Hash of the embedded input (body text + relevant metadata) so a reconciler can detect stale vectors and re-embed on model or content changes, mirroring knowledge_chunks determinism metadata.';

comment on column public.ticket_messages.raw_graph_payload is
  'Sanitised raw Microsoft Graph message payload for traceability. Exclude attachment binaries and unnecessary personal data.';
