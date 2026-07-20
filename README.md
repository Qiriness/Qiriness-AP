# Qiriness Customer Support OS

## Purpose

This repository will host a customer-support operating system for **Qiriness**, a French skincare and cosmetics brand. This will include an automated and agentic reply workflow as well as a dashbaord.

The first objective is to synchronise data from a Shopify development store containing dummy data into Supabase so that support workflows can later operate on a reliable operational dataset.


## Current Scope

Confirmed current scope:

- define the project foundation and documentation;
- prepare for one-way synchronisation from Shopify to Supabase;
- keep development and production environments separate;
- design for privacy-conscious handling of customer data.

Planned later scope:

- order tracking support;
- delivery issue handling;
- returns and refunds workflows;
- product and order issue handling;
- product advice support;
- payment and account question handling;
- complaints and cosmetovigilance escalation;
- AI-assisted email classification and reply drafting.

No application functionality is implemented yet in this repository.

## High-Level Architecture

Target architecture:

- **Shopify** is the source of truth for products, variants, customers, orders, fulfilments, and refunds.
- **Supabase PostgreSQL** will act as the operational database.
- Initial synchronisation will be **Shopify -> Supabase only**.
- Data flow should combine:
  - an initial import for baseline data;
  - Shopify webhooks for near-real-time updates;
  - scheduled reconciliation to detect missed or failed events.
- Important Shopify fields should be stored in structured database columns.
- Product context fields currently stored as structured product columns include Usage Instructions, Short description, Conseils d'utilisation, Actifs & ingredients, ingredients popup, and Product Ingredients.
- Predefined Shopify metaobjects, such as Product FAQ and Ingredients List entries, are stored once and referenced from products by Shopify metaobject ID.
- Product status values include Shopify's `active`, `archived`, `draft`, and `unlisted` statuses.
- Product stock is stored as one product-level `available_stock` summary, synced from Shopify variant inventory quantities when available.
- Shopify text and rich-text JSON used for AI context is normalized before storage to repair common UTF-8/Windows-1252 mojibake in French content while keeping raw Shopify payloads for traceability.
- Shopify synchronization is split into small script modules for CLI/env configuration, Shopify Admin API access, Supabase persistence, mapping, hashing, chunking, and AI-facing text cleanup.
- Customers are modeled as lean Shopify snapshots in `customers`, including contact lookup fields, email marketing subscription state, coarse default location, lifetime order count, lifetime amount spent, last-order summary, and Shopify's computed RFM group.
- Customer RFM groups are synced from Shopify `Customer.statistics.rfmGroup`, matching Shopify customer segmentation values such as `CHAMPIONS`, `LOYAL`, `ACTIVE`, `NEW`, `AT_RISK`, and `PROSPECTS`.
- Orders are modeled as lean Shopify snapshots in `orders`, including order identity, customer linkage, raw source name, merchant-facing sales channel, dashboard-facing `order_status`, source Shopify status fields, totals, line items, fulfillments, returns, refunds, and coarse/hash-based customer-adjacent fields for support lookup without duplicating raw contact or address values.
- Order retention metadata allows the local operational snapshot to be deleted 3 months after confirmed delivery, 3 months after return/refund completion, after 6 months when no delivery completion has been confirmed, or after 6 months when a return/refund remains unresolved. Shopify remains the source of truth for longer-lived order records.
- Shopify order sync upserts accessible orders into `orders`, links to local customer snapshots when present, hashes raw contact values on order rows, stores only coarse shipping destination data, and deletes rows whose `retention_delete_after` has passed.
- If an existing Supabase database has not yet added the latest order columns, the order sync can temporarily retry without the `returns` JSONB column; apply the relevant `orders` changes from `001_initial_schema.sql` to persist detailed return rows.
- Header/footer pages and policies are modeled as `knowledge_documents`, with section-level `knowledge_chunks` for retrieval. Shopify menus are used to infer whether source pages and policies are exposed in header or footer navigation when that API scope is available.
- Shopify page content is resolved through ordered, replaceable resolvers: manual override, dedicated page metafield, Shopify `Page.body`, then Shopify theme template settings. The winning content origin and attempted resolver list are stored in `source_metadata`.
- Knowledge document sync merges by Shopify source identity before regenerating chunks, so it can work against the current partial unique indexes in existing Supabase databases.
- Knowledge categories are stored as unrestricted text for now and can be restricted once the support taxonomy is finalized.
- Supabase REST bulk insert/upsert calls normalize optional row keys to `null` before sending batches, which avoids PostgREST rejecting Shopify pages where some records lack optional fields.
- Shopify protected customer data requirements are tracked in `SHOPIFY_PERSONAL_DATA_PROTECTION.md`.
- Merchant-facing Shopify data-use disclosure is drafted in `MERCHANT_DATA_USE_DISCLOSURE.md`.
- Nightly sync is handled by `scripts/sync-shopify-nightly.mjs`, intended to run once per day using `SYNC_CRON` and `SYNC_TIMEZONE` defaults of `0 2 * * *` and `Europe/London`.
- Compliance metadata is tracked in `integration_events`, `privacy_requests`, and `data_access_events`; these tables store metadata and hashes, not raw personal-data payloads.
- Shopify compliance webhook logic validates HMAC signatures, deduplicates deliveries, records privacy request state, and hard deletes customer rows for redaction requests.
- Raw Shopify API payloads should be retained only where useful and should be sanitized to avoid unnecessary personal data.
- Customer personal data should be minimised, protected, and excluded from AI prompts unless strictly required.
- AI workflows should retrieve context progressively instead of loading complete records by default.

