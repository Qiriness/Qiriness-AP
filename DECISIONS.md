# DECISIONS

Why the system is shaped the way it is. **`APP_SCHEMA.md` says where things are; this says why they are like that.**

Read the matching section **before changing the thing it describes** — most entries record a measurement against real mail or a failure mode that was hit and fixed, so re-deriving them from the code alone tends to reproduce the bug.

**This file is the index.** Each section lives in `docs/decisions/<file>`, verbatim, headings unchanged. Open only the section you need; the large ones (Investigation, Insights) are best searched rather than read whole.

**Finding a cited entry.** Code and docs cite entries as `DECISIONS.md § <heading>`. Find it with:

```sh
grep -rn "^### <heading>" docs/decisions/
```

**Adding an entry.** Append it, as a `###` with its measurement, to the section file it belongs to. A new area gets a new file and a row here.

| Section | File | Entries | ~Tokens |
| --- | --- | ---: | ---: |
| Taxonomy | `docs/decisions/taxonomy.md` | 3 | 1,109 |
| Ingestion | `docs/decisions/ingestion.md` | 14 | 5,012 |
| Spam gate | `docs/decisions/spam-gate.md` | 4 | 1,353 |
| Categorisation | `docs/decisions/categorisation.md` | 5 | 918 |
| Customer resolution | `docs/decisions/customer-resolution.md` | 2 | 941 |
| Order resolution | `docs/decisions/order-resolution.md` | 15 | 10,345 |
| Human overrides | `docs/decisions/human-overrides.md` | 1 | 1,394 |
| Investigation | `docs/decisions/investigation.md` | 123 | 59,966 |
| Forwarding | `docs/decisions/forwarding.md` | 8 | 3,205 |
| Lifecycle | `docs/decisions/lifecycle.md` | 8 | 4,550 |
| Embeddings | `docs/decisions/embeddings.md` | 4 | 1,200 |
| Exemplars | `docs/decisions/exemplars.md` | 27 | 10,084 |
| Deduplication | `docs/decisions/deduplication.md` | 11 | 5,676 |
| Cases | `docs/decisions/cases.md` | 6 | 2,864 |
| Sending | `docs/decisions/sending.md` | 3 | 2,453 |
| Drafting | `docs/decisions/drafting.md` | 23 | 11,175 |
| Knowledge | `docs/decisions/knowledge.md` | 5 | 3,461 |
| Tickets dashboard | `docs/decisions/tickets-dashboard.md` | 25 | 12,183 |
| Data handling | `docs/decisions/data-handling.md` | 9 | 3,031 |
| Orders | `docs/decisions/orders.md` | 8 | 5,780 |
| Management chat | `docs/decisions/management-chat.md` | 10 | 2,439 |
| Agent test chat | `docs/decisions/agent-test-chat.md` | 9 | 2,764 |
| Migrations | `docs/decisions/migrations.md` | 6 | 2,349 |
| Insights | `docs/decisions/insights.md` | 57 | 40,780 |
| Page speed | `docs/decisions/page-speed.md` | 4 | 2,556 |
| Interface language | `docs/decisions/interface-language.md` | 3 | 1,031 |
| Storefront advisor | `docs/decisions/storefront-advisor.md` | 40 | 16,200 |
| Social report (2026-10-09) | `docs/decisions/social-report.md` | 5 | 1,477 |
