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
|   `-- sync-shopify-products.mjs # Shopify product/metaobject sync to Supabase
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

## Read Order
1. [AGENTS.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/AGENTS.md) - coding rules
2. [CLAUDE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/CLAUDE.md) - agent 
3. [APP_SCHEMA.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/APP_SCHEMA.md) - repo map
4. [README.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/README.md) - product context and pointers

## Status

- App code: missing
- Routes: missing
- Migrations: initial `shops`, `products`, and shared Shopify metaobjects schema added
- Scripts: Shopify product/metaobject sync script added
- Tests: missing
- Config: missing
