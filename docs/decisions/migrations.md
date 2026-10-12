<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Migrations

The migrations are a **baseline, not a history**: files describing the schema as it should be, run in order against an empty database. They are not idempotent and not re-runnable over a populated one.

Editing one therefore means editing the definition — re-apply against a fresh database rather than patching an existing one in place.

**That has been departed from exactly once, deliberately, and the dev database is still equivalent to a from-empty apply.** On 2026-08-15 the refactor added three views, `order_number_range()` and a check constraint; re-applying would have cost the 214 ingested tickets every measurement in this file was taken against. The additions were applied forward instead, in one transaction, with the SQL **extracted from the baseline files rather than retyped** — so what is in the database is the definition, not a second version of it. The constraint is the one statement that could not be extracted (the baseline declares it inline in `create table`) and it was applied as an `alter table … add constraint` with the same name and clause, asserted against the baseline before running. No column was added, so the column-order caveat from the 8→5 split does not arise. The script was discarded rather than checked in: a forward step living beside the baseline is precisely how a baseline turns back into a history.

**It has now happened a second time (2026-08-17), and the answer was to shrink the problem rather than to build the second axis.** Phase 5 needed two schema changes: a new table (`ticket_drafts`) and one widened check constraint (`llm_usage_pass_check`, to accept `draft`).

- **A new table needs no forward step at all.** `07_drafting.sql` creates `ticket_drafts` complete, and applying that one file to the populated project is byte-for-byte what a from-empty apply would run. Baseline and database stay identical, and the file is a normal member of the chain. **Adding a table is not a departure and should not be treated as one.**
- **The constraint is the real one**, and it was applied the same way as 2026-08-15: clause extracted from `06_analytics.sql` rather than retyped, asserted against `USAGE_PASSES` before running, dropped and re-added under the same name in one transaction, script discarded. Five existing rows, all carrying passes the wider clause still accepts.

The **reconciling test now exists**, which is the half of the two-axis arrangement that was actually load-bearing: `06_analytics.test.mjs` asserts the constraint's literals equal `USAGE_PASSES`. Two copies of that list had been drifting apart with nothing watching — the sink degrades an unrecognised pass to `other`, so a constraint widened without the module would have silently mis-filed every drafting call's cost.

So the general rule stands, narrowed to what it is actually about: **a change that alters an existing relation** wants a forward step, extracted and asserted; a change that only adds a new one is just another baseline file.

**The third alteration came the next day (2026-08-18)** — `ticket_drafts` gained a `disposition` column and its verdict check was widened to accept `needs_human`. Same method again: clauses extracted from `07_drafting.sql`, asserted before running, one transaction. Two things are worth recording because they are the first of their kind here:

- **A column was added, so the column-order caveat now does apply.** `alter table … add column` appends, while a from-empty apply of the baseline places `disposition` after `source_verdict`. Nothing in this codebase reads by ordinal — every projection names its columns, which is what `tables.mjs` exists for — so the divergence is inert. It is written down because the next person to compare a dumped schema against the baseline will otherwise think something is wrong.
- **The backfill was a decision, not a default.** The column is `not null`, and adding it with a default would have silently labelled 32 existing drafts. It was added nullable, classified from `source_verdict`, then made `not null` — so every row's disposition was chosen rather than inherited.

The additive-steps axis is still not built, and the reason is now clearer than "it has only happened three times": all three alterations were widening a constraint or adding a column to a table this project owns end to end, each applied in one transaction with the clause extracted from the file that defines it. What would justify the second axis is an alteration that cannot be expressed that way — a backfill with logic in it, or a change that has to run against a database somebody else's deploy also touches.

### Views carry joins and aggregates, never judgement

The dashboard counted messages by reading every message id in the shop; order resolution read every inbound body to keep one per ticket; the order-number range was an asc/desc pair of round trips. All three are set operations the database can answer, and PostgREST being the only interface is why they were not.

The line is the one `search_knowledge_chunks_text` already draws: vector maths and set operations in Postgres, judgement in tested JavaScript. `shouldAutoClose`, the level ratchet and the evidence rules did not move, and `ticket_queue` deliberately omits VIP — that is derived at read time from `rfm_group` and nothing stores it, so putting it in a view would make a business rule into a schema object.

### Every view is `security_invoker`

**One deliberate exception: the `chat` schema** (migration 17) — see § Management chat. It is outside the baseline, reachable by one role, and asserted by its own test.

A view created without it executes as its **owner** and reads straight past the RLS on the tables beneath. Every table in this baseline has RLS enabled with no policies precisely so that only the service role can read, which makes an owner-rights view over `tickets` the one way an anon key could read the whole support mailbox. The views also `revoke all … from anon, authenticated`, saying it a second way, and `_shared.test.mjs` asserts both on every view the baseline creates.

Each view names its output columns with an explicit `as`. Not style: an unaliased expression gets whatever name Postgres invents for it, and a caller asking PostgREST for the name it expected gets a 400.

### The baseline is now applied by a test, not only read by one

Every other assertion in `supabase/migrations/` is a regex over the `.sql` files as text. That is enough for "does this constraint list the same 14 subjects as the taxonomy module" and worth nothing for "does this view return the row we think it does" — a join can be wrong in every way and still contain the words a text assertion looks for.

`_live.test.mjs` applies the whole baseline into a throwaway schema, seeds the smallest population that can tell each projection right from wrong, asserts the output, and drops the schema in a `finally`. It makes permanent the check that proved the 8→4 split, which was run once from a terminal. **Skipped without `SUPABASE_DB_URL`**, deliberately: `npm test` has never needed a database and this must not be what changes that.

### Split by domain, not by the order things were built

The baseline was eight files that had accreted as a changelog: 05 patched 04, 07 mirrored a flag 03 created, 08 rewrote a comment 02 had written, and `tickets` was created in 01 then altered twice more. Reading it meant reconstructing each table from up to four places.

It is now **five** files along the dependency chain — foundation → Shopify snapshots → knowledge → support → exemplars — and **every table is created complete**. There is no `alter table … add column` in the baseline at all, and `_shared.test.mjs` asserts that, because a single one is the file drifting back into being a history.

**The reorganisation was proved, not reviewed.** Both sets were applied into throwaway schemas on the dev Postgres and the resulting catalogue diffed: 425 columns, 172 constraints, 152 indexes, 17 triggers, 3 functions, 20 tables with RLS, 20 table comments and 139 column comments — identical on both sides. Column *order* differs where a folded `alter` had appended a column; nothing reads columns positionally (every query names them), so that is the one intentional difference.

### `if not exists` is only on the extensions

Guarding every statement would obscure the schema these files exist to document, and a guarded statement silently does nothing when it matters most. The extensions are the exception because a Supabase project ships with them installed. `spam_audit_body_expiry_idx` carried a guard from when it landed on a populated table; in a baseline that is meaningless and it was removed.

### Tests

`_shared.test.mjs` holds what is only checkable across the whole set: no data statements, RLS on every table, a comment on every table, an `updated_at` trigger wherever that column exists, and **nothing referenced before it is created** — which is what makes the apply order safe. Each file then has a sibling asserting its own contents, with the taxonomy lists compared element-wise against `scripts/lib/support-taxonomy.mjs` and the verdicts against `case-file.mjs`, so a check constraint and the module it mirrors cannot drift apart.
