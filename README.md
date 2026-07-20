# Qiriness Customer Support OS

## Purpose

This repository will host a customer-support operating system for **Qiriness**, a French skincare and cosmetics brand. This will include an automated and agentic reply workflow as well as a dashbaord. We are essentially copying https://www.letterbook.ai/ 

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
- Header/footer pages and policies are modeled as `knowledge_documents`, with section-level `knowledge_chunks` for retrieval. Shopify menus are used to infer whether source pages and policies are exposed in header or footer navigation when that API scope is available.
- Shopify page content is resolved through ordered, replaceable resolvers: manual override, dedicated page metafield, Shopify `Page.body`, then Shopify theme template settings. The winning content origin and attempted resolver list are stored in `source_metadata`.
- Knowledge document sync merges by Shopify source identity before regenerating chunks, so it can work against the current partial unique indexes in existing Supabase databases.
- Knowledge categories are stored as unrestricted text for now and can be restricted once the support taxonomy is finalized.
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
3. Apply `supabase/migrations/001_initial_schema.sql`, then seed development data.
4. Run `npm run sync:shopify:products:dry-run` to verify Shopify product access.
5. Run `npm run sync:shopify:products` to upsert Shopify shops, products, targeted Product FAQ/Ingredients List metaobjects, and linked product metaobjects into Supabase.
6. Run `npm run sync:shopify:knowledge:dry-run` to verify Shopify page, policy, and menu access.
7. Run `npm run sync:shopify:knowledge` to upsert cleaned Shopify pages/policies into `knowledge_documents` and regenerate their `knowledge_chunks`.

For Shopify Dev Dashboard apps, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` can stay blank. The sync script requests a short-lived Admin API token at runtime from `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

The knowledge sync requires Shopify Admin API access to online store pages, online store navigation, and legal policies. Required scopes are `read_content` or `read_online_store_pages` for pages, `read_online_store_navigation` for menus, and `read_legal_policies` for policies. Theme template fallback requires theme read access (`read_themes` in the app scope approval flow). If optional scopes are not granted to the app, the script skips that source and reports unresolved page content.


## Shopify Synchronisation and Webhooks

Planned synchronisation behaviour:

1. Perform an initial import from the Shopify development store into Supabase.
2. Subscribe to Shopify webhooks for resource updates relevant to support operations.
3. Validate webhook signatures before processing.
4. Process webhook deliveries idempotently to avoid duplicate writes.
5. Use Shopify IDs as external identifiers in Supabase records.
6. Run scheduled reconciliation to detect missed webhook events or drift.
7. Preserve raw payloads for debugging and replay support where appropriate.

This behaviour is not implemented yet in the repository.

## Development Status

Current status:

- repository initialised;
- project purpose and engineering constraints documented;
- implementation stack still undecided in code;
- initial Supabase migration added for `shops`, `products`, shared Shopify metaobjects, and knowledge context tables;
- Shopify product/metaobject sync script added and refactored into focused script modules;
- Shopify knowledge document/chunk sync script added for pages, legal policies, and menu-derived navigation metadata;
- no application runtime, UI, or webhook processing code committed yet.

## Next Steps

Recommended next steps:

1. Choose the implementation stack and local developer workflow.
2. Add application scaffolding with clear module boundaries that follow the script module pattern.
3. Set up Supabase development and production projects.
4. Add the remaining support database tables for customers, orders, messages, AI events, integration events, and privacy requests.
5. Validate Shopify initial import for shops, products, linked metaobjects, knowledge documents, and chunks against dummy development data.
6. Add webhook ingestion with signature validation and deduplication.
7. Add reconciliation jobs and observability.
8. Introduce tests, linting, and type checking with documented commands.
