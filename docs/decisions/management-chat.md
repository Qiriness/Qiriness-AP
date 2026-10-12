<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Management chat

Home's chat (2026-09-14): management asks a question, a model answers it by writing SQL against the live database. `scripts/lib/chat-*.mjs`, `web/lib/server/chat-service.ts`, `web/components/chat/`, migration 17.

### SQL, not retrieval, and one tool

The questions are about structured data — revenue by channel, shipping time by month, tickets per category — so the model writes queries rather than reading embedded documents: a similarity search cannot sum a column. One generic tool, `execute_sql`, rather than a tool per metric, because a tool per metric is a panel per metric, and the Insights panels already exist for the questions somebody thought of in advance. No framework: the loop is the investigation's shape again (the transport does one round trip; budget and dispatch live in a tested module).

### The boundary is a database role, not the prompt and not the parser

`mgmt_chat_ro` has `USAGE` on `chat`, `SELECT` on its views, and `EXECUTE` on one pure function. It has no grant in `public`, `auth` or anywhere else, and **nothing in `public` it could call runs with elevated rights** (checked 2026-09-14: no `security definer` function is executable by `PUBLIC`, and only `pg_catalog` / `information_schema` grant schema usage to everyone). Each query also runs in `begin read only` with `set local statement_timeout` and is rolled back, and is sent as `select * from (<query>) limit 1001`, which Postgres cannot parse with a second statement or a data-modifying CTE inside.

`chat-sql-guard.mjs` sits in front and is **not** the boundary. It exists so a refusal is a sentence the model can act on ("only the chat schema") rather than a permission error it retries. Two things it blocks are worth knowing: `set_config()` (could lift the timeout for the rest of the transaction) and `*_to_xml()` (runs a query given as text). A read-only *default* on the role is not a privilege — a session can change it — which is why every write is also simply ungranted.

**Verified against the database, not only in tests** (2026-09-14, as the role inside a rolled-back transaction): all 13 `chat` views read; `public.tickets`, `public.customers.email`, `auth.users`, `vip_customers()`, an insert into `chat_turns`, an update through `chat.shop` and `create table` in either schema are all refused; a 2 s timeout stops `pg_sleep(5)`. `set role postgres` could not be tested that way — `SET ROLE` checks the *session* user, so from a borrowed role it succeeds and proves nothing — and was checked through a real `mgmt_chat_ro` login instead, once the password existed: `permission denied to set role "postgres"`.

### Owner-rights views, the one exception to `security_invoker`

Every table has RLS on with no policies, so a role that does not bypass RLS reads **zero rows** through an invoker view. The alternatives were a `SELECT` policy per table for the role (thirty policies, and a policy exposes every column — the personal ones included) or owner-rights views. The rule exists to stop the anon key reading past RLS; nobody but `mgmt_chat_ro` holds any privilege on `chat`, PostgREST does not expose it, and `17_management_chat.test.mjs` asserts the revokes. The views are the column allow-list, which a policy cannot be.

**A chat view reads tables, never a baseline view** — learned by it failing. The first version wrapped `order_fulfilment_timing`, `ticket_reply_times` and `ticket_message_counts`, and all three answered "permission denied" on the live database: a `security_invoker` view nested inside an owner-rights one checks its tables as the *querying* role. They now read the tables, return the same rows and medians as the views they replace (169 reply-time rows, p50 74.3 h; fulfilment p50 34.2 h), and a test forbids a chat view from reading any baseline view and asserts the fulfilment lateral is 06's, character for character. The copy is not quite verbatim on purpose: 06 reads the destination as `shipping_destination ->> 'countryCode'`, a key no stored order has (the mapper writes `country_code`), so its country column is null on every row; the chat copy reads the real key and finds it on 6,007 of 6,008 orders. 06 itself is unchanged.

Another consequence: **a view checks table access as its owner, but a function call as the querying role.** `order_fulfilment_timing` calls `normalise_carrier()`, hence the one `EXECUTE` grant — and `vip_customers()` reads tables, so a chat view cannot call it either.

