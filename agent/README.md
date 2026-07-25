# Agent worker

The always-on service that runs the Qiriness support-agent email workflow. See
[`../AGENT_INTEGRATION_PLAN.md`](../AGENT_INTEGRATION_PLAN.md) for the phased plan and
[`../APP_SCHEMA.md`](../APP_SCHEMA.md) for the `tickets` / `ticket_messages` schema.

Separate from `web/` (dashboard) and `scripts/` (Shopify sync); reuses `scripts/lib/*`
directly (Supabase REST client, hashing, HTML→text) rather than duplicating them.

## Status

**Phase 1 — email ingestion** (verified live): delta-polls the Microsoft 365 support
mailbox via Microsoft Graph, threads messages into tickets by `conversationId`, and writes
them to Supabase idempotently.

**Phase 2 — spam gate** (blocklist verified live; LLM pass built, live run pending): a
deterministic blocklist then a cheap LLM classifier, both dropping mail *before* any write,
with every decision recorded in `spam_audit`. Categorisation, tools, and drafting are later
phases.

## Layout

```
src/
  config.mjs                 # env + tunables (reads repo-root .env.local)
  index.mjs                  # entrypoint: resolve shop, delta-poll on an interval
  lib/logger.mjs             # structured logger (no secrets/PII)
  lib/shop.mjs               # resolveShopId, shared with the CLIs
  llm/openai-client.mjs      # Chat Completions + Structured Outputs (injectable fetch)
  ingestion/
    graph-client.mjs         # Microsoft Graph auth + inbox delta fetch (injectable fetch)
    graph-message-mapper.mjs # pure: raw Graph message -> ticket/message row fields
    ticket-writer.mjs        # upsert ticket by conversation + idempotent message insert
    delta-poller.mjs         # follow delta pages, persist the deltaLink cursor
    spam-gate.mjs            # pure blocklist matcher (pass 1)
    blocklist-store.mjs      # load rules, record hits, add rule + purge stored mail
    spam-classifier.mjs      # LLM keep|spam|irrelevant (pass 2), fails open
    spam-audit.mjs           # why each email passed or failed -> spam_audit
  tools/                     # add-blocklist.mjs, reset-cursor.mjs (the CLIs below)
```

## Setup

1. Add the Microsoft Graph vars from [`.env.example`](.env.example) to the repo-root
   `.env.local` (`MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`,
   `SUPPORT_MAILBOX`). Supabase/Shopify vars are already there.
2. The Azure app registration needs `Mail.Read` (and later `Mail.Send`) **application**
   permissions with admin consent.

## Run

From this directory:

```
npm run ingest:once   # one delta poll, then exit (good for testing)
npm start             # continuous: poll every INGEST_POLL_INTERVAL_MS
npm run ingest:reset  # clear the delta cursor to force a full re-sync next run
```

The delta cursor is stored per shop in `shops.sync_cursors.mail_ingest_delta_link`, so a
restart resumes exactly where it left off — nothing is re-ingested. Wiped the tickets and
want to re-pull the whole inbox? Run `ingest:reset` first, then `ingest:once`.

## Spam blocklist

```
npm run blocklist:add -- spammer@bad.com     # block one address
npm run blocklist:add -- junk-domain.com      # block a whole domain
```

Blocked senders are dropped during ingestion (never stored), and adding a rule also purges
any of that sender's already-stored mail.

## Spam audit

Because both spam passes drop mail before anything is written, a blocked email would
otherwise leave no trace at all. Every decision the gate makes therefore writes one
`spam_audit` row: `outcome` (`kept`/`blocked`), `decided_by` (`blocklist`/`llm`), and a
one-line `reason`. A keep the classifier was not confident about is recorded as literally
`unsure`, and a keep caused by a classifier error sets `failed_open` — so a fail-safe pass
is never mistaken for a judged one.

Review the last decisions, worst-first:

```sql
select decided_at, outcome, decided_by, reason, from_email, subject
from spam_audit
where shop_id = '<shop-uuid>'
order by decided_at desc
limit 50;
```

Replies into an existing ticket are never triaged, so they produce no row — absence means
"no decision was made", not "kept". The row keeps the sender and subject (never the body)
so a wrong drop is reviewable and a repeat offender can be turned into a blocklist rule.

## Test

```
npm test              # runs src/**/*.test.mjs (pure logic: mapper, writer, poller)
```
