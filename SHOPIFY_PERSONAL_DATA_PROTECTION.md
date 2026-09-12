# Shopify Personal Data Protection Checklist

This file is the project policy checklist for Shopify protected customer data access. All implementation, documentation, and operational decisions that touch personal data must respect these requirements.

## Purpose

1. Process only the minimum personal data required to provide value to merchants.

2. Inform merchants about the personal data processed and the purposes for which it is processed.

3. Limit personal data use to the stated purposes.

## Consent

4. Maintain confidentiality and data protection agreements with merchants.

5. Respect and enforce customers' consent choices.

6. Respect and enforce customers' decisions to opt out of the sale of their data.

7. If personal data is used for automated decision-making and those decisions may have legal or similarly significant effects, provide a way for customers to opt out.

## Storage

8. Configure retention periods so personal data is not kept for longer than necessary.

9. Encrypt personal data at rest and in transit.

10. Encrypt personal data backups.

11. Separate test data from production data.

12. Maintain a data loss prevention strategy. Deferred for the current development phase.

## Access

13. Restrict employee access to customers' personal data.

14. Maintain strict password security requirements for employees. Dashboard passwords are enforced since 2026-09-11 (see the status table); MFA and rotation are still to decide before wider production access.

15. Maintain logs of access to personal data. Sync timestamps such as `created_at`, `updated_at`, and `synced_at` are data-change metadata only; they do not prove which human or service viewed customer data. A separate access audit log is still required once there is an application UI or user-facing data access path.

16. Maintain a security incident response policy. Deferred for the current development phase.

## Reviews and Certifications

17. Track whether the application has undergone any third-party security reviews. Deferred for the current development phase.

18. Track whether the application has received any third-party security certifications. Deferred for the current development phase.

19. Record the type and date of each security review or certification. Deferred for the current development phase.

## Current Development Scope Notes

- Items 12, 16, 17, 18, and 19 are deferred for the current development phase and should not block local Shopify development-store testing.
- Deferred does not mean complete. Do not represent deferred controls as implemented in Shopify submissions, merchant-facing documentation, or production readiness notes.
- Item 15 is not satisfied by database row timestamps. It requires an audit trail of personal-data access events when an app UI, API, or staff workflow can view customer data.

## Current Implementation Status

| Item | Status | Evidence / next action |
| --- | --- | --- |
| 1 | Implemented | Customer sync stores structured support fields and sanitized trace metadata instead of full raw customer payloads. |
| 2 | Partially implemented | `MERCHANT_DATA_USE_DISCLOSURE.md` documents data use; it still needs to be surfaced in production merchant-facing copy. |
| 3 | Partially implemented | Purpose limits are documented; future workflows must enforce them at the service/API layer. |
| 4 | Pending external | Merchant confidentiality/data protection agreements are a business/legal artifact outside this repo. |
| 5 | Partially implemented | Email marketing consent state is synced and test-covered; future marketing workflows must enforce it. |
| 6 | Implemented as not applicable | The app does not sell customer data; this is documented in merchant disclosure. |
| 7 | Implemented as not applicable | No automated decisions with legal or similarly significant effects are implemented. |
| 8 | Partially implemented, **and the order period is now a merchant setting** | Retention source of truth remains Shopify deletion/redaction and reconciliation. Order retention is `shops.order_retention_mode` — a number of months, or `indefinite`. **This shop is currently set to `indefinite`**: order snapshots are not age-deleted, and the reason is recorded in `order_retention_reason` (see `DECISIONS.md` § Retention). Raising or removing the period lengthens how long order personal data — line items, hashed contacts, masked email, coarse destination — is held, so it needs a stated business justification and, if the app declares a retention period in its Protected Customer Data settings, that declaration must match. Reading the setting fails safe: an unreadable value resolves to 6 months, never to indefinite. |
| 9 | Partially implemented | Shopify/Supabase API calls use HTTPS; Supabase at-rest encryption depends on project configuration evidence. |
| 10 | Pending external | Backup encryption depends on Supabase/project backup configuration evidence. |
| 11 | Partially implemented | `APP_ENV` and environment separation are documented; separate Supabase projects must be provisioned. |
| 12 | Deferred | Deferred for current development phase. |
| 13 | Partially implemented | RLS is enabled and service-role-only access is documented. Since 2026-09-11 the dashboard requires a Supabase Auth sign-in (`web/middleware.ts`) and has three roles; the contact team cannot open Insights → Sales. Every signed-in role can still see ticket requesters and Fulfilment's waiting-order names — narrowing that further is a role-table change in `scripts/lib/dashboard-auth.mjs`. |
| 14 | Partially implemented | Dashboard passwords are held by Supabase Auth (bcrypt), never by this app; this app adds a 12-character minimum and locks an address for 15 minutes after five failed attempts. Sessions last 12 hours, and a disabled account stops working within a minute. MFA is available in Supabase but not yet enrolled; public sign-up and the project password policy still need tightening in the Supabase dashboard. |
| 15 | Implemented for the dashboard | Sync paths and the agent write `data_access_events`; since 2026-09-11 so does the dashboard — one row per view of a surface that names customers (tickets, conversations, waiting orders, the VIP call list, the contacts CSV), with the signed-in Supabase user's id and role and counts only. |
| 16 | Deferred | Deferred for current development phase. |
| 17 | Deferred | Deferred for current development phase. |
| 18 | Deferred | Deferred for current development phase. |
| 19 | Deferred | Deferred for current development phase. |

## Agent Rules

- Do not add new personal data fields, sync scopes, prompts, logs, exports, or raw payload retention without checking this file.
- Prefer structured, minimal fields over full raw personal-data payloads.
- Do not include customer personal data in AI prompts unless it is strictly required for the specific support task.
- Treat consent, privacy requests, retention, access logs, and production/test separation as required product work, not optional cleanup.
- Mark any unimplemented checklist item as a compliance gap instead of describing it as complete.
