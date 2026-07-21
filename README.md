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

- **Shopify** is the source of truth for products, variants, customers, orders, fulfilments, refunds, and discounts/promotions.
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
- Promotions are modeled as Shopify discount snapshots in `promotions`, including code-based and automatic discounts, status, summaries, usage counts, timing, combines-with flags, and `applies_once_per_customer` for manual filtering.
- Promotion sync intentionally includes active, scheduled, expired, automatic, code-based, app-generated, and referral-style discounts returned by Shopify; a full sync only deletes rows no longer returned by Shopify.
- Header/footer pages and policies are modeled as `knowledge_documents`, with section-level `knowledge_chunks` for retrieval. Shopify menus are used to infer whether source pages and policies are exposed in header or footer navigation when that API scope is available.
- Shopify page content is resolved through ordered, replaceable resolvers: manual override, dedicated page metafield, Shopify `Page.body`, then Shopify theme template settings. The winning content origin and attempted resolver list are stored in `source_metadata`.
- Knowledge document sync merges by Shopify source identity before regenerating chunks, so it can work against the current partial unique indexes in existing Supabase databases.
- Knowledge categories are stored as unrestricted text for now and can be restricted once the support taxonomy is finalized.
- Nothing auto-syncs into `knowledge_documents` — not Shopify pages, not shop policies. A lightweight, unified `shopify_content_sources` catalog (name/handle only, synced by `scripts/sync-shopify-content-catalog.mjs`) lists every live page and policy for the Agent Setup dashboard's single source dropdown; a source only becomes a `knowledge_documents` row when a team member explicitly imports it (or writes a manual article), matching PRODUCT.md's curated-library principle.
- Editing an imported article in the dashboard converts its `knowledge_documents.source_type` from `shopify_page`/`shopify_policy` to `manual` (keeping `shopify_source_id`/`handle` for provenance). That type conversion is the entire manual-edit lock — there's no separate flag, and once an article is `manual`, resync is simply unavailable for it.
- A fixed set of 7 "core topics" (order policies, brand, confidentiality, delivery, returns & exchanges, locations, FAQs) can be assigned to at most one article each per shop, for a future "is our agent's knowledge complete" checklist.
- Raw Shopify API payloads should be retained only where useful and should be sanitized to avoid unnecessary personal data.
- Customer personal data should be minimised, protected, and excluded from AI prompts unless strictly required.
- AI workflows should retrieve context progressively instead of loading complete records by default.

## Main Technologies

Confirmed:

- Shopify
- Supabase
- PostgreSQL
- Frontend: Next.js (App Router) + TypeScript + React 18 (in `web/`); styling via CSS Modules and design tokens, no UI framework
- Sync/runtime for scripts: Node ESM (repo root)

Pending repository-level decisions:

- backend framework / API layer for the dashboard;
- ORM or database client for app reads (scripts currently use `pg` + a Supabase REST client);
- job scheduling mechanism;
- webhook processing approach;
- frontend test framework;
- deployment tooling.

## Repository Structure

See `APP_SCHEMA.md`

