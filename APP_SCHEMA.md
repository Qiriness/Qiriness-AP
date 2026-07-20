# APP_SCHEMA

## Stack

- Shopify
- Supabase
- PostgreSQL
- App stack: pending

## Route Map

```text
/
|-- README.md          # project overview
|-- AGENTS.md          # agent rules
|-- CLAUDE.md          # claude agent pointer
|-- APP_SCHEMA.md      # repo map
|-- MERCHANT_DATA_USE_DISCLOSURE.md # merchant-facing Shopify data-use disclosure draft
|-- SHOPIFY_PERSONAL_DATA_PROTECTION.md # Shopify protected customer data checklist
|-- package.json       # Node scripts for Shopify/Supabase sync
|-- scripts/
|   |-- apply-supabase-migration.mjs # SQL migration runner using SUPABASE_DB_URL
|   |-- process-shopify-compliance-webhook.mjs # CLI harness for compliance webhook handler
|   |-- sync-shopify-products.mjs # Shopify product/metaobject sync orchestration
|   |-- sync-shopify-customers.mjs # Shopify customer sync orchestration
|   |-- sync-shopify-orders.mjs # Shopify order sync orchestration and retention cleanup
|   |-- sync-shopify-knowledge.mjs # Shopify page/policy sync and chunk orchestration
|   |-- sync-shopify-nightly.mjs # nightly Shopify sync orchestrator
|   |-- sync-shopify-nightly.test.mjs # nightly schedule/order tests
|   `-- lib/
|       |-- compliance-audit.mjs        # sanitized compliance event and access logging helpers
|       |-- collections.mjs              # shared collection/object helpers
|       |-- hash.mjs                     # stable JSON hashing helper
|       |-- html-to-text.mjs             # Shopify HTML to cleaned plain text/sections
|       |-- knowledge-categories.mjs     # loose support category inference
|       |-- knowledge-chunker.mjs        # knowledge document chunk generation
|       |-- knowledge-document-mapper.mjs # Shopify page/policy to knowledge_documents rows
|       |-- knowledge-document-repository.mjs # Supabase merge logic for knowledge_documents
|       |-- knowledge-navigation.mjs     # Shopify menu to navigation-area metadata
|       |-- shopify-theme-client.mjs     # read-only Shopify theme/asset client for template fallback
|       |-- shopify-admin-client.mjs     # Shopify Admin API queries and pagination
|       |-- shopify-compliance-webhooks.mjs # Shopify compliance webhook HMAC, privacy request, and redaction logic
|       |-- shopify-compliance-webhooks.test.mjs # compliance webhook tests
|       |-- shopify-customer-mapper.mjs  # Shopify customer to customers row mapper, including RFM group
|       |-- shopify-customer-mapper.test.mjs # customer mapper privacy/consent tests
|       |-- shopify-order-mapper.mjs # Shopify order to orders row mapper, including retention metadata
|       |-- shopify-order-mapper.test.mjs # order mapper privacy/channel/retention tests
|       |-- shopify-knowledge-client.mjs # Shopify pages, policies, and menus reader
|       |-- shopify-metaobject-mapper.mjs # Shopify metaobject row mapping
|       |-- shopify-product-mapper.mjs   # Shopify product row mapping
|       |-- shopify-shop-mapper.mjs      # Shopify shop row mapping
|       |-- shopify-sync-mappers.mjs     # mapper barrel exports
|       |-- shop-sync-service.mjs        # shared Shopify shop row upsert
|       |-- supabase-rest-client.mjs     # Supabase REST upsert client
|       |-- supabase-rest-client.test.mjs # Node regression tests for Supabase REST payload handling
|       |-- sync-config.mjs              # CLI/env parsing for sync scripts
|       |-- text-cleaning.mjs            # AI-facing French text normalization
|       `-- knowledge/
|           |-- source-discovery.mjs      # Shopify page identity/navigation source discovery
|           |-- knowledge-source-resolver.mjs # ordered content resolver coordinator
|           `-- content-resolvers/
|               |-- manual-override-resolver.mjs # optional local canonical text override
|               |-- page-metafield-resolver.mjs # dedicated AI/support page metafield content
|               |-- page-body-resolver.mjs      # Shopify Page.body content
|               `-- theme-template-resolver.mjs # Shopify theme template/section settings fallback
`-- supabase/
    `-- migrations/
        `-- 001_initial_schema.sql # consolidated Supabase schema for shops, customers, orders, products, knowledge, and compliance metadata
        `-- compliance-migrations.test.mjs # static migration coverage for compliance tables
        `-- orders-migration.test.mjs # static migration coverage for order table shape
