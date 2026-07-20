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

14. Maintain strict password security requirements for employees. Deferred for the current development phase because access is limited to a small internal group, but this must be revisited before wider production access.

15. Maintain logs of access to personal data. Sync timestamps such as `created_at`, `updated_at`, and `synced_at` are data-change metadata only; they do not prove which human or service viewed customer data. A separate access audit log is still required once there is an application UI or user-facing data access path.

16. Maintain a security incident response policy. Deferred for the current development phase.

## Reviews and Certifications

17. Track whether the application has undergone any third-party security reviews. Deferred for the current development phase.

18. Track whether the application has received any third-party security certifications. Deferred for the current development phase.

19. Record the type and date of each security review or certification. Deferred for the current development phase.

## Current Development Scope Notes

- Items 12, 14, 16, 17, 18, and 19 are deferred for the current development phase and should not block local Shopify development-store testing.
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
| 8 | Partially implemented | Retention source of truth is Shopify deletion/redaction and reconciliation; no age-based retention job is implemented. |
| 9 | Partially implemented | Shopify/Supabase API calls use HTTPS; Supabase at-rest encryption depends on project configuration evidence. |
| 10 | Pending external | Backup encryption depends on Supabase/project backup configuration evidence. |
| 11 | Partially implemented | `APP_ENV` and environment separation are documented; separate Supabase projects must be provisioned. |
| 12 | Deferred | Deferred for current development phase. |
| 13 | Partially implemented | RLS is enabled and service-role-only access is documented; final dashboard role policies are pending. |
| 14 | Deferred | Deferred for current development phase. |
| 15 | Partially implemented | Service-level sync access events are planned/implemented through `data_access_events`; human dashboard access logging is pending. |
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