## Getting started

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` and add the Supabase settings.
3. Apply `supabase/migrations/001_initial_schema.sql`, `supabase/migrations/002_promotions.sql`, and `supabase/migrations/003_knowledge_page_catalog.sql`, then seed development data.
4. Run `npm run sync:shopify:products:dry-run` to verify Shopify product access.
5. Run `npm run sync:shopify:products` to upsert Shopify shops, products, targeted Product FAQ/Ingredients List metaobjects, and linked product metaobjects into Supabase.
6. Run `npm run sync:shopify:customers:dry-run` to verify Shopify customer access and RFM group retrieval.
7. Run `npm run sync:shopify:customers` to upsert Shopify customer snapshots into Supabase.
8. Run `npm run sync:shopify:orders:dry-run` to verify Shopify order access and retention mapping.
9. Run `npm run sync:shopify:orders` to upsert Shopify order snapshots into Supabase and remove local orders past retention.
10. Run `npm run sync:shopify:promotions:dry-run` to verify Shopify discount/promotion access.
11. Run `npm run sync:shopify:promotions` to upsert Shopify promotion snapshots into Supabase.
12. Run `npm run sync:shopify:content-catalog:dry-run` to verify Shopify page and policy access, then `npm run sync:shopify:content-catalog` to upsert the lightweight `shopify_content_sources` catalog used by the Agent Setup dropdown. This never writes to `knowledge_documents` — see the Knowledge API note below for how articles actually get created.
13. Run `npm run sync:shopify:nightly:dry-run` to verify the full nightly sync order.

### Dashboard app (`web/`)

The frontend is a separate Next.js + TypeScript app with its own dependencies. The UI components still run on static demo data (`web/lib/demo-data.ts`), but a real Knowledge API now exists under `web/app/api/knowledge/*` — see `APP_SCHEMA.md`'s Knowledge API section for the route list.

1. `cd web`
2. `npm install`
3. Copy the repo root's Supabase and Shopify env vars into `web/.env.local` too (Next.js loads env from its own project root, not the repo root). At minimum: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (or `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`. Keep these server-only — never prefix with `NEXT_PUBLIC_`, since they're the Supabase service-role key and a Shopify Admin token.
4. Run the repo-root sync scripts (steps 1-12 above) at least once so a `shops` row and a populated `shopify_content_sources` catalog exist — the Knowledge API reads the shop by domain and 404s with a clear message if it isn't found yet.
5. `npm run dev` and open `http://localhost:3000` (redirects to `/agent-setup`).
6. `npm run build` for a production build; `npm run lint` and `npm run typecheck` for checks.

For Shopify Dev Dashboard apps, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` can stay blank. The sync script requests a short-lived Admin API token at runtime from `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

The content catalog sync and the Knowledge API's on-demand import/resync both require Shopify Admin API access to online store pages and legal policies. Required scopes are `read_content` or `read_online_store_pages` for pages and `read_legal_policies` for policies. Theme template fallback (used by the on-demand page import's resolver pipeline) requires theme read access (`read_themes` in the app scope approval flow). If optional scopes are not granted to the app, resolution for that source fails and the Knowledge API returns a clear import error.

The promotion sync requires Shopify Admin API `read_discounts`. The current Shopify app config includes `read_discounts`.


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
- frontend stack chosen and scaffolded: **Next.js (App Router) + TypeScript + React 18** in `web/`, kept separate from the root Node sync scripts;
- first dashboard surface built: the **Agent Setup** tab (`/agent-setup`) for configuring the future AI reply agent's knowledge, brand voice, and tone — production-quality UI running on static demo data (no backend wiring yet);
- Agent Setup covers a calm two-pane article workflow: knowledge library (search, status filters, create), a workspace editor with optional Shopify source-page import, and save / optimize / approve flows, with full state coverage (empty, unsaved, saving, syncing, import error/retry, optimizing, approved) and responsive + accessible behaviour;
- initial Supabase migration added for `shops`, `products`, shared Shopify metaobjects, and knowledge context tables; a follow-up migration (`003_knowledge_page_catalog.sql`) adds the unified `shopify_content_sources` catalog (pages + policies) and the Agent Setup workflow columns on `knowledge_documents` (HTML content, approval status, core topic);
- Shopify product/metaobject sync script added and refactored into focused script modules;
- Shopify customer, order, and promotion sync scripts added for support operational snapshots;
- the old separate page-catalog and policy-auto-sync scripts were unified and then the auto-sync half removed entirely: `scripts/sync-shopify-content-catalog.mjs` now syncs a lightweight catalog of both pages and policies, and nothing writes to `knowledge_documents` automatically anymore — every article there was explicitly imported or hand-written through the dashboard;
- a real Knowledge API now exists (`web/app/api/knowledge/*`) for listing the unified source catalog and creating/editing/resyncing/deleting knowledge articles, reusing the same Shopify-resolution and Supabase logic the sync scripts use. The content-catalog sync has run successfully against the real dev Shopify store and Supabase (via `npm run sync:shopify:nightly`); the Knowledge API's own on-demand import/resync paths are structurally verified (typecheck, build, curl against a missing-config error) but not yet exercised against live data, and the dashboard UI does not call it yet — it still runs on `web/lib/demo-data.ts`. The dev Supabase database was synced once under an earlier (renamed) table shape and needs re-syncing to match the current migration;
- editing an imported article converts its `source_type` to `manual`, which is what stops it from being resynced — no separate flag, no confirm-to-discard flow;
- no dashboard authentication, agent runtime, or deployed webhook route committed yet.

## Next Steps

Recommended next steps:

1. Re-run `003_knowledge_page_catalog.sql` against the dev Supabase project (it was previously applied under an earlier, renamed table shape) and exercise the Knowledge API (`web/app/api/knowledge/*`) end-to-end against the live Shopify dev store — the single-page GraphQL query it uses (`page(id: $id)` in `scripts/lib/shopify-knowledge-client.mjs`) hasn't been verified against Shopify's live schema yet, and neither has the policy import/resync path.
2. Wire `web/components/agent-setup/AgentSetup.tsx` to the Knowledge API in place of `web/lib/demo-data.ts`, keeping the existing optimistic-update UI pattern (save/optimize/approve already simulate this shape). The dropdown should distinguish pages from policies (`ShopifySourceOption.sourceType`) and show which are already imported (`isImported`).
3. Add a "core setup" checklist affordance to `ArticleLibrary` for the 7 core topics, and update `ArticleWorkspace`'s resync UI to hide/disable Resync once an article's `sourceType` is `manual` (no more 409/force flow to build — the type conversion already gates it server-side).
4. Add dashboard authentication, role policies, and human personal-data access logging before exposing any customer data in the UI.
5. Set up Supabase development and production projects.
6. Add the remaining support database tables for messages and AI events, and validate the Shopify initial import against dummy development data.
7. Add application runtime routes that call reusable webhook handlers.
8. Expand tests, linting, and type checking (the `web/` app has `lint` and `typecheck` scripts; add tests for `web/lib/server/knowledge-service.ts` and component/interaction tests for Agent Setup).