```

## Database Map

- `public.shops` - Shopify shop records, environment, app settings, and sync cursors.
- `public.customers` - Lean Shopify customer snapshots for support lookup and segmentation.
  - Stores contact lookup fields, email marketing subscription state, coarse default location, lifetime order count, lifetime amount spent, last-order summary, and Shopify-computed RFM group.
  - `on_email_marketing_list` is generated from Shopify email marketing state.
  - `rfm_group` comes from Shopify `Customer.statistics.rfmGroup` and matches Shopify customer segmentation values such as `CHAMPIONS`, `LOYAL`, `ACTIVE`, and `AT_RISK`.
  - Raw payloads intentionally exclude full addresses, notes, and unnecessary personal data.
- `public.orders` - Lean Shopify order snapshots for order tracking and support workflows.
  - Stores Shopify order identity, optional local/customer Shopify linkage, order name/number, raw source name, merchant-facing sales channel, dashboard-facing `order_status`, source Shopify status fields, totals, tags, line items, fulfillments, returns, refunds, and Shopify timestamps.
  - `order_status` is derived for datatable filtering/display from cancellation, return/refund, delivery, and fulfillment state.
  - `source_name` preserves Shopify's raw source/platform value, while `sales_channel` stores the dashboard label such as Online Store, POS, Amazon, or another marketplace.
  - Retention metadata uses `delivered_at`, `return_refund_opened_at`, `return_refund_completed_at`, `retention_rule`, and `retention_delete_after`: delivered orders can be deleted 3 months after delivery; completed return/refund cases can be deleted 3 months after completion; orders still not delivered after 6 months or still in an unresolved return/refund after 6 months can also be deleted from the local operational table.
  - Customer-adjacent lookup fields are hashes (`customer_email_hash`, `customer_phone_hash`) instead of duplicated raw contact values.
  - `shipping_destination` is a coarse JSONB object only; street address and postcode are intentionally excluded.
  - Raw payloads must be sanitized to exclude street addresses, raw contact values, payment details, and unnecessary personal data.
  - Synced by `scripts/sync-shopify-orders.mjs`; the sync upserts accessible Shopify orders and deletes local rows whose `retention_delete_after` has passed.
- `public.products` - Shopify product snapshots, structured product metafields, variants JSONB, and structured product-specific FAQs.
  - First-class Shopify metafields: Usage Instructions, Short description, Conseils d'utilisation, Actifs & ingredients, ingredients popup, Product Ingredients.
  - Product-level stock is stored in `available_stock` as a simple support/dashboard summary.
  - Product FAQ and Product Ingredients metafields can reference shared Shopify metaobjects by ID.
- `public.shopify_metaobjects` - Shared Shopify metaobject snapshots, such as predefined FAQ and ingredient records linked from products.
  - The sync stores targeted full metaobject definitions/entries from Shopify Metaobjects, plus any product-linked entries.
  - AI-facing product/metaobject text is cleaned for common French mojibake before storage; raw Shopify payloads remain unmodified for traceability.
- `public.knowledge_documents` - Cleaned Shopify header/footer page and policy documents for AI support context.
  - Stores source identity, navigation area, loose category, French canonical text, and parsed sections.
  - Shopify pages and legal policies are synced by `scripts/sync-shopify-knowledge.mjs`; navigation area is inferred from Shopify menus when menu access is available.
  - Page content is resolved in priority order: manual override, dedicated page metafield, Shopify `Page.body`, then theme template settings.
- `public.knowledge_chunks` - Lean retrieval chunks linked to knowledge documents.
  - Keeps chunk category, token count, text, hash, and optional vector embedding; document-level source fields stay on `knowledge_documents`.
  - Chunks are regenerated for each synced document so changed source text does not leave stale chunks behind.
- `public.integration_events` - Metadata-only log for sync, webhook, and reconciliation events.
  - Uses `event_key` for idempotency and stores sanitized counts/errors instead of raw payloads.
- `public.privacy_requests` - Shopify compliance webhook lifecycle records.
  - Stores topic, shop/customer identifiers, hashed contact values, processing status, deletion counts, and sanitized metadata.
- `public.data_access_events` - Service-level personal-data access audit trail.
  - Current sync paths write service events; future dashboard user views must write human access events here.

## Read Order
1. [AGENTS.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/AGENTS.md) - coding rules
2. [CLAUDE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/CLAUDE.md) - agent 
3. [APP_SCHEMA.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/APP_SCHEMA.md) - repo map
4. [SHOPIFY_PERSONAL_DATA_PROTECTION.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/SHOPIFY_PERSONAL_DATA_PROTECTION.md) - protected customer data checklist
5. [MERCHANT_DATA_USE_DISCLOSURE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/MERCHANT_DATA_USE_DISCLOSURE.md) - merchant-facing data use disclosure draft
6. [README.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/README.md) - product context and pointers

## Status

- App code: missing
- Routes: missing
- Migrations: single consolidated `001_initial_schema.sql` defines shops, customers, orders, products, shared Shopify metaobjects, knowledge context, compliance metadata, and audit tables
- Scripts: Shopify product/metaobject sync, customer sync, order sync, knowledge sync, nightly sync orchestration, and compliance webhook CLI harness added
- Script modules: Shopify sync, compliance audit, compliance webhook, persistence, config, mapper, hashing, chunking, and text-cleaning modules added or split into focused units
- Tests: Node built-in regression tests added for Supabase REST bulk payload normalization, customer consent/RFM mapping, order privacy/channel/retention mapping, nightly schedule/order, compliance/order migrations, and webhook redaction/HMAC
- Config: missing
- Compliance docs: Shopify personal data protection checklist and merchant data-use disclosure added
