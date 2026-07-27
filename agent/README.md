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
with every decision recorded in `spam_audit`.

**Phase 3 — categorisation** (built, live run pending): a batch pass in the same poll that
fills `category` + `request_kind`, the derived `level`, and `responsible_team` on every open
ticket still uncategorised. Tools and drafting are later phases.

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
  pipeline/
    categorise.mjs           # pure: email text -> (subject, kind) + level + team
    categorise-runner.mjs    # batch pass over uncategorised tickets + Supabase store
  tools/                     # add-blocklist.mjs, reset-cursor.mjs (the CLIs below)
eval/
  categorisation-cases.mjs   # 40 labelled dummy emails: the review set
  score-categorisation.mjs   # pure scoring (3 axes + secondary), unit-tested
  run-categorisation-eval.mjs # runs the real categoriser, reports agreement
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

## Categorisation

Each poll ends with a batch pass over open tickets where `category is null` (oldest first,
25 per poll). It selects on the pending state rather than on what the poll just ingested, so
a ticket missed by a crash — or by running without `OPENAI_API_KEY` — is caught up on the
next poll with no manual step.

The categoriser classifies and nothing else: no tools, no order lookup, no database access.
Its prompt carries the ticket subject and the first + latest inbound bodies, never the
sender's address or name. The allowed values come from `scripts/lib/support-taxonomy.mjs`,
so the model picks 1-of-14 subjects plus 1-of-4 request kinds; `level` and `responsible_team`
are then *derived* from that pair, and the model can only escalate the level, never lower it.

**Level 4 is a severity judgement, not a subject.** No (subject, kind) pair derives it: it is
reserved for an explicit threat of legal action or public exposure, hospitalisation, or grave
injury/danger, so it only ever arrives as an escalation the model read in the email, and it
should be rare. The three triggers are pinned in the prompt and the model must name the one
that fired in its `reason`, so every 4 is reviewable. A reported skin reaction is a level 2
`cosmetovigilance` problem — the formulations are natural, so reactions are mild allergies or
irritations — and an RGPD request is level 3 human work.

Unlike the spam gate it does **not** fail open into a default label. A failure leaves the
ticket pending and counts the attempt in `metadata.categorisation`; after three, it is
written as `(other, problem)` → level 3, team `contact`, flagged `failed` — in front of a
human rather than silently uncategorised.

### Measuring it

```
npm run eval:categorise                    # the whole review set
npm run eval:categorise -- --repeat=3      # same input 3x: anything that moves is unstable
npm run eval:categorise -- --only=cosmeto  # one group of cases
npm run eval:categorise -- --model=gpt-4o  # compare tiers before paying for one
npm run eval:categorise -- --verbose       # print passes too, not just failures
```

`eval/categorisation-cases.mjs` is 40 labelled emails covering every subject, every
request kind, both level-4 triggers, the cases that must *not* reach level 4, two-subject
emails, an English one, and phonetic French with no punctuation. It drives the real
`createCategoriser`, so it measures the shipping prompt and schema; it writes nothing and
touches no mailbox. Cases are invented dummy data — swap in anonymised real mail when the
support mailbox is live.

Each case carries `accept` alternatives, because support mail is genuinely ambiguous (a
damaged parcel is an order problem *and* a delivery problem). Without that the score would
measure agreement with one arbitrary reading rather than correctness. The three axes are
reported separately, and level agreement is only attributed where the pair was right — a
wrong level on a wrong pair is a consequence, not a second failure.

Last measured (`gpt-4o-mini`): subject 39/40, kind 40/40, level 39/40, ~9s and well under a
cent per run. Treat this set as a **regression guard only** — it was written by the same
author as the prompt, so a high score proves consistency, not accuracy. The real measurement
is the human-labelled set below.

### Human review set on real mail

The synthetic set measures the prompt against the taxonomy. To measure it against real
customers, sample the live mailbox and label the sample by hand:

```
npm run review:sample -- --mailbox=contact@qiriness.com            # 40 emails, 3 months
npm run review:sample -- --mailbox=... --dry-run --count=5         # look first, write nothing
npm run review:compare                                             # after labelling
```

`sample-mailbox.mjs` is **strictly read-only on the mailbox** — every Graph call is a GET,
nothing is sent, moved, flagged or deleted, and reading over Graph does not mark a message
as read. It deliberately avoids the delta endpoint, so sampling cannot disturb the ingestion
cursor, and it writes no tickets. `--mailbox` overrides `SUPPORT_MAILBOX` for the run,
because sampling a mailbox is not the same decision as pointing the worker at it.

Last measured on 30 hand-labelled emails: **subject 77% · kind 90% · level 73%** (from
67/70/60 before the first comparison). Every boundary rule in the prompt — dispatch splits
order from delivery, `complaint` only when nothing actionable is asked, `contact` only for a
first approach, level 3 only when something must change — exists because this set disagreed
with the previous rule. Two boundaries are still unsettled and show up as most of the
remaining error: order vs delivery mid-thread (the email often does not say whether the
parcel shipped), and whether a pure status chase is level 2 or 3.

Rows land in `categorisation_review` with `human_category` / `human_request_kind` /
`human_level` empty, and the `agent_*` columns empty too. That second part is deliberate:
the reviewer labels **blind**, and `review:compare` runs the categoriser afterwards, writes
its answer back, and reports agreement per axis. Leaving `human_level` null scores the level
derived from your (category, kind) pair, so it only needs filling to record an escalation.

### Review what it decided

```sql
select category, request_kind, secondary_category, level, responsible_team,
       metadata->'categorisation'->>'reason' as reason,
       metadata->'categorisation'->>'failed' as failed
from tickets
where shop_id = '<shop-uuid>' and category is not null
order by last_message_at desc
limit 50;
```

## Test

```
npm test              # runs src/**/*.test.mjs (pure logic: mapper, writer, poller, categoriser)
```