**VIP status is reached through one security-definer function** (migration 21, 2026-09-14, because management asked for it). `chat.vip_customer_rows()` runs as its owner, takes **no arguments**, fixes its `search_path`, and calls `vip_customers()` with the shop's own thresholds and the marketplace handles `vipArgs` excludes; `chat.vip_customers` reads it and returns ids with windowed orders and net spend. The alternative was copying the rule's SQL into an owner-rights view like the three above, and that was rejected for this one case: those copies are of *measurements*, this is *the business rule*, and two definitions of who is a VIP is exactly what centralising it in `vip_customers()` ended. A definer function is only as safe as what can be passed to it, which is why it takes nothing. The handles are a SQL literal, asserted against `ALL_MARKETPLACE_HANDLES` by `21_chat_vip.test.mjs`. Status is current only — who *was* a VIP last quarter cannot be answered, because the rule is evaluated against now.

### Aggregates only

Results go to OpenAI, and `AGENTS.md` keeps personal data out of prompts unless a task strictly needs it. Management questions do not. So the views select no name, email, phone, address below country, ticket subject or message text (the owner's call, 2026-09-14), and the test holds a list of those columns that no view may select. The cost is explicit: "who are our ten best customers" is answered with ids and totals, or with "not available here". Because no view names a customer, the chat writes no `data_access_events` row.

### What the model is shown of a result is not the result

A query may return 1,000 rows (1,001 fetched, to know when it was cut). The model reads at most 200, each cell clipped to 300 characters, the whole under 16,000 characters — with a note when rows were held back, and a louder one when the query hit the cap, because a total over a truncated result is wrong and a model will add the rows up unless told. The screen gets the rows (preview 200); `chat_queries` keeps 50, enough to reopen an answer and see what it rested on.

### Follow-ups replay the SQL, never the rows

A follow-up ("and last year?") needs to know how the last figure was computed, and the query says it exactly. Replaying rows would make every later step pay for them and invite the model to answer from memory instead of querying again. Ten turns of history at most.

### "Never invent a figure" is a prompt rule plus a visible trail

The prompt forbids any number not in a result of this conversation and prefers "the database does not hold this" to an estimate, and the last step is forced to answer from what it has. A mechanical check that every number in the answer appears in a result was considered and not built: percentages, rounding and derived ratios make it refuse correct answers. What stands behind the rule instead is **"How this was answered"** under every answer — each query, its SQL and its rows — and the prompt carries the data's known traps (marketplace buyers minted per order, `customers` as a snapshot, no delivery data, the moving start of the mail sync) so the model does not walk into them.

### Spend is logged on the turn, not in `llm_usage`

Same reasoning as the test chat: `llm_usage` answers what handling the mailbox costs, and its `pass` constraint admits the worker's passes only. Tokens live on `chat_turns` and are priced at read time from `llm-rates.mjs`, and the page shows the open conversation's running total under the question box. `gpt-5.2` is priced from OpenAI's published Standard rates (2026-09-14) **including its cached-input rate** — `estimateCost` gained `cachedInputTokens` for it, because in the first real run 75–95% of the chat's input was cached, and billing that at the full rate would have overstated the cost several times over. Models without a `cachedInput` rate are priced exactly as before. A turn whose model has no rate is shown as "not priced", never as $0. A turn that fails outright records no tokens, so the total can undercount a conversation with errors.

### A reasoning model by default

`CHAT_MODEL` defaults to `gpt-5.2`: a question is a one-off, so the larger model is worth it (the owner's call). Reasoning models refuse `temperature` and `max_tokens`, so `openai-client.mjs` sends them `max_completion_tokens` instead (`isReasoningModel`). Every worker model is on the older shape and unaffected. The key and its 30k TPM limit are shared with the worker — a hard question can take tens of thousands of tokens, so a separate key is the fix if the two collide.

### The password is set by hand, once

A secret has no place in a checked-in migration, so the role is created without one and cannot log in until it is given one. In the Supabase SQL editor:

```sql
alter role mgmt_chat_ro with password '<a long random password>';
```

Then in the repo-root `.env.local`, the session pooler URL with the role as user:

```
CHAT_DB_URL=postgresql://mgmt_chat_ro.<project-ref>:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres
```

Until both exist, `/home` says the chat is not set up and runs nothing.