## Main Technologies

Confirmed:

- Shopify
- Supabase
- PostgreSQL

Pending repository-level decisions:

- application runtime and language;
- backend framework;
- ORM or database client;
- job scheduling mechanism;
- webhook processing approach;
- test framework;
- deployment tooling.

## Repository Structure

See `APP_SCHEMA.md`

## Getting started

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` and add the Supabase settings.
3. Apply `supabase/migrations/001_initial_schema.sql`, then seed development data. SQL files can be applied with `npm run db:apply:migration -- supabase/migrations/001_initial_schema.sql` when `SUPABASE_DB_URL` is configured.
4. Run `npm run sync:shopify:products:dry-run` to verify Shopify product access.
5. Run `npm run sync:shopify:products` to upsert Shopify shops, products, targeted Product FAQ/Ingredients List metaobjects, and linked product metaobjects into Supabase.
6. Run `npm run sync:shopify:customers:dry-run` to verify Shopify customer access and RFM group retrieval.
7. Run `npm run sync:shopify:customers` to upsert Shopify customer snapshots into Supabase.
8. Run `npm run sync:shopify:orders:dry-run` to verify Shopify order access and retention mapping.
9. Run `npm run sync:shopify:orders` to upsert Shopify order snapshots into Supabase and remove local orders past retention.
10. Run `npm run sync:shopify:knowledge:dry-run` to verify Shopify page, policy, and menu access.
11. Run `npm run sync:shopify:knowledge` to upsert cleaned Shopify pages/policies into `knowledge_documents` and regenerate their `knowledge_chunks`.
12. Run `npm run sync:shopify:nightly:dry-run` to verify the full nightly sync order.
13. Schedule `npm run sync:shopify:nightly` with the deployment scheduler for daily overnight sync.

For Shopify Dev Dashboard apps, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` can stay blank. The sync script requests a short-lived Admin API token at runtime from `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

The knowledge sync requires Shopify Admin API access to online store pages, online store navigation, and legal policies. Required scopes are `read_content` or `read_online_store_pages` for pages, `read_online_store_navigation` for menus, and `read_legal_policies` for policies. Theme template fallback requires theme read access (`read_themes` in the app scope approval flow). If optional scopes are not granted to the app, the script skips that source and reports unresolved page content.

The customer sync requires Shopify Admin API `read_customers`. The order sync requires Shopify Admin API `read_orders`; detailed return rows require `read_returns`, and access to orders older than Shopify's default order window can require `read_all_orders` approval. The current Shopify app config includes `read_customers`, `read_orders`, and `read_returns`, but installed app scopes may need to be re-applied before tokens include newly added scopes.

The nightly sync schedule is configured for the deployment scheduler with:

- `SYNC_CRON=0 2 * * *`
- `SYNC_TIMEZONE=Europe/London`

The compliance webhook handler requires `SHOPIFY_WEBHOOK_SECRET` and validates `X-Shopify-Hmac-SHA256` against the raw request body. Until an app runtime exists, `npm run webhook:shopify:compliance -- --body-file path/to/payload.json` is a local harness that reads Shopify webhook headers from environment variables.

## Shopify Synchronisation and Webhooks

Planned synchronisation behaviour:

1. Perform an initial import from the Shopify development store into Supabase.
2. Run one scheduled Shopify -> Supabase sync overnight each day.
3. Validate webhook signatures before processing.
4. Process webhook deliveries idempotently to avoid duplicate writes.
5. Use Shopify IDs as external identifiers in Supabase records.
6. Reconcile customer snapshots during full nightly sync and delete customers no longer returned by Shopify.
7. Preserve only sanitized metadata for debugging and replay support where appropriate.

Compliance webhook business logic is implemented as reusable script modules, but a deployed HTTP route still needs to call it before Shopify production submission.

## Development Status

Current status:

- repository initialised;
- project purpose and engineering constraints documented;
- implementation stack still undecided in code;
- initial Supabase migration added for `shops`, `products`, shared Shopify metaobjects, and knowledge context tables;
- consolidated Supabase migration added for Shopify customer snapshots, email marketing subscription status, coarse location, lifetime order/spend metrics, last-order summary, and Shopify RFM group;
- order Supabase migration added for lean Shopify order snapshots with source/channel fields, status fields, totals, line items, fulfillments, returns, refunds, retention metadata, and privacy-conscious lookup fields;
- Shopify product/metaobject sync script added and refactored into focused script modules;
- Shopify customer sync script added with Shopify RFM group retrieval;
- Shopify order sync script added with channel mapping, customer linkage, privacy-conscious raw payload sanitization, retention calculation, and expired local order cleanup;
- Shopify knowledge document/chunk sync script added for pages, legal policies, and menu-derived navigation metadata;
- nightly sync orchestrator added for daily overnight sync;
- Shopify compliance webhook handler added for HMAC validation, privacy request tracking, customer redaction, and shop redaction;
- compliance metadata migration added for integration events, privacy requests, and service-level data access events;
- Node built-in regression tests added for Supabase REST bulk payload normalization, customer mapper consent/RFM behavior, nightly sync order, compliance migrations, and webhook handling;
- Shopify personal data protection checklist and merchant data-use disclosure documented;
- no application runtime, UI, or deployed webhook route committed yet.

## Next Steps

Recommended next steps:

1. Choose the implementation stack and local developer workflow.
2. Add application scaffolding with clear module boundaries that follow the script module pattern.
3. Set up Supabase development and production projects.
4. Add the remaining support database tables for messages and AI events.
5. Validate Shopify initial import for shops, customers, products, linked metaobjects, knowledge documents, and chunks against dummy development data.
6. Add application runtime routes that call the reusable compliance webhook handler and configure Shopify compliance webhook subscriptions with the deployed URL.
7. Add dashboard role policies and human personal-data access logging before exposing customer data in a UI.
8. Add deployment scheduler configuration for the nightly sync command and production observability.
9. Implement remaining external/evidence-based Shopify personal data controls: production Supabase environment separation, backup encryption evidence, merchant agreement/legal review, and production privacy copy.
10. Expand tests, linting, and type checking beyond the current Node regression coverage.
