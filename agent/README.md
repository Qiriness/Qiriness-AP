# Agent worker

The always-on service that runs the Qiriness support-agent email workflow. See
[`../AGENT_INTEGRATION_PLAN.md`](../AGENT_INTEGRATION_PLAN.md) for the phased plan and
[`../APP_SCHEMA.md`](../APP_SCHEMA.md) for the `tickets` / `ticket_messages` schema.

Separate from `web/` (dashboard) and `scripts/` (Shopify sync); reuses `scripts/lib/*`
directly (Supabase REST client, hashing, HTML→text) rather than duplicating them.

## Status

**Phase 1 — email ingestion.** Delta-polls the Microsoft 365 support mailbox via
Microsoft Graph, threads messages into tickets by `conversationId`, and writes them to
Supabase idempotently. No AI yet — triage, categorisation, tools, and drafting are later
phases.

## Layout

```
src/
  config.mjs                 # env + tunables (reads repo-root .env.local)
  index.mjs                  # entrypoint: resolve shop, delta-poll on an interval
  lib/logger.mjs             # structured logger (no secrets/PII)
  ingestion/
    graph-client.mjs         # Microsoft Graph auth + inbox delta fetch (injectable fetch)
    graph-message-mapper.mjs # pure: raw Graph message -> ticket/message row fields
    ticket-writer.mjs        # upsert ticket by conversation + idempotent message insert
    delta-poller.mjs         # follow delta pages, persist the deltaLink cursor
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
```

The delta cursor is stored per shop in `shops.sync_cursors.mail_ingest_delta_link`, so a
restart resumes exactly where it left off — nothing is re-ingested.

## Test

```
npm test              # runs src/**/*.test.mjs (pure logic: mapper, writer, poller)
```
