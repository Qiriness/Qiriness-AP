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
|-- package.json       # Node scripts for Shopify/Supabase sync
|-- scripts/
|   |-- sync-shopify-products.mjs # Shopify product/metaobject sync orchestration
|   |-- sync-shopify-knowledge.mjs # Shopify page/policy sync and chunk orchestration
|   `-- lib/
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
|       |-- shopify-knowledge-client.mjs # Shopify pages, policies, and menus reader
|       |-- shopify-metaobject-mapper.mjs # Shopify metaobject row mapping
|       |-- shopify-product-mapper.mjs   # Shopify product row mapping
|       |-- shopify-shop-mapper.mjs      # Shopify shop row mapping
|       |-- shopify-sync-mappers.mjs     # mapper barrel exports
|       |-- shop-sync-service.mjs        # shared Shopify shop row upsert
|       |-- supabase-rest-client.mjs     # Supabase REST upsert client
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
        `-- 001_initial_schema.sql # consolidated initial Supabase schema
```

## Database Map

- `public.shops` - Shopify shop records, environment, app settings, and sync cursors.
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

## Read Order
1. [AGENTS.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/AGENTS.md) - coding rules
2. [CLAUDE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/CLAUDE.md) - agent 
3. [APP_SCHEMA.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/APP_SCHEMA.md) - repo map
4. [README.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/README.md) - product context and pointers

## Status

- App code: missing
- Routes: missing
- Migrations: initial `shops`, `products`, shared Shopify metaobjects, and knowledge context schema added
- Scripts: Shopify product/metaobject sync script added
- Script modules: Shopify product/metaobject sync and Shopify knowledge document/chunk sync split into focused integration, persistence, config, mapper, hashing, chunking, and text-cleaning modules
- Tests: missing
- Config: missing
