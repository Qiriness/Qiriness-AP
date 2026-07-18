# AGENTS Instructions

Read `APP_SCHEMA.md` first for the current app structure and content map. Update `APP_SCHEMA.md` whenever a feature, route, shared component, or data flow changes.

## Context

This project is a customer-support operating system for **Qiriness**. Read [README.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/README.md) if context on the project is required (e.g a new chat).

## Working Rules

- Following rules apply to the whole `Qirines_email_automation` directory
- Use `APP_SCHEMA.md` as the primary source of architectural context before opening code files.
- Do not scan the full codebase by default.
- If `APP_SCHEMA.md` is not detailed enough, open only the directly relevant files, then update `APP_SCHEMA.md` if the documented structure has drifted.
- Read the README and required code (referenced in `APP_SCHEMA.md`) before making changes.
- Do not invent business requirements, database fields, API contracts, or external integrations.
- Prefer small, modular, reviewable changes.
- Update the '## Development Status' and '## Next Steps' in `README.md` when architecture, setup, or behaviour changes.
- State assumptions and unresolved questions in the implementation summary.
- Run the relevant tests, linting, and type checks before completing a task. If they do not exist yet, say so explicitly.
- Local agent skills are lcoated in `.agent\skills` folder

## Architecture Constraints

- Preserve clear separation between Shopify integration, database access, business logic, and AI workflows.
- Keep development and production environments separate.
- Treat Shopify as the source of truth for products, variants, customers, orders, fulfilments, and refunds.
- Design AI workflows to retrieve context progressively instead of loading entire records by default.
- Minimise personal data usage and exclude personal customer data from AI prompts unless it is strictly required for the task.
- Avoid placing business logic directly inside routes, webhooks, UI components, or database queries.
- Modules should communicate through well-defined interfaces and typed data contracts.
- Prefer small, focused services over large files or catch-all utility modules.
- New integrations must be replaceable without requiring major changes elsewhere in the codebase.
- Shared functionality should be reusable, but avoid premature abstraction.

## Database and Sync Rules

- Use database migrations for every schema change.
- Make all sync operations idempotent.
- Use Shopify IDs as external identifiers.
- Store important Shopify fields in structured columns when needed for querying.
- Retain raw upstream payloads as JSON when useful for debugging and traceability.
- Validate webhook signatures before processing any webhook.
- Prevent duplicate webhook processing with explicit deduplication or idempotency controls.

## Security and Data Handling

- Never expose Shopify tokens, Supabase service-role keys, or personal customer data.
- Do not place secrets in source code, logs, test fixtures, or documentation.
- Use dummy data in development and automated tests.
- Apply least-privilege access patterns wherever credentials or database roles are involved.

## Implementation Expectations

- Add error handling for external API calls, sync paths, and persistence operations.
- Prefer typed interfaces and explicit contracts between modules.
- Add useful logging for operational debugging without leaking secrets or personal data.
- Keep code paths easy to review, test, and reason about.

## Documentation Discipline

- Keep `README.md` aligned with the actual repository state.
- Do not describe planned functionality as if it already exists.
- Mark undecided technical choices as pending until they are implemented or confirmed.
