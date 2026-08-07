-- ============================================================================
-- 01 — FOUNDATION
-- The shop record every other table hangs off, the shared trigger function, and
-- the compliance/audit trail.
--
-- BASELINE, NOT A HISTORY. Four files describe the schema as it SHOULD BE, not
-- the order it was historically built in. Run them in order against an empty
-- database:
--
--     01_foundation.sql -> 02_shopify.sql -> 03_knowledge.sql -> 04_support.sql
--
-- The order is load-bearing and is a plain dependency chain: everything
-- references shops (01); tickets reference customers (02); ticket_investigations
-- reference tickets and ticket_messages (04, internally ordered).
--
-- They are NOT idempotent. Re-running one against a database that already has
-- these objects will error, deliberately: guarding every statement with
-- `if not exists` would obscure the schema these files exist to document. To
-- change the schema, edit the definition here and re-apply to a fresh database.
--
-- Every table enables row-level security with NO policies, so access is
-- service-role only. Adding a dashboard user means adding policies here.
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

-- ---------------------------------------------------------------- shops

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

-- ============================================================================
-- Indexes
-- ============================================================================

create index shops_shopify_shop_id_idx on public.shops (shopify_shop_id);

-- ============================================================================
-- Triggers
-- ============================================================================

create trigger shops_set_updated_at
before update on public.shops
for each row
execute function public.set_updated_at();

-- ============================================================================
-- Row level security
--
-- Enabled with no policies: the service-role worker bypasses RLS, and every
-- other role is denied by default until dashboard roles and policies exist.
-- ============================================================================

alter table public.shops enable row level security;

-- ============================================================================
-- Comments
-- ============================================================================

comment on table public.shops is
  'Shopify shop records and app-level sync state. Shopify remains the source of truth.';

comment on column public.shops.sync_cursors is
  'Per-resource sync cursors for Shopify imports, webhooks, and reconciliation jobs.';

-- ---------------------------------------------------------------- integration_events

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

create index integration_events_shop_status_idx on public.integration_events (shop_id, status);

create index integration_events_source_type_idx on public.integration_events (source, event_type);

create index integration_events_topic_idx on public.integration_events (topic);

create index integration_events_started_at_idx on public.integration_events (started_at);

create trigger integration_events_set_updated_at
before update on public.integration_events
for each row
execute function public.set_updated_at();

alter table public.integration_events enable row level security;

comment on table public.integration_events is
  'Metadata-only log of Shopify sync, webhook, and reconciliation events. Do not store raw payloads or personal data here.';

-- ---------------------------------------------------------------- privacy_requests

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

create index privacy_requests_shop_topic_idx on public.privacy_requests (shop_id, topic);

create index privacy_requests_status_idx on public.privacy_requests (status);

create index privacy_requests_shopify_customer_id_idx on public.privacy_requests (shopify_customer_id);

create index privacy_requests_received_at_idx on public.privacy_requests (received_at);

create trigger privacy_requests_set_updated_at
before update on public.privacy_requests
for each row
execute function public.set_updated_at();

alter table public.privacy_requests enable row level security;

comment on table public.privacy_requests is
  'Lifecycle records for Shopify compliance webhooks. Customer contact values are hashed, not stored verbatim.';

-- ---------------------------------------------------------------- data_access_events

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

create index data_access_events_shop_action_idx on public.data_access_events (shop_id, action);

create index data_access_events_resource_idx on public.data_access_events (resource_type, resource_id_hash);

create index data_access_events_occurred_at_idx on public.data_access_events (occurred_at);

alter table public.data_access_events enable row level security;

comment on table public.data_access_events is
  'Audit trail for service-level personal-data access. Future dashboard human views must write here as user events.';

comment on column public.data_access_events.resource_id_hash is
  'Stable hash of the accessed resource identifier. Avoid storing direct customer email, phone, or address values.';
