# VALIDATION LOG

Things that are **built and tested, but not yet proven against real data**.

This existed because the Shopify store behind Supabase was a dev fixture, not a
copy of the business: 16 products, 3 discounts, 12 orders numbered `#1001`-`#1012`
and 15 customers, while the support mail is from the live inbox and references
orders like `#4854`, `#6216` and `Q00 26200111`. Unit tests proved the logic;
they could not prove assumptions about data that did not exist here.

**That premise no longer holds, and neither does the follow-on claim that the
passes had not run.** Re-measured **2026-08-17**, read from the database:

| Table | Rows | Note |
|---|---|---|
| `orders` | 2052 | `#4716`–`#6770`, which **contains** every order the corpus quotes |
| `customers` | 58 201 | was 15 |
| `products` | 116 | was 16 |
| `promotions` | 327 | was 3 |
| `tickets` | 214 | **145** carry a `customer_id`; **52** carry a confirmed `shopify_order_number` and a populated `resolved_context` |
| `ticket_messages` | 451 | all 451 embedded |
| `ticket_investigations` | 80 tickets | 49 `needs_human` · 16 `needs_customer_input` · 15 `answerable` |

**`orders:resolve` and `context:build` have both run.** Outcomes across the 203
categorised tickets: confirmed **52** · no_candidate **138** · mismatch **8** ·
not_found **4** · name_match **1**. The 138 quote no order reference and their
sender matches no order — the resolver's designed answer, not an unrun pass. Any
item below that reads as "blocked until the resolver runs" is stale; what remains
is judging what it produced.

**The investigation has not caught up with it, and it cannot:** only **23 of the
52** resolved tickets carry a case file. The other **29 are closed**, and a closed
ticket is unreachable by both `claim` and `raiseFor` — see item 16. Conversely, 29
of the 52 investigated order-family tickets were read *before* they had an order
number, so their case files are weaker than the data now allows. **Do not read
`--backfill` as the fix**; it reaches 9 already-investigated tickets and none of
these.

**Three tables are empty where entries below assume rows**, and each is recorded
as its own item: `llm_usage` (item 14), `categorisation_review` (item 15), and
`category_forwarding` / `ticket_forwards` (item 1).

## 28. The agent reads the whole thread now, and no draft has been re-read since — 2026-09-21

`record.conversation` and the two widened projections ship today: the
investigation renders both directions as a labelled transcript, and drafting is
shown our own previous replies above the new message. Unit tests pin the
behaviour (1,501 agent, 3,016 root, all green) and the reads were verified
against the live database — ticket `8236165a`, 8 messages, both directions, the
prompt's sections in the right order and the trigger message printed once.

**What is proven:** the rows arrive, the transcript renders, and a
single-message ticket's prompt is byte-for-byte what it was before.

**What is not proven is the only thing that matters: whether the drafts get
better.** Nothing has been re-investigated or re-drafted. The comparison is
cheap and it has not been run.

**The set.** 25 tickets carry ≥2 inbound messages **and** ≥1 outbound; 24 have a
case file and 19 have a draft. Their pre-change state — verdict, checks, draft
body — is snapshotted, because `ticket_drafts` upserts on
`(shop_id, trigger_message_id)` and a re-draft **overwrites `body_text` in
place**. Snapshot taken 2026-09-21, 25 rows, in the session scratchpad; it is
not in the repo because it is real customer mail.

**The drafting half HAS been re-run and read.** All 19 drafts changed;
`checks_passed` went 14 → 12 of 19, and that number is **noise** — `718086fd`
passed on one run and failed on the next with identical code. Register drift is
1 of 19 for a French closer in a Spanish reply and 1 of 19 for a lost title
salutation. Continuity improved on the threads read by hand. Full account in
`DECISIONS.md` § *What the thread in the prompt is actually worth, measured*.

**Reviewed 2026-09-21 and judged good**, from `phase1-drafts-review.html` — the
19 pairs side by side with each thread and its failing checks. The verdict was
given as an overall reading rather than a per-symptom tally, **so no counts are
recorded here and none should be quoted.** What that closes is the question
"does the thread in the prompt make the replies better"; what it does not close
is the two known slips below, which were accepted rather than fixed.

**Accepted, not resolved — carry these into the next phase:**

1. ~~**A promise we made that the rules forbid repeating.**~~ **RESOLVED
   2026-09-22** by a business decision: a delivery date is given only as an
   expectation (« devrait arriver »), never as a certainty. The draft on
   `5232645f` was already hedged; the check was wrong, not the draft. See
   `DECISIONS.md` § *A delivery date is what should happen, never what will*.
2. **Language and register follow the history.** `718086fd` ends a Spanish reply
   with the French closer. Stripping the approved sign-off fixed it on one run
   and not on the next, so the residue is the prose itself.

**The investigation half has NOT been re-run**, and could not be — see below.

### The blocker: `--backfill` cannot reach a closed ticket, and `--include-closed` does not help

`raiseFor` hard-codes `status: 'open'` in its filter
(`scripts/lib/ticket-record.mjs`), so **no CLI path raises
`needs_investigation` on a closed thread.** `investigate --include-closed`
widens the *claim* — for tickets whose flag is already up, which is the case
auto-close leaves behind — but it cannot widen the *raise*. `tickets:requeue`
refuses outright: « not queued: ticket is not open (pass --reopen) ».

So the two documented halves do not compose for the case here: a thread that is
closed **and** unflagged. Of the 25, **0 are open**, and every one was dry-run
requeued and refused.

`--reopen` would do it and is the wrong tool: it moves 25 settled threads into
the live queue, against « a widened run never moves a ticket ».

**What this leaves unmeasured:** the labelled transcript reaching the
investigation. Verified structurally against the live database (ticket
`8236165a`, 8 messages both directions, correct order, trigger once) and by unit
test, but no case file has been rebuilt from it.

**Options, for whoever picks this up:** give `raiseFor` the `anyStatus` escape
`claim` already has, reachable only by pairing `--backfill` with
`--include-closed` — which is arguably the bug, since the CLI header documents
those two as "the other half" of each other; or accept `--reopen` on a named
list and set the statuses back afterwards.

**That count is what decides the next phase**, and it is the reason the Case
Manager, the persistent case state and the sticky situation were NOT built at
the same time as this. If the thread in the prompt closes most of these, the
remaining layer is much smaller than the one originally specified.

**Cost, stated because it is the reason this has not been run yet:** roughly 25
× (1 decompose + 2 investigation + 1 drafting) model calls, against an account
capped at 30,000 tokens/minute — expect the run to be paced by 429 backoff
rather than by the work.

## 27. D-37 and its three rules are drafts, and nothing has matched them live (2026-09-21)

**Proven:** D-37 is **approved, translated and embedded** (2026-09-21), and the live matcher picks it: re-running `match_support_exemplars` over the stored message vectors of all **169 tickets that carry one**, exactly two match D-37 — `bb82f4f1` at **0.777** (margin 0.197 over D-36) and `de880691` at **0.694** (margin 0.099), both previously `near` and matching nothing. **No other ticket changed situation.** The exemplar imports clean (41 parsed, 41 usable, 0 skipped, 0 stale phrasings) and its six phrasings separate the situation exactly — scored against the stored message vectors of all 43 `delivery` tickets, **only `bb82f4f1` (0.777) and `de880691` (0.694) clear the 0.65 floor**, and the next ticket is 0.630. All 18 evidence positions were run through `selectAnswer` with `D-37` matched: the three rules take the positions they were written for, `auditAnswerSet` reports nothing on the `orders` set, and D-01, D-03, D-05, D-36 and the situation-less lane are unchanged. 3008 tests pass.

**Not proven, and the checks:**

- ~~**Everything is `draft`.**~~ — CLEARED 2026-09-21: exemplar and all three rules approved, 30 phrasings embedded (6 authored + 24 translated). `DRAFT_ONLY` is unset, so `draftOnly` is true and no reply sends itself — a person still releases every draft.
- ~~**Re-run the two anchor tickets.**~~ — PROVEN 2026-09-21 through `match_support_exemplars` itself, figures above. **Still to watch: the reply.** Neither ticket has been re-investigated, so no draft written by these rules has been read. `bb82f4f1` is `delivery_state: dispatched_no_scan` today and should select `d37_perte_colis_sans_scan`.
- **The three skeletons have still never been read by the person who owns the voice.** They were written here and approved without that reading — particularly the concession in `d37_commande_non_identifiee` that the carrier's parcel number will do instead of an order number. Read them on `/agent-setup/rules`; a rule edited there returns to `draft` and needs re-approving.
- **The 24 translations were approved unread.** `gpt-4o` wrote `en es it de` for all six phrasings and they went into the table and into vectors in the same pass. They are now matchable against real foreign mail. Skim the diff in `Email-Example-Queries.translations.json`.
- **`delivery_state: not_dispatched` is an open hole.** Under D-37 it falls to the shared `non_expediee` rule, which routes nowhere and answers « la commande n'est pas encore expédiée » to somebody holding a loss notice. No rule covers it yet — decide the wording, or accept that it can only happen on a mis-linked order.
- **`d37_perte_colis_avec_scan` is half dormant.** `delivered` is reachable (131 of 6 043 orders, latest 2026-07-30); `in_transit` and `stale_in_transit` are not — the newest scan of any kind in the estate is 2026-01-20 and every scanned parcel also carries a `delivered_at`. Only the `delivered` branch can be watched today.
- **No translations.** `npm run translate:exemplars` has not been re-run, so D-37's six phrasings are French only while every other exemplar carries `en es it de`. A German or Italian customer writing about a lost parcel matches nothing here.

## 26. The late-delivery rule is a draft, and no customer has been answered by it (2026-09-20)

**Proven:** `delivery_delay_state` resolves on real bundles — **23 overdue / 39 within window / 4 unknown** over the 66 tickets carrying a `resolved_context`, after `context:build --refresh` and with both windows set (`france_delivery_days` 3, `abroad_delivery_days` 6). `selectAnswer` picks `dispatched_no_scan_delivery_late` on O-09, D-01 and on no situation at all, and still picks `expediee_sans_scan` on the in-window and `unknown` cases; `auditAnswerSet` reports zero problems on the `orders` set. Unit tests cover both windows, Monaco, a missing country, a missing parameter per destination, a bundle with no `dispatchedAt`, and both ends of the journey.

**Not proven, and the checks:**

- **The rule is `draft`.** Nothing routes on it until somebody reads the French skeleton and puts it live in the rulebook. Until then every late parcel still gets `expediee_sans_scan`.
- **The wording has never been read by the person who owns the voice.** The skeleton was written here, not by the operator — unlike `expedition_en_retard`, which it is modelled on. Read it before approving.
- **Is 6 working days right for abroad?** It is the number that was asked for, not one measured: nothing in the database records when a parcel actually arrived, which is the whole reason this state exists. Belgium at 58 orders is the only destination with enough volume to ever check it, and only once a carrier feed exists.
- **Monaco is on the abroad number** (4 orders). One line in `deliveryDelayState` if that is wrong.
- **No live ticket has selected it.** Watch the first few: confirm the draft reply does not claim a scan, does not promise a date, and quotes a tracking number only when the dossier holds one.
- **The clock change reaches more than this rule.** `dispatch_state`, `delivery_state` and `return_eligibility` are now derived against the ticket's latest inbound message too. `dispatch_state` read 44 overdue / 22 within window on that clock; nobody has checked a handful of those against the actual mail.

## 25. The management chat has run on real data, but never through its own login (2026-09-14)

**Proven:** the role's boundary (views read; `public`, `auth`, writes, DDL refused; timeout fires) and four end-to-end questions whose figures matched independent SQL exactly — all with `mgmt_chat_ro` *borrowed* from a `postgres` session inside rolled-back transactions, because the role has no password yet. See CHANGELOG and `DECISIONS.md § Management chat`.

**Not proven, and the checks:**

- ~~**A real login through the Supavisor session pooler.**~~ — PROVEN 2026-09-14. Password set and `CHAT_DB_URL` written by script (never printed); logged in as `mgmt_chat_ro` through the pooler: `session_user = mgmt_chat_ro`, `transaction_read_only = on`, `statement_timeout = 10s`, `chat.orders` reads 6,008 rows.
- ~~**`set role postgres` is refused to that login.**~~ — PROVEN the same day: `permission denied to set role "postgres"`; `public.tickets` refused; `create table` refused as read-only.
- **The page itself** — streaming steps, "How this was answered", reopening a conversation, a follow-up, the step-limit and error states — has not been used in a browser with the chat enabled.
- **Role gating in the browser:** signed in as `contact`, Home is not in the sidebar and `/home` redirects.
- **Answer quality beyond four questions.** Ask 10 real management questions whose answers are already on an Insights panel and compare. Watch for per-customer figures that did not exclude marketplace channels, and revenue definitions that silently change between turns.
- **`gpt-5.2` cost** is now priced (list rates, cached input included) and totalled per conversation under the composer. Not yet compared with the OpenAI usage dashboard for the same day — do that once, since the figure is list price, not the invoice. Also check the 30k TPM key is not starved when the worker runs at the same time.

## 24. The Orders page's ticket ring: data present, colours not yet compared by eye (2026-09-14)

The list, filters, pager and detail page run against the live table (CHANGELOG, Orders page). **Correction, same day:** this item first said 0 tickets carried `shopify_order_number`. That was a bug in the probe (a raw `not.is.null` string, which the REST client sends as `eq.not.is.null` and so matches nothing). Re-read correctly: **58 of 172 tickets carry one**, resolved 2026-09-13 23:23 — `confirmed 58 · no_candidate 96 · mismatch 11 · name_match 2 · not_found 2 · no trail 3`. Stored names are `#6892`-shaped, which is what `orderNumberKey` expects.

**Check still open:** on an order with an open ticket, confirm (a) the customer name is ringed, (b) the colour matches the ticket's bar on `/tickets`, (c) closing the ticket removes the ring on reload, and (d) the order's detail page lists the ticket.

## 23. Sign-in is built and tested with throwaway accounts only (2026-09-11)

The flow was proven end to end over HTTP against Supabase Auth with scripted accounts that were deleted afterwards (CHANGELOG, "Sign-in through Supabase Auth…"). Not yet seen:

- **A real account.** None exists in Supabase Auth; create them with `npm run users -- add --email … --role developer|management|contact` and sign in once per role in a browser.
- **Public sign-up is still enabled** on the Supabase project (`disable_signup: false`, read from `/auth/v1/settings` on 2026-09-11). An account made that way gets no `dashboard_role` and is refused at sign-in — proven in the checks — but the setting should still be turned off in the Supabase dashboard, and the minimum password length raised to 12 to match `dashboard-passwords.mjs`.
- **The twelve-hour session limit, and the token refresh at the hour mark.** The unit tests cover both from the clock's side; neither has been watched on a real day-long session.
- **The `Secure` cookie flag.** Set only when `NODE_ENV=production`, i.e. under `next start` behind HTTPS. Dev runs over plain HTTP without it. Check the Set-Cookie header on the first deployed sign-in.
- **The lockout across a restart.** Failed-attempt counts are in memory; a restart clears them. Expected, but not exercised.
- **MFA.** Supabase supports TOTP factors; nothing in this app enrolls or checks them yet.

## 22. The VIP rule is built and unset (2026-09-11)

Nobody is a VIP until the owner saves a rule on the Customers panel. Two checks once they do:

- **The gold border's share of the queue.** The RFM rule put 75 of 214 tickets (35%) in gold, and DECISIONS § Tickets dashboard says to turn the tokens down rather than the feature off if it ever pulls attention from a level 4. **Check:** after saving, count gold rows against the open queue.
- **The agent's `isVip`.** The lookup now asks `vip_customers()`; no investigation has run since. **Check:** run one ticket from a known VIP through `npm run investigate -- --ticket <id>` and confirm the case file's customer details say `isVip: true`.

## 21. Ranged Insights: six edges not yet seen in production (2026-09-11)

Built and tested against the live database; these are the parts a test could not reach.

- **The shop timezone is still null.** The nightly sync that ran today used the old `mapShop`. Until a sync runs the new one, days are cut in UTC and the strip says so. **Check:** after the next sync, `select iana_timezone from shops` reads `Europe/Paris` and the "Days cut in UTC" chip is gone.
- **The mail cursor should now survive a Shopify sync.** **Check:** after the next manual mail poll *and* the following nightly sync, `shops.sync_cursors` still holds `mail_ingest_delta_link`, and the poll after that pages from the cursor rather than re-enumerating.
- **A daylight-saving boundary has not been crossed.** The conversion is Postgres's and the live test covers a summer midnight, but no chart has yet spanned the 25 October change. **Check:** on "Last 7 days" in late October, the change day has one bar and orders at 02:30 land on the right day.
- **"Last 24 hours" is mostly unsynced for orders** while the order sync is nightly — drawn hatched, correctly, but worth deciding whether that preset should exist for orders before a faster sync does.
- **Churn and capture rest on the consent snapshot.** Both are floors by construction, and the churn denominator is reconstructed. **Check:** export the Shopify customer events for one month and compare its unsubscribes and list size with the card; the gap is the size of the floor.
- **New vs returning differs from the reference tool** (102 / 102 against its 108 / 99 on the same 30 days). Ours counts "no earlier order since May 2024". **Check:** pick three customers the two disagree on and read their Shopify history.

## 20. ~~The translated library is written but unproven~~ — RESOLVED 2026-09-09, end to end (built 2026-09-09)

562 translations over 140 phrasings, generated, imported, embedded and measured
the same day. See `CHANGELOG.md` 2026-09-09 and `DECISIONS.md` § "Translate the
library, not the query".

**Every check this item asked for has been run.**

- **Imported.** `support_exemplar_phrasings` holds **706** rows — 702 from the
  document plus P-21's 4, dashboard-authored and correctly untouched. Approval
  unchanged at 38, 0 stale rows removed.
- **The language column tells the truth.** It read `fr` on all 144 rows before,
  including the eleven that are not French. It now reads en 6 / es 3 / nl 2 on
  the authored variants, and the target language on all 562 translations.
- **The forward step is applied, before the embeddings.** The multiplier is
  **64** in the database. The SQL was extracted from `05_exemplars.sql` rather
  than retyped, asserted to be one `create or replace function` carrying no
  `drop`/`truncate`/`alter table` and a multiplier above the 60-row ceiling, and
  applied through `db:apply:migration`. The script was discarded.
- **Embedded: 696 of 706.** The 10 without a vector are O-11's, which is
  soft-deleted — the reconciler excludes deleted exemplars deliberately. D-33 is
  the largest exemplar at 40 embedded phrasings, inside 64.
- **Measured on a same-corpus A/B**, since the historical figures were taken over
  214 tickets and the corpus is 328. `--authored-only` scores the French library
  alone: **125 → 133 tickets clear MATCHED**, Italian 0 → 4 of 6 on a +0.132
  median, English +0.032 and no band movement, Spanish unchanged and winning
  nothing with a translation because it already carries real Spanish phrasings.
- **The prediction was 14 tickets and ~7%. The answer is 8 and 6.4%** — recorded
  as the smaller number.
- **Confirmed against the live RPC**, which is what the eval could not do:
  12 non-French tickets through `match_support_exemplars()`, **3 exemplars
  returned on 12 of 12**, none starved.
- Tests: 2061 root, 1299 agent, typecheck and lint clean.

**Two findings this closed out, both recorded rather than silently fixed:**

1. **The eval scored 38 exemplars where the RPC scores 37** — `deleted_at` was
   filtered on tickets and not on exemplars. Fixed. It changed no per-language
   median, because O-11's phrasings sit verbatim under O-09 which absorbed them;
   only the overall median moves 0.626 → 0.627.
2. **O-11 is merged away but still in `Email-Example-Queries.md`.** The importer
   re-creates it on every run and the translator paid to translate it 8 times,
   for a situation that can never be retrieved. Inert, not broken.

**What is left, and none of it blocks anything.**

- **Delete O-11 from the document**, or accept an exemplar that is re-created and
  re-translated on every import and can never win.
- **P-21 is never translated.** It exists only in the database, so the
  translator — which reads the document — cannot see it. Either write it into
  `Email-Example-Queries.md` or accept one French-only approved situation.
- **~130 of the translations are unread.** Four sources were spot-checked across
  all four targets; the rest were not. The register rule fails quietly — a
  translation that tidies « jai pas recu ma commande » into correct English
  rebuilds the mismatch the variants exist to remove, and it looks fine to a
  reviewer skimming for meaning. A 240 KB diff, and a reading job for whoever
  reads the target language.
- **The bands were calibrated on the French-only library.** `MATCHED` 0.65 and
  `NEAR` 0.55 predate 562 rows landing in the pool, and the score distribution
  has shifted under them. Worth re-reading the sweep in section 2 of
  `eval:exemplars` before trusting the bands on non-French mail.

## 20. Page-speed changes are built and unit-tested, and not yet seen working — 2026-09-18

See `CHANGELOG.md` (2026-09-18) and `DECISIONS.md` § Page speed. What was proven: `npm test` (2,872), `tsc`, lint; and, read-only against the live database, that the rewritten `insights_customer_mix` returns exactly what the live one does over 60 range × platform combinations and runs in 68–118 ms on a generic plan. What was not:

- ~~**Migration 30 is not applied.**~~ **Applied and checked 2026-09-18**: a snapshot of the old function over all 60 range × platform combinations, taken just before applying, matched the new function exactly (0 differences); a direct call takes 69–76 / 103–108 / 116–125 ms for six months / one year / all time.
- **Nothing has been opened in a browser.** Check: click Tickets → Orders → Agent Setup → Insights in the sidebar; each click should light the item at once and dim the page under "Loading …". Ctrl-click should still open a new tab. On Orders, type in the search box and change a filter: the text must survive.
- **End-to-end timing is unmeasured.** Check: `PAGE_TIMING=1`, a production build (`npm run build && npm run start`, dev server stopped first), then Insights → Sales at 6 months, 1 year and all time, and Tickets → Orders. Record the `[timing]` lines here.

## 19. The Attachments block is rendered and seen; four of its states are not (built 2026-09-09)

The detail panel's fourth block lists what the customer attached, warns when they
mentioned a photo that never arrived, and **shows the photo itself**, proxied
from the mailbox. See `CHANGELOG.md` 2026-09-09 (both entries) and `DECISIONS.md`
§ "The photo is shown, and still not stored".

**What is proven, and more than when this item was opened.** The projection is
pure and tested — 16 cases in `scripts/lib/photo-evidence-rules.test.mjs`,
including the furniture rules, the outbound exclusion, the null-metadata case,
and the boundary that keeps the Exchange message id out of the browser. Run over
the **real corpus**: the block renders on **114 of 383** tickets, splitting into
15 with a photo, 74 mentioning one that never arrived, 24 with only non-image
files, 0 with unfetched metadata.

**The proxy is proven end to end against the live mailbox.** On ticket
`13779dd6`, all three photos returned 200 with `image/jpeg`, the correct
`content-length`, `nosniff`, `no-store`, an `inline` disposition carrying the
right filename, and bytes beginning `ffd8` — real JPEGs, not an error page. The
refusal paths were exercised too: an out-of-range index, a non-numeric index and
a ticket with no photos all return 404, the first with
`X-Attachment-Reason: not_found`. Across the corpus, **35 of 37 image parts
resolve and 2 messages have left the mailbox**.

**It has now been seen in a browser, on the page that actually renders it.** The
block first went into `TicketDetailPanel`, which `/tickets` does not mount — see
`CHANGELOG.md` 2026-09-09. It lives in `TicketContextPane` now, and on ticket
`5ed80bd5` (« Produit défectueux ? ») the rail shows both photos, captioned
`125325.jpg · JPEG · 1.8 MB` and `125326.jpg · JPEG · 3.0 MB`, decoded at
**1848×4000** through the proxy.

**What is still not seen.** No component or interaction test framework exists for
the dashboard (`README.md` step 18), and one ticket exercises one of the four
states. Checks 1, 4, 5 and 6 below are all unrun.

**The checks to run, in order:**

1. **Look at a photo, and confirm it is the right photo.** `13779dd6`
   (`delivery/problem`) carries three. The proxy was verified by content type and
   magic bytes, which proves a JPEG arrived — **not that image 0 is the one
   captioned `1000025991.jpg`**, and a mismatch there would put one customer's
   photo under another's name. `matchHandle` matches on name and size and falls
   back to position; this is the check that the fallback never fires wrongly.
2. **Confirm nothing is cached on disk.** After viewing that ticket, search
   `.next/cache` for image data. The `<img>` deliberately avoids `next/image` for
   this reason, and the whole "nothing is stored" claim rests on it.
3. ~~**Check the layout with two portrait images.**~~ **Done.** The rail's grid is
   `repeat(auto-fill, minmax(96px, 1fr))` with a 120px height cap and
   `object-fit: contain`; two 1848×4000 photos render side by side, uncropped.
   Still worth doing on **Andre Sylvie**'s eight-photo ticket
   (`f6fd150d`, closed), which is four times the widest case seen, and on the
   mobile `contextSheet`, which reuses the same pane at a different width.
4. **Find a photo that has left the mailbox and read what it says.** Two of the
   37 are gone. The panel should show "Not available — the message may have left
   the mailbox" rather than a broken-image glyph. If a `<img onError>` state is
   never reachable in practice, this is the case that proves it works.
5. **Read the warning on a mentioned-not-attached ticket.** `0dd5cfda`
   (`delivery/problem`, « pièce jointe ») and `0f56c9eb` (`payment/problem`,
   « ci-joint », which also carries one non-image file and one furniture part, so
   it exercises three states at once). It is `var(--warning)` and deliberately
   not `--error`: confirm it reads as "something for you to do", not a failure.
6. **THE ONE THAT MATTERS FOR TRUST — check a false positive is legible as one.**
   `PHOTO_TERMS` includes `image`, and `image de marque` in a b2b email fires it.
   The block prints the matched term for this reason. Find a `partner_collaboration`
   or `b2b` ticket among the 74 and confirm an operator can see *why* the warning
   appeared. If the term is not doing that work it is noise and should be dropped.
7. **Confirm the block is absent, not empty, on an ordinary ticket.** Any of the
   269. A "no attachments" line on two thirds of the queue is the failure this
   design avoids.

**One thing this item cannot close, and it is not a rendering question.** The
dashboard has no authentication (`README.md` step 11), so this route serves
customers' photos to anyone who can reach the port. That was true of the email
bodies already on the screen; a photo raises it, because it can carry a face, a
doorway or an address label. The route is as narrow as it can be made — one
ticket's own images, by offset, images only, no caching — and none of that is
access control.

## 18. ~~The case-file tool caches in a probe, not yet in a real batch~~ — RESOLVED 2026-09-09 on a real batch (built 2026-09-07)

The closing investigation call stopped carrying `response_format` and now returns
the case file as a forced `finalize_investigation` tool call, to keep it in the
same prompt-cache partition as the loop turns. See `CHANGELOG.md` 2026-09-07 and
`codex_plans/Model_Cost_Notes.md` § SOLVED 2026-09-07.

**Closed by `npm run investigate -- --backfill --include-closed --limit 12` on
2026-09-09**: 12 considered, 10 investigated, 2 skipped, **0 failed**, 45 model
calls and 78 740 tokens, 45 rows in `llm_usage`.

**Check 1 — PASSED, 10 of 10.** Every ticket's LAST investigate call now reports
a non-zero `cached_input_tokens` (1 152 – 3 840), where it was 0 on 8 of 8.
`report:prompt-cache --since 2026-09-09`: the investigate pass caches **61%**
against 21% in the last pre-fix window (2026-09-05), and per turn within a run:

| turn | calls | avg cached | share | before the fix |
| --- | --- | --- | --- | --- |
| 1 | 10 | 0 | 0% | 0% — expected, a run cannot hit on its first call |
| 2 | 10 | 1 792 | **87%** | 56% |
| 3 | 7 | 2 066 | **93%** | **0%** |
| 4 | 2 | 1 920 | **91%** | — |

Turn 1 caching nothing is the designed shape, not a residual fault: two tickets
share too little prefix for the cache to engage before their first call.

**Check 2 — PASSED, and it can only ever be answered in aggregate.** The pass
**upserts one row per ticket**, so these 10 runs overwrote their own predecessors
and a per-ticket before/after comparison is no longer possible for them. Note
that for the next comparison of this kind: snapshot the rows first. In aggregate
the case files are not worse but better, on 10 runs against the 127 that remain:
mean established facts **3.00 vs 1.88**, and higher in every category present —
delivery 3.67 vs 2.00, order 3.25 vs 1.93, product 2.00 vs 1.53. All 10 parsed
as tool arguments with no `argsError`, which is the thing `strict` on a function
rather than on a response format had to be shown to do.

**Most of that rise belongs to the rules layer, not to this change.** The cache
fix is behaviour-neutral by construction; what it had to prove was the absence of
a regression, and 0 failures with richer case files is that.

**Check 3 — the one that was to decide it — ANSWERED, and the answer is "always,
harmlessly".** `investigation.model_finalised_in_loop` fired on **10 of 10**
tickets, and `alongsideLookups` was **0 every time**: the model never asked to
finish in the same breath as a lookup, so no lookup was dropped. On several runs
it finalised on its very FIRST turn, immediately after `openingMoves()` had run
the floor's lookups — `afterCalls` equals the floor's ledger length, and the run
made no discretionary call at all.

**No collection was lost, because the break is where it always was.** A finalise
is mapped onto the "no tool calls" signal, and the closing call is made
unconditionally after the loop — there is no path that skips it. The suppression
trade `DECISIONS.md` records as measured and reversed is therefore not what this
fires; the model finalising and the model going quiet are the same event.

**What it does cost, and what is now worth re-examining.** The CHANGELOG says the
model "can reach for it mid-loop, and it does"; the measurement says it does so on
every single ticket. Its arguments are a complete case file that is discarded, and
then the closing call generates the case file again — so the project pays output
tokens twice per ticket, on every ticket. The code comment declines to use those
arguments on the grounds that it is the suppression trade, and **on this evidence
it is not**: collection has already stopped either way, and the only real
difference is that a mid-loop finalise has not seen `closingPrompt(run)`.

**The cheap experiment, if this is picked up:** on the same run, compare the
discarded mid-loop arguments against the closing call's output — verdict,
established facts, dropped claims. If they agree, the closing call is one model
call per ticket bought for nothing. If they do not, the closing prompt is doing
real work and this is settled for good, in writing. Either answer is worth having;
neither blocks anything today.

## 17. The agent test chat has never been run against live data (built 2026-08-22)

`08_testing.sql` **has been applied** (2026-08-22) and verified against the
database rather than read: 30 columns with the right nullability, 14 check
constraints and 2 foreign keys, 3 indexes, RLS on with 0 policies, the
`updated_at` trigger firing, and a round trip that inserted a row, had all four
of the interesting constraints refuse a bad one, saved an ideal answer, and
deleted itself. `agent_test_runs` holds 0 rows.

What remains is the part no schema check can cover: **every module is
unit-tested and the orchestrator is smoke-tested against a stubbed `fetch` and a
scripted model, but no rehearsal has run against real Supabase reads and real
OpenAI calls.**

**The checks to run, in order:**

1. Open `/agent-setup`, press **Test the agent**, and send a message with a real
   dev-store customer address and one of the synced order numbers
   (`#4716`–`#6770`). Confirm: the identity step links a customer, the tool cards
   show real product/order/knowledge results, and a draft comes back.
2. **The claim this exists to prove — "the rehearsal reproduces the poll".** Take
   one real ingested ticket, read its stored category, `tool_calls` and verdict,
   then type its message into the test chat with the same sender and compare.
   They will not match token for token (the models are not deterministic across
   runs), but the **category, the tool set, and the verdict** should. A divergence
   there means the substitution is not faithful and the transcript cannot be
   trusted.
3. Confirm the run wrote nothing: `tickets`, `ticket_messages`,
   `ticket_investigations` and `ticket_drafts` row counts unchanged, and the
   `/tickets` queue count unchanged. (The smoke test asserts this against a
   stubbed transport; this is the same claim against the real one.)
4. Test a knowledge article from its own rail with a question it should answer,
   and check the verdict is `used`. Then test a question it should NOT answer and
   check it is not `used` — a checker that always says yes is worse than none.
5. Read the reported cost against the OpenAI dashboard for the same minute, to
   confirm the per-model apportionment is roughly right. It is an estimate of an
   estimate (tokens are totalled per run, models per call) and is labelled as one.

**One number to watch on the first real run.** The investigation is capped at 4
turns and 6 tool calls and drafting is `gpt-4o`; the drafting backfill already hit
HTTP 429 at roughly 12 calls/minute on this account's 30 000 TPM cap. A rehearsal
is six calls in one burst, so a run started while the worker is drafting may fail
mid-transcript. If that happens it is the rate limit, not the harness — the pass's
own retry handling is what the transcript will show.

**What cannot be checked yet:** whether the ideal answers accumulate into
anything useful. Nothing reads `ideal_body_text`, by design — it is capture for a
later phase, the same standing as `ticket_draft_edits`.

## 0a. The two new tools ~~have never been called by the model~~ — THE MODEL DOES CALL THEM; whether it calls them well is unjudged (re-measured 2026-08-17)

`verifyPurchase` and `checkPhotoEvidence` are wired into the registry, the
evidence vocabulary and the case file, and both were run directly over the whole
corpus — so their outputs are measured. **An investigation has since chosen to call
them**, which is what this item said had not happened. The full ledger across the
80 stored case files:

| tool | calls |
|---|---|
| `getOrderContext` | 52 |
| `lookupCustomer` | 49 |
| `searchKnowledge` | 24 |
| `lookupProduct` | 21 |
| **`verifyPurchase`** | **17** |
| `extractPromotionCodes` | 13 |
| `listActivePromotions` / `lookupPromotion` | 12 / 12 |
| `lookupStock` | 8 |
| **`checkPhotoEvidence`** | **3** |

**What that leaves open is the interesting half.** `checkPhotoEvidence` fired 3
times while 36 tickets are `mentioned_not_attached` — the population the tool
exists for — so it looks under-called rather than ignored. And `verifyPurchase` at
17 calls needs reading against the tool-budget concern below.

**To validate:** `cd agent && npm run investigate -- --dry-run --limit 10 --show`
over `product` / `return_exchange` / `delivery` problem tickets, and read for:

1. **Does it call `verifyPurchase` on a ticket that needs it, and does the
   `known_no_orders` wording survive into the case file intact?** The prohibition
   ("never say they are not a customer") is a caveat string; a model can
   paraphrase past it, and that is the failure worth catching early.
2. **Does `checkPhotoEvidence` get called on damage tickets, or only when the
   customer already mentioned a photo?** The 36 `mentioned_not_attached` tickets
   are the ones the tool exists for.
3. **Tool budget.** Both were added to `product`, which now allows five tools
   against a ceiling of six calls. If the agent spends calls verifying a purchase
   on a ticket that only needed `searchKnowledge`, the allow-list is too wide.

**What is already measured** (run directly, 2026-08-17):

| Figure | Value |
|---|---|
| purchase states over 214 tickets | 111 `known_buyer` · 34 `known_no_orders` · 69 `unknown` |
| photo evidence over 203 tickets | 7 `attached` · 36 `mentioned_not_attached` · 160 `none` |
| attachment backfill | 48 of 48 filled, 10 with a photo, 0 failed |
| tickets with a photo, by subject | delivery 2 · return_exchange 2 · order 1 · product 1 · partner 1 |

**Known weakness, not yet decided.** Several last orders are mostly
`- échantillon` sample lines, and the cross-check happily matches a customer's
wording to a free sample — the same failure `product-lookup` already solves for
the catalogue by excluding non-active products. An order's line items cannot be
filtered that way (the customer really did receive the sample), so the honest
options are to down-weight sample lines or to report them separately. Worth
deciding once a real investigation has shown whether it matters.

**Not measured at all: precision of the photo-mention regex.** 36 tickets fire it
and nobody has read them to see how many are `image de marque` in a b2b thread
rather than a customer promising a photo. The matched term is stored in the tool
result precisely so that audit is cheap.

## 0b. "Add as ticket" has never been clicked against the live database (2026-08-19)

Promoting a dropped email is built, unit-tested (12 tests over the ingestion
writer's own in-memory store) and typechecked, and **no row has been promoted**.
Everything below the button is exercised; the button itself has produced nothing.

**The three claims that unit tests cannot make**, because each depends on the
live rows rather than on the logic:

| Claim | How to see it |
|---|---|
| The write lands | Promote one of the **49** blocked rows; a ticket appears in Queue and the row leaves Irrelevant |
| The agent picks it up | With the worker running, within a poll (60 s) the ticket carries a `category`, a `request_kind` and a `level` |
| It is idempotent | Promote the same row twice (or double-click): still one ticket, one `ticket_messages` row |

**Pick the row deliberately.** 25 of the 49 were dropped by the blocklist and 24
by the classifier; the interesting case is a **classifier** drop labelled
`irrelevant` (14 rows), since those are the ones a reviewer is most likely to
disagree with. **2 of the 49 belong to a conversation that already has a ticket**
— promoting one of those is the second case worth seeing, because it must join
that ticket, reopen it and add a message rather than create a second thread.

**What to check after, in the database rather than in the UI:** the new
`ticket_messages` row carries `raw_graph_payload -> promotedFromSpamAudit` naming
the `spam_audit` id, and the `spam_audit` row itself is **byte-for-byte
unchanged** — the promotion is recorded by the ticket existing, never by editing
the decision.

**The one thing to expect and not read as a bug:** the ticket's
`first_message_at` is the *decision* time, not the arrival time, because the
audit row carries no other clock. On this imported corpus that is the import
date, so a promoted email joins the queue as recent work.

**Not a check but the obvious follow-on question:** whether promoting should ever
also exempt the sender. It does not — the next email from that address is dropped
again — and whether that is the right default is only answerable once somebody has
promoted a few and seen whether they cluster on senders or on subjects.

---

## 0. The refund/returns tile needs its views re-applied (2026-08-17)

`fulfilment_summary` and `fulfilment_summary_by_channel` gained four columns —
`refunded_orders`, `fully_refunded_orders`, `returns_opened`, `refunded_amount` —
and `order_fulfilment_timing` now selects `total_refunded` and `return_status`.
**The deployed views do not have them yet**, so the `Returned or refunded` tile
in the Delivery section renders as a blocked tile naming the fix rather than as a
figure. That degradation is deliberate (`num`, not `count`, in `mapSummary`) and
is itself worth confirming once, because it is the guard against a stale database
reporting *zero orders were ever refunded*.

**To validate:** re-apply the fulfilment views, then load `/insights/fulfilment`.
The views must be dropped first — the baseline uses `create view`, not `create or
replace`, and eight views depend on `order_fulfilment_timing`.

**The figures the tile should show, read straight off `orders` on 2026-08-17:**

| Figure | Value |
|---|---|
| live orders | 2 006 |
| orders with a refund | **3** (0.1%) — `#6398` in full at €32.03, `#6328` and `#6452` in part at €6.23 each |
| returns opened | **0** |
| `return_status` | `NO_RETURN` on all 2 006 — a recorded value, not a null |
| `cancelled_at` | 0 orders |

If the tile shows anything other than 3 and 0, the view is aggregating something
other than what a direct read of `orders` says, and that is the bug to chase.

**The open business question, which no check here can answer:** whether returns
are meant to be raised in Shopify at all. All three refunds were issued with no
return record, so the workflow may well be email-and-refund-by-hand — in which
case 0.1% is a floor on what came back, and the real number is in the support
mailbox. The panel says exactly this in a note rather than presenting the rate as
a fact; confirming it with the business is what would let that note be deleted.

**Each entry says what to check and how, not just that it is unchecked.** An
item is only removed once someone has actually run the check and seen the
result.

Last updated: 2026-08-19 (item 0b added — "Add as ticket" is built and has never
been clicked against the live database). Before that: 2026-08-17 (item 14 closed — the usage sink was never constructed,
now wired and verified; item 16 added — the investigation queue is unreachable,
113 flags stranded on auto-closed tickets; items 15 and the preamble re-measured.)

---

## 15. The categorisation review labels are gone

**`categorisation_review` holds 0 rows**, measured 2026-08-17 across all shops.
The real-mail accuracy figures quoted in `DECISIONS.md` and previously in
`AGENT_INTEGRATION_PLAN.md` — **subject 77%, kind 90%, level 73%** — were derived
from 30 hand-labelled rows in that table. They cannot be recomputed, extended, or
defended against a change to the prompt.

**What is not affected:** the synthetic set (`agent/eval/categorisation-cases.mjs`,
40 cases, 38–39/40) is in the repo and still runs. It guards against regressions
and says nothing about real mail.

**Most likely cause is a rebuild, not retention.** Retention on this table is 3
months and the sample was taken in late July, so it was not swept. The tickets and
messages survived while this table, `ticket_forwards` and `category_forwarding` did
not — which is what a rebuild plus a re-ingestion looks like.

**To close:** `cd agent && npm run review:sample`, label blind (the agent's columns
stay empty until after labelling), and sample toward **~100** rather than back to
30 — at n=30 the harness cannot resolve a change smaller than ~16 points. Then
`npm run review:compare`.

**And treat the old numbers as history, not as a baseline.** A re-sample draws
different emails, so the first re-run is a new measurement rather than a
comparison.

## 16. ~~The investigation queue is unreachable~~ — RESOLVED 2026-08-17 with an opt-in

**Closed by decision, not by a fix to auto-close.** The queue being open-only is
**correct for the worker**: in production a ticket is categorised, investigated and
(once Phase 5 lands) drafted within a poll of arriving, so the 28-day auto-close
window never comes near live work. What was actually being measured is an artifact
of importing a historical corpus into a dev database — mail from May–August landing
in a queue that then retires it on schedule.

**So the flag is not stranded, it is just behind a filter a person can lift.**
`npm run investigate -- --include-closed` widens `record.claim` by dropping the
status narrowing and nothing else — the flag, the categorisation requirement,
`archived_at` and the soft-delete all still apply.

**A widened run never moves the ticket's status.** 65% of verdicts map to
`awaiting_human` / `awaiting_customer`, so letting the verdict act on a closed
thread would resurrect settled threads into the live queue by the dozen. The case
file is a note about the thread; writing one is not a reason to reopen it.

**Verified live on 3 tickets:** 1 investigated (`promotions/problem` →
`needs_customer_input`), 2 skipped as out-of-scope subjects, the ticket still
`closed` with `closed_at` untouched, its flag cleared, and 4 rows in `llm_usage`.

**What it reaches, measured:** 113 claimable with the flag lifted, **91 of them
investigable** (the other 22 are `b2b`, `careers`, `partner_collaboration`,
`cosmetovigilance`, `legal_privacy` — no tools by design, and the pass clears their
flag as it skips them, which drains the dead queue as a side effect). **28 of the
91 carry an order-context bundle no case file has read.**

**Cost, now that it is measured rather than guessed:** one investigated ticket is
4 model calls, 5 464 in / 520 out, **≈ $0.016** at the repo's current rate card. The
remaining 90 are therefore **≈ $1.45** — and re-run before the rate card is checked
against OpenAI's current pricing, that figure is only as good as
`scripts/lib/llm-rates.mjs`.

**The original finding, kept because the numbers are still the numbers:**

| | |
|---|---|
| tickets flagged `needs_investigation` | **113** |
| of those, claimable by the pass | **0** |
| status of all 113 | `closed`, every one, `closed_reason: inactivity` |
| what `--backfill` would raise | **9** — all open, all in scope, and **all 9 already have a case file** |

**Why.** `PASSES.investigation.where` is `{status: 'open', needs_categorisation:
false}`, so `record.claim` only ever sees open tickets. Auto-close retires a thread
after 28 days of silence and **does not clear the pending flags it strands**. This
corpus is historical mail (`last_message_at` spans 2026-05-22 → 2026-08-08), so
139 tickets auto-closed for inactivity, taking their raised flag with them.

`raiseFor` cannot repair it either: it requires `status = 'open'` *and* the flag
already false, so a closed ticket is out of reach from both directions. The flag
now means "was queued once", not "is queued".

**`--backfill` is not the same tool and does not substitute.** It raises the flag on
**open** tickets only, so run today it reaches 9 that already have case files and
none of the 113.

**Nine case files sit on threads that later auto-closed** (6 `answerable`, 3
`needs_customer_input`). Read as a dev artifact rather than a failure: the agent
read a three-month-old imported thread and the auto-close window then retired it on
schedule. On live mail the same thread would have been read minutes after arrival.
Worth remembering only as a reason not to judge the verdict mix from this corpus
alone.

**Still genuinely open here:** `agent_pipeline_funnel` counts a flagged-but-closed
ticket as pending, so until the widened run drains them (or they are skipped) the
panel overstates the queue. That is a reporting question, not a pipeline one.

## 14. ~~Nothing has been recorded in `llm_usage`~~ — FIXED 2026-08-17

**Closed.** The cause was neither a broken sink nor a silent `catch`: **nothing
ever constructed a sink.** `usageSink` defaults to `noopUsageSink` in
`createOpenAIClient`, `createEmbeddingsClient` and `createInvestigationStack`, and
the worker's poll and every CLI took the default. Only the three `embed:*`
reconcilers passed one, via `createUsageRecording` — so the table could only ever
have been filled by a manual embedding run.

Every piece downstream was correct and tested: the transport records one entry per
HTTP call, all four call sites pass their `pass` and `ticketId`, and the store maps
and bulk-inserts. The chain was complete except for its first link.

**The fix:** `createShopUsageRecording({supabase, shopId, logger})` hands out the
sink and its flush together, so a caller cannot take one and forget the other.
Wired into `agent/src/index.mjs` (one buffer per process, drained at the end of
every poll, outside `--stop-after` like retention) and into
`agent/src/tools/run-investigation.mjs` — the most expensive pass, and the one
about to be run over a backlog. The eval harnesses keep the no-op on purpose:
re-running the same 40 cases would pollute per-pass cost with measurement.

**Verified end to end** against the live project: one real cheap-tier
categorisation call produced exactly one row —
`pass: categorise · model: gpt-4o-mini · 2415 in / 44 out / 2459 total ·
succeeded: true`. The table went from 0 rows to 1.

Four regression tests pin the pairing, `write: false` (dry runs total the spend and
store nothing), and that a failed write still drains so the next flush cannot
double-count. Agent suite 775 pass, root 1314 pass.

**One row in the table is a test row** — the synthetic call above, no `ticket_id`.
It is left in deliberately: the money was really spent, and a ledger that omits
real spend is worse than one carrying a 2 459-token curiosity.

**Still open from this area:** the default prices in `scripts/lib/llm-rates.mjs`
have not been checked against current OpenAI pricing, so any figure on
`/insights/agent` is only as good as those constants. And the categoriser's prompt
measures **2 415 input tokens per ticket**, which is the first real input to the
cost questions in items 4b and 9.

---

## 13. The per-carrier contact rate is a floor, and its ordering is unconfirmed

**Built and arithmetically verified; the number itself is not yet trustworthy.**
The carrier table now reports how many of each carrier's shipments produced a
ticket. Verified: shipment counts unchanged after the ticket join
(1,311 / 198 / 6 — the lateral does not multiply rows), orders counted rather
than threads, and the panel renders the coverage caveat from
`fulfilment_ticket_coverage` rather than from copy.

**Why it is a floor.** A thread reaches a parcel only through
`tickets.shopify_order_number`, and **52 of 214 tickets carry one**. So the
column under-counts by an unknown factor.

**The claim on the panel that is not yet proven:** *GLS is contacted 4.1× as
often as Colissimo* (10 of 198 against 16 of 1,311). The reasoning is that the
under-counting hits both carriers alike, so the **ordering** survives even though
the absolute rates do not. That assumption has not been tested, and the
numerators are 10 and 16 — small enough that a handful of misattributed threads
would move the ratio.

**The check to run, in order:**

1. Run `orders:resolve` over the ticket backlog, then re-read the column. If
   coverage rises from 52/214 and GLS stays several times Colissimo, the
   ordering is real.
2. Test the even-bias assumption directly: of the 52 attributable tickets, is
   the GLS/Colissimo split materially different from the split among tickets
   that quote no order number but do carry a `customer_id`? A carrier whose
   customers happen to quote order numbers more often would produce this gap on
   its own.
3. Only then is it worth asking whether GLS deliveries are actually worse. Note
   what the panel already shows: GLS dispatches *faster* (23.3h vs 24.5h) and is
   late less often (13.1% vs 16.1%), so whatever drives the contact gap is not
   dispatch — it is the half of the journey the Delivery section cannot see.

---

## 12. ~~The per-channel fulfilment views have never been applied or read~~ — APPLIED 2026-08-16

**Closed.** `order_fulfilment_timing` now carries `channel` /`channel_label` and
three channel-cut views exist beside the store-wide three. Applied **forward**
to the dev database the same way item 10 was — the block was sliced out of
`06_analytics.sql` itself, not retyped, run in one transaction after a
`drop view ... cascade` that only reached the four dependent fulfilment views,
then `pgrst reload schema`; the scratchpad script was discarded. No table was
touched. Verified after the fact:

| Check | Result |
|---|---|
| four channels present, summing to the whole book | web 1500 + amazon 467 + connect-dev-1 36 + shop-72 3 = 2006 |
| `fulfilment_summary` unchanged (still one row per shop) | yes |
| Amazon p50 / p90 / past-72h | 23.0h / 69.1h / 39 of 467 (8.4%) |
| Amazon monthly series | Feb–Aug 2026, July the outlier at 31.7% |
| Amazon bucket histogram sums to `measured` | 93+156+114+65+22+17 = 467 |
| read through **PostgREST**, not just SQL | yes — the panel renders from it |
| `/insights/fulfilment` renders the section | 200, tiles and both figures populated |

**What this surfaced, and what is not yet checked:** **402 of 467 Amazon orders
(86%) carry no tracking number**, against 4 of 1,487 on the online store. The
panel states this as a marketplace data gap rather than a dispatch failure —
that reading is *inferred, not confirmed*. The check: open two or three of those
Amazon orders in Shopify Admin and see whether a tracking number exists there
and is simply not on the fulfilment record we sync, or whether none was ever
captured. Those are different problems and only one of them is ours.

---

## 11b. `fetch failed` is back, and it now kills WORKER passes mid-run (2026-08-20)

Item 11 below closed a *dashboard read* failure and its cause (key-shaped
headers). **The same message is now killing long-running worker passes**, which
is a different failure with a different consequence: a pass dies partway and
what it had not reached is simply not done.

Three in one session, all `Supabase request failed after 4 attempts: fetch failed`:

| Pass | Died after | Consequence |
|---|---|---|
| `ingest:once --stop-after=categorise` | ~15 min of delta paging | The `customers` and `categorise` stages **never ran**, and the delta cursor only advances on completion — so the mailbox backlog is half-ingested and re-enumerates from the same point next time |
| `customers:resolve` (1st) | ~part-way through the shop | 117 tickets left unattempted |
| `customers:resolve` (2nd) | completed | — |

**Why it matters beyond the retry.** The poll's stage order is
`customers → categorise → … → investigate`. A crash in `ingest` therefore takes
out customer linkage for everything that poll ingested, and the investigation
that runs later reads those tickets **without a `customer_id`**. Measured today:
of 10 freshly investigated tickets, 5 had never had customer resolution
attempted, and 6 produced case files with **0 established facts** against a
corpus norm of 12 in 80. Four of the five turned out to be genuine `no_match`,
so the damage was one ticket — but that is luck, not a guard.

**To validate:** run `npm run ingest:once` to completion once and confirm the
delta cursor in `shops.sync_cursors.mail_ingest_delta_link` actually advances.
Until it does, the corpus keeps re-enumerating the same pages.

**Worth considering, not yet decided:** whether a pass that dies should leave a
marker, so "not done" is distinguishable from "done and found nothing". Today the
only way to tell the two apart is `metadata.customer_resolution` being absent
rather than saying `no_match` — which is how the gap above was found, by hand.

### The lifecycle damage that crash left behind, and the order to repair it in

The same half-finished enumeration reopened the closed queue, via a separate bug
now fixed (`CHANGELOG.md` — *Re-delivery is no longer treated as arrival*). The
**code** is fixed; the **data** is not:

| | |
|---|---|
| Auto-closed tickets reopened | **136** of 139 |
| `closed_at` on them | **nulled — unrecoverable**. Only `metadata.closed_reason: "inactivity"` survives, which is how they are identifiable |
| Tickets re-flagged `needs_categorisation` | 374 of 400 |
| Backlog section | ~355, against 3 in Closed |

**The repair had a required order, and skipping step 1 would have made step 2 a
no-op.** `shouldAutoClose` refuses any ticket still flagged
`needs_categorisation` — correctly, since closing an uncategorised ticket drops
it out of the categoriser's `status = 'open'` queue for good. Before step 1,
`tickets:autoclose --dry-run` reported **would close 0 of 329; 329 exempt**.

**RUN 2026-08-21, on the owner's instruction. Both steps executed:**

1. **Categorisation drained**: 371 flagged → **0**. 155 first reads, 202
   re-reads, 14 skipped (threads holding only our own replies), **0 failed, 0
   fallbacks**. $0.22 over 366 cheap-tier calls. Corpus now 383 of 400
   categorised; the 17 without a subject are the skipped ones.
2. **Auto-close run**: **327 closed of 329, 2 exempt, 0 failed.** The dry run
   flipped from 0-of-329 to 327-of-329 once the flags cleared, which is the
   exemption working exactly as designed.

Sections went Queue ~28 → **26**, Backlog ~355 → **41**, Closed 3 → **319**.

**The accepted cost, recorded so nobody rediscovers it as a bug:** all 327 carry
`closed_at` of **2026-08-21**. Anything reading that column —
`ticket_reply_times`, the retention reads, the Insights support panel — shows a
cluster of closures on the day of the repair that reflects this run and not the
business. The original dates were already unrecoverable; the choice taken was a
wrong-but-uniform date over an empty Closed section.

**The new condition this created, which is item 16's shape at larger scale:**
357 tickets are flagged `needs_investigation` and **only 44 are still open** —
auto-close moved the other 313 behind a closed status, and the investigation pass
claims `status = 'open'` only. Those 313 are now reachable solely via
`investigate --include-closed`. Nothing is lost and nothing is urgent: a closed
ticket with a raised flag costs nothing until someone decides those case files
are worth roughly $5. The investigation queue was deliberately **not** run.

**Two level 4 tickets are open and exempt.** The corpus held zero L4 before
2026-08-21; both came out of the newly ingested older mail. L4 is never
auto-closed and never drafted, so they sit in the queue until a person reads
them. **Unreviewed — that is the one item here that wants a human eye.**

---

## 11. ~~Local dashboard validation is blocked by recurring Supabase fetch failures~~ -- FIXED 2026-08-16 (dashboard reads only — see 11b)

**Closed.** Two separate things looked like one recurring Supabase issue:

- A dev server started inside the restricted Codex environment could not reach
  Supabase at all, so server-side reads ended as `fetch failed`.
- With network access allowed, the configured key reached Supabase but old client
  headers sent `Authorization: Bearer sb_secret_...`, which new Supabase secret
  keys reject because they are not JWTs.

The user-visible symptom was the app shell rendering while server-side Insights
reads fell into the panel error state with:

```text
Supabase request failed after 4 attempts: fetch failed
```

The tight repro captured before the fix:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3001/insights/support
```

Result before the fix: HTTP 200, `Support` shell present, and the rendered payload contains
`Supabase request failed after 4 attempts: fetch failed`.

**Fix:** `scripts/lib/supabase-rest-client.mjs` now builds headers through
`supabaseHeaders()`: new `sb_*` keys are sent as `apikey` only, while legacy
JWT-shaped keys still get `Authorization: Bearer ...`. The direct
`countCorpusMessages()` HEAD request in the Support panel uses the same helper.

**Verified after the fix:** a fresh dev server with network access on port 3002
rendered `/insights/support` with no Supabase panel error. Browser check found
`Message volume by cluster`, one cluster table caption, and 46 topic-map tiles.

**Tests:** `node --test .\scripts\lib\supabase-rest-client.test.mjs`,
`npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run build` in `web/`,
and root `npm.cmd test` (**1271 pass**).

---

## 10. ~~The new schema objects have never been applied~~ — APPLIED 2026-08-15

**Closed.** The three views, `order_number_range()` and the `ticket_messages`
dimension check are live on the dev database, applied **forward** rather than by
rebuilding from empty — so the 214 ingested tickets, 451 messages, 2014 orders
and 58 201 customers are untouched. Verified after the fact:

| Check | Result |
|---|---|
| all four objects present | yes |
| `security_invoker=true` on all three views | yes |
| `anon` / `authenticated` privileges on the views | none |
| `ticket_messages_embedding_dimensions_check` present | yes, 0 rows violated it |
| row counts before vs after | 214 / 451 / 2014 / 58 201, unchanged |
| `ticket_message_counts` sums to live messages | 451 = 451 |
| `ticket_first_inbound` rows vs tickets with inbound mail | 203 = 203 |
| `ticket_queue` rows / with a customer | 214 / 141 — matches the documented link rate |
| read through **PostgREST**, not just SQL | 214 rows; schema cache reloaded |
| `orders:resolve:dry-run` end to end | 159 considered, 6 confirmed, 9 mismatch |

**How, and why it is not in the repo.** The forward statements were extracted
from the baseline files themselves (not retyped), applied in one transaction
from a scratchpad script, and the script was discarded. Checking a forward step
in beside the baseline is how a baseline turns back into a history — the thing
the 8→5 split was done to stop. The baseline remains the definition; this was a
one-off to avoid paying for it with the corpus.

**What is still deferred:** nothing about the schema. The remaining reason to
rebuild from empty is unrelated to this refactor.

---

## 1. Forwarding has never actually sent a message — and its ledger is now empty too

**Status, re-measured 2026-08-17:** `ticket_forwards` holds **0 rows** and
`category_forwarding` holds **0 addresses**. So the pass cannot route anything at
all today: a null address is the off switch, and every category is off.

**What the ledger used to say**, and what the failure was: 42 messages queued at
`attempts=2`, 0 sent, every attempt returning `ErrorMailboxMoveInProgress` —
Exchange migrating the mailbox between databases, transient and Microsoft-side.
`Mail.Send` is granted and verified working: a direct `sendMail` test to
`onouailhetas@lap-groupe.com` returned HTTP 202 and arrived. Only the `/forward`
action was blocked, because it reads an item from the store being moved.

Those 42 rows are gone with the same rebuild that emptied item 15's table, so the
`unique(ticket_message_id)` guard no longer has a backlog behind it — **a first
real run would forward from scratch**, which changes the blast radius of the "42
messages, some dating to January, going out at once" warning below rather than
removing it.

**Before anything else on this item:** set at least one address, and note that
`/forward` addresses the original message by Graph id, so it is also gated on the
mailbox decision (`README.md` step 3).

**To validate:** once the move completes, `cd agent && npm run forward:dry-run`
then `forward:once`. Confirm the recipient receives the original mail **with its
attachments intact** — a CV arriving as a CV is the entire reason `/forward` was
chosen over composing a new message, and it is the one thing no test covers.

**Also unvalidated:** the three configured addresses all point at the support
mailbox itself (fine for a smoke test). Before real colleagues receive anything,
confirm the first run's backlog behaviour is acceptable — 42 messages, some
dating to January, going out at once.

## 2. ~~Abandoned-checkout lookup~~ — VALIDATED 2026-08-01

**Closed.** Tested against a real abandoned checkout in the dev store.

- **The tool works end to end.** Found the checkout by email over a 90-day
  window, matched case-insensitively, returned a clean negative on an unknown
  address, and fed the basket into the promotion checks.
- **`discountCodes` is populated** — the record carried `["QIRINESS10"]`, which
  had been applied (244.30 gross, 24.43 off).
- **The free-text email filter DOES work.** `query:"<email>"` returned exactly
  the matching row and `query:"zzz-no-such-person@..."` returned none, so it
  filters rather than being ignored. `email:<address>` also works. This is now
  a live optimisation opportunity: the date-window scan can be replaced by a
  direct filtered query. Left as-is for now because the current path is proven
  and the optimisation is not yet needed at this volume.

**A real bug fell out of it.** `subtotalPriceSet` comes back **net of discount**
— 244.30 in line items, 24.43 discount, 219.87 reported. Minimum requirements are
evaluated by Shopify on the *pre-discount* subtotal, so measuring against 219.87
would have told a customer with a qualifying basket that they were 20 € short.
`normaliseCheckout` now reconstructs `subtotalBeforeDiscount` from the line
items, the minimum check uses it, and the wording says "(avant remise)".
Regression tests carry the real numbers.

**A second correction, 2026-08-01.** Shopify keeps **one abandoned-checkout
record per checkout session and mutates it in place**. Observed live: the same
id went from `["QIRINESS10"]` / 1 item / 219.87 to `[]` / 2 items / 82.25, with
`createdAt` unchanged at 18:38:03 and only `updatedAt` moving to 18:57:33. The
record is therefore a snapshot of *now*, not a log of the attempt. Consequences:
the basket recovered may not be the basket at the moment the code failed, and
dating a reply from `createdAt` would have shown the session's start time beside
contents from twenty minutes later. The tool now carries `updatedAt` and dates
the basket from it ("état du …").

**Still open from this area:**

- **The lookup is now an agent tool, and no investigation has called it.**
  Wired into the registry 2026-09-16 as `lookupAbandonedCheckout` (order and
  promotions subjects) so that `checkout_state` can be branched on — P-17's
  three rules turn on it. Everything above was measured through the retrieval
  module directly; what has never run is the whole path: an investigation
  resolving the customer from the ticket's hash, calling the tool, deriving
  `retrieved` / `unavailable`, and selecting the rule. The unit tests cover each
  link and `selectAnswer` was checked against the live rule set, which is not
  the same thing. **To validate:** run `npm run investigate` over a real P-17 or
  promotions ticket from a customer who abandoned a checkout in the last 30
  days, and check three things — that the tool was offered and called, that the
  finding matches what Shopify actually holds, and that the case file carries
  neither the recovery URL nor the address. Until then the rules stay `draft`.
- **What a miss costs on a busy day.** The lookup cannot filter on email, so it
  walks a 30-day window at 50 a page, up to 6 pages, for every ticket that calls
  it. Never measured against live volume. Item 2 above records that
  `query:"<email>"` **does** filter, which would remove the walk entirely —
  worth doing before this runs on the poll rather than by hand.
- **Whether a *rejected* code appears in `discountCodes`.** The tested checkout
  had a *successfully applied* code, so this is untouched. The expectation
  remains that Shopify records applied codes only, and the tool already treats
  absence as `unknown` rather than evidence. **To validate:** abandon a checkout
  with a deliberately invalid code and inspect the record.
- ~~**When an abandoned checkout is created.**~~ **Answered 2026-08-01** (by the
  store owner, not measured here): Shopify creates one once the customer has
  entered their **email** and then leaves the basket unattended for about **10
  minutes**. So the tool can only ever return something for customers who got as
  far as identifying themselves at checkout — which is also the population that
  could have been trying a discount code, so the overlap with "why doesn't my
  code work?" is favourable. A shopper who never entered an email leaves no
  trace, and for them the basket stays invisible.

## 2b. Advice from collections is built and has never answered a real ticket

Shipped 2026-09-16: the collection sync, `advice_collections`, the intersection
in `recommendProducts`, situation PR-29, the reply format and
`/agent-setup/collections`. Everything below was measured by calling the pieces
directly; **no investigation run has used any of it**, and no draft has been
written from it.

- **To validate:** run `npm run investigate` over ticket `b7b276f6` (Martine) and
  check four things — that it matches PR-29, that `recommendProducts` is called
  with requirements drawn from the activated titles, that the products proposed
  are serums rather than the men's cream it produced on 14 September, and that
  the draft names each with its description and skin fit. Then the same over a
  ticket whose requirement nobody has curated, which should route to a person
  with the *Nos soins visage* link rather than improvise.
- **The PR-29 rules are drafts.** Verified to select correctly once approved
  (`by_collection` → propose, `relaxed` → propose with the caveat, everything
  else → a person). Nothing changes on real mail until somebody approves them.
- ~~**Six collections were activated from SQL to test the sync.**~~ **Closed
  2026-09-16**: the owner has curated **22** (10 `category`, 12 `concern`), all
  with an axis and all with fresh membership. The six I guessed are a subset of
  what they chose.
- **The two new screens have not been opened in a browser.** `tsc` and lint are
  clean and the data behind them was checked with SQL, which is not the same as
  the page rendering. **To validate:** open both tabs and switch one collection
  on and off.
- **`cross_sell` has no PR-29 rule.** If a customer names a competitor product
  that happens to resolve to one of ours, the situation matches and no rule
  applies, so it routes to a person. Safe, and left rather than guessed at.
- ~~**The membership refresh is manual.**~~ **Closed 2026-09-16**: the sync runs
  last in the nightly, and `/agent-setup/collections` has a Sync button for the
  cases that cannot wait. There is still no `collections/create` webhook, so a
  collection made in Shopify is invisible for at most a day unless somebody
  presses the button. The read re-checks `products.status`, so a stale
  membership can only ever give a smaller answer, never a dead product in a
  reply.

## 3. Promotion eligibility has never seen a real minimum requirement

All three dev discounts have `minimum_requirement: null` — the thresholds come
from `customer_buys` on the BXGY code instead. The subtotal and quantity branches
of `describeMinimum` and of the basket evaluation are covered by unit tests with
synthetic rows only.

**To validate:** create (or sync) a discount with a real minimum-spend
requirement and confirm `rule_snapshot.minimum_requirement` populates as
`{ type: 'subtotal', amount, currency }`.

**Also unvalidated:** `customer_selection` has only ever come back as
`{ scope: 'all' }`. The `segments` and `customers` branches are untested against
real data.

## 4. Knowledge retrieval bands are calibrated on a small, general library

**Re-derived 2026-08-09** against the labelled retrieval set on 61 chunks:
`ANSWERABLE = 0.60` unchanged (no irrelevant chunk in the run reached it),
`WEAK` moved 0.45 → 0.50 because 0.45 sat below the irrelevant p75 of 0.458.
That is a real improvement on real measurement — restraint 30% → 70%, band
accuracy 44% → 69%, at no recall cost — but it rests on **16 labelled cases**,
and the library is still general: mostly policies and brand pages, with no
delivery or promotions article yet.

**To validate:** after specific content is written and approved, re-run
`npm run eval:retrieval` and `npm run eval:diagnose` and re-do the threshold
sweep. The expectation to test is that *relevant* scores rise as content gets
specific, which would make `WEAK = 0.55` (restraint 90%, band accuracy 81%)
affordable — today it costs a real answer. The bands are named constants in
`retrieval-rules.mjs` precisely so they can be moved.

**Two known gaps in the harness itself**, both making entity accuracy read worse
than the pipeline is: the eval measures the raw code regex rather than the real
`extractCodes` (which filters against the live store list), so precision reads
11%; and product-entity matching returns 0/0, which has not been diagnosed.

## 4c. Evidence needs: step 1 is built, STEP 2 IS NOT

**Status:** the report exists and is stored (`ticket_investigations.evidence_gaps`).
Nothing acts on it. This is deliberate, and it is not finished work.

**What step 2 is**, once the numbers below say the vocabulary can be trusted:

1. **Enforce.** An `answerable` verdict that left a declared need open gets
   downgraded, the same mechanism that already forces `needs_human` on an empty
   `established`. Any open `other_fact` forces it outright.
2. **Steer.** The prompt says *"you still do not have X"* instead of restating
   the whole per-subject checklist every turn.
3. **Exit early.** When every need is satisfied after the opening moves, skip the
   exploration turn entirely — one `gpt-4o` call saved on the common case.

**Do not start step 2 on unvalidated numbers.** A vocabulary that over-declares
would downgrade good case files for reasons about the list rather than the
ticket, and an early exit on an under-declared list would stop an investigation
that should have continued. Step 1 cannot make the agent behave worse; step 2
can.

**To validate, then decide:** run `npm run investigate:dry-run` over a real batch
and read the `Preuves attendues vs obtenues` summary. Four questions:

1. ~~**Is `not_attempted` ever non-zero?**~~ **Answered 2026-08-17: 3.** Across the
   80 stored case files the need states are satisfied **109** · attempted **100** ·
   unavailable **39** · `not_attempted` **3**. The loop is very nearly always
   calling the tools it was allowed, so **step 2's steering is not worth building**
   — the remaining value in step 2 is enforcement and the early exit, and those
   depend on questions 2 and 3 below, which are still open.
2. **Is the model over-declaring?** Needs it names "just in case" inflate the
   denominator and would make step 2's enforcement punitive. Read a sample
   against the emails.
3. **How often is `other_fact` declared, and on what?** That log is the evidence
   for growing the vocabulary. See item 4d.
4. **How often is `checkout_state` needed?** It always resolves `unavailable`
   because the abandoned-checkout tool is not in the registry. A high count is
   the argument for wiring it; a low one settles that it was right to leave out.

## 4d. The 19-fact vocabulary is a first guess and needs revisiting

Written 2026-08-09 from reasoning about the corpus, not from measurement. It will
be wrong somewhere — one gap (`checkout_state`) was spotted while writing the
list itself.

**Revisit once a few hundred tickets have run.** The `other_fact` log says what
could not be named; the per-need satisfaction rates say which needs are declared
constantly and never met (either a missing tool or a need drawn too broadly).

**Costs are not symmetrical, so treat them differently:**

- **Adding a need type is cheap.** Old rows never declared it; old measurements
  stay valid for what they measured.
- **Changing what *satisfies* a need is cheap.** The ledger is stored in
  `tool_calls`, so re-run the predicate over historical rows — no model calls.
- **Changing what a need *means* is medium.** Historical rows carry the old label
  under the old meaning, but the emails are stored, so re-running the decomposer
  re-declares them at one `gpt-4o-mini` call per ticket.
- **The expensive one is trust.** Once an operational decision has been made on a
  number derived from these, redefining the type means that decision rested on a
  different basis than its label implies. That cannot be re-run away.

**And a churning vocabulary means no baseline** — every redefinition resets the
"before". So: let it move freely until the first few hundred tickets have run,
then freeze it before drawing any conclusion from the numbers.

## 4b. Task decomposition has never seen a real email

Built and unit-tested 2026-08-09; **not run against live mail.** 35 tests cover
the pure rules, the model call and the wiring, including a no-regression check
that a single-task ticket produces identical opening moves and an identical
prompt to the pre-decomposition path. But no real ticket has been split yet.

**To validate:** `cd agent && npm run investigate:dry-run -- --show` over tickets
that are known to contain two requests, and check three things:

1. **Is it splitting mail that should not be split?** The prompt says one request
   is the normal case, and the gate (`≥320 chars`, `≥2 ?`, or a second subject
   from the categoriser) fires on plenty of ordinary long emails. Count how often
   a decomposition returns 2+ tasks and read a sample. Over-splitting spends
   model calls and dilutes the case file; it is the failure to watch for.
2. **Are the sub-questions faithful?** A paraphrase that drops the product name
   is handed to the IDF-weighted matcher and matches worse than the raw text
   would have. The verbatim `entities.products` are prepended to defend against
   exactly this — check they are actually being extracted.
3. **Does the skipped-task declaration reach the case file?** A `delivery` half
   of a `product` email must appear under `## Non vérifié` or force
   `needs_human`, not vanish. This is prose in the prompt, not a code guarantee,
   so it is the part most likely to be ignored by the model.

**And the cost has not been measured.** Decomposition adds one `gpt-4o-mini`
call to every long ticket. Check OpenAI usage before the worker runs unattended,
alongside item 9's unmeasured investigation cost.

## 5. Product tools run against a thin catalogue

Of 16 products: 5 have `usage_instructions`, 3 have `active_ingredients`, 3 have
`product_faqs`. The tools return what exists, so a usage question finds nothing
for 11 of 16 — a merchandising data gap, not a code one.

**To validate against a real catalogue:** that IDF weighting still separates
products when there are hundreds rather than sixteen (the `creme`-vs-`led`
weighting is a function of catalogue size), and that `ambiguityMargin = 0.12`
still reports genuine ambiguity without flagging every near-name.

## 6b. The order family was enabled with mismatches unexamined — OPEN AUDIT, and the count has fallen to 8

**Opened 2026-08-13, by decision rather than oversight.** `ENABLED_SUBJECTS` now
contains `order`, `delivery`, `payment` and `return_exchange`.

**Re-measured 2026-08-17:** the resolver now records **8 `mismatch`** (down from 15,
after the `message_email` rule rescued 6), plus **4 `not_found`** and **1
`name_match`** — 13 refusals in total, against 52 confirmed. Read the 8; they are
the cases where the number is real, the sender does not own it, and no address in
the message text ties them to it.

**Why it was judged safe.** A mismatch is an order number that parsed correctly
against a real order and was refused because the requester's email hash does not
own it. `isSafeToWrite()` gates the column, so a refused resolution leaves
`tickets.shopify_order_number` **null**. The agent cannot answer about the wrong
order because it never learns which order that was. The failure mode is not a
wrong answer.

**What it does cost.** On those 15, `getOrderContext` reports `not_resolved`, the
`order_identity` need goes unsatisfied, and the agent asks the customer for an
order number they already sent. Annoying, and visible to the customer.

**The working hypothesis is that the check is too strict** — a gift, a partner
ordering for someone else, a customer writing from a second address. Subjects
like *"RE: remboursement commande #5229"* point that way. If that is right, the
fix is in the resolver's identity rule, not in the data.

**To close this item:**

1. Read the 8. For each, decide whether the requester genuinely owns the order.
   `metadata.order_resolution` holds `status`, `candidates`, `email_status` and
   `suggested_action` per ticket.
2. If most are second-address customers, loosen the rule — `message_email`
   already rescued 6 of the original 15 by hashing every address in the body, so
   the remaining ones are those where no address in the text matches either.
3. Count how many tickets asked a customer for an order number they had already
   supplied. That number is the real cost of having enabled early, and it is the
   one to quote when deciding whether the trade was worth it.

**Do not close this by observing that nothing broke.** Nothing breaking is the
predicted outcome; the open question is how often the agent looked foolish.

## 6. Order-number resolver: logic validated end to end, live matching blocked

**Validated 2026-08-01 with a real-data fixture.** Real dev orders and customers,
real corpus email text with the order number substituted, the real store (so the
order lookup and range check genuinely queried Supabase), run dry. All five
scenarios behaved as expected:

| scenario | result |
| --- | --- |
| right owner, right order | `confirmed` via email |
| someone else quoting that order | `mismatch`, not written |
| no email on the ticket, names agree | `name_match`, not written |
| different email, same name | `name_match`, not written, asks for purchase email |
| different email, different name | `mismatch`, not written |
| order number the shop never had | `not_found` |
| untouched corpus text (`#4009`) | `not_found` |

**The range wording was refined off the back of it.** The check had concluded
that anything outside the synced span was "likely not an order number at all",
which it said about `#4009` — a real order, absent only because the dev store
holds twelve rows. `not_found` was the correct status; that explanation was not
something the data could support, since `max` is always somewhat stale (orders
are created continuously, the sync runs on a schedule).

Now proportionate, per the shop owner's call that the max is genuinely useful for
catching typos while orders older than ~6 months are out of scope:

| candidate vs. synced range | wording |
| --- | --- |
| below `min` | "likely older than the ~6 months of orders we keep" |
| just above `max` (within 25%, floor 500) | "may simply be too recent to have synced" |
| far above `max` | "most likely a typo or a reference that is not an order number" |
| inside the range | "no record, though it falls within the orders we hold" |

The absolute floor matters on a small or freshly seeded catalogue, where 25% of
twelve orders is three. Four regression tests hold these apart.

**What still cannot be exercised** is a real confirmed match on live mail: a dry
run over 488 tickets gives 139 `not_found`, 349 `no_candidate`, **0 confirmed**,
because the corpus quotes 101 distinct numbers from 302 to 70853 and the dev
store holds twelve.

**The digit cap is gone.** Order numbers start around four digits and keep
counting as a store sells, so the original `{3,6}` would have silently stopped
parsing once the store passed 999,999 orders — a failure that reads as "we
cannot find your order" rather than as a bug. Length is no longer treated as
evidence: the parser accepts 3-10 digits behind a `#` or `commande`, and the
**database decides** what could be an order. The store's real
`min(order_number)`-`max(order_number)` is read once per pass and used to say
"70853 is outside this shop's issued order numbers (1001-6300)" instead of a
flat "not found".

**To validate once real orders are synced:** run `npm run orders:resolve:dry-run`
and check (a) the confirmed rate, (b) that no `mismatch` is a false alarm caused
by a customer legitimately writing from a second address, and (c) that the range
check does not call genuine orders out of range while the orders table is still
partially synced — a half-synced catalogue reports a narrower range than the
shop has really issued, which would mislabel real numbers.

**Check (b) answered, 2026-08-12, and it was a false alarm 6 times out of 15.**
Each of the six quoted the order's *registered* address somewhere in the message
while writing from another one — three by forwarding the Shopify order
confirmation, three quoting it another way. Those now resolve as `confirmed` via
`verified_by: message_email` (see `DECISIONS.md` → Order resolution), taking
coverage to 50 of 214 tickets. **The remaining 9 are still unreviewed** and are
the real question: a `mismatch` now means the number is real, the sender does not
own it, and nothing in the message ties them to it.

**Still open on this item:** the six writes are validated only by the dry run and
the unit tests. Nobody has yet read the six tickets to confirm the order written
is the order the customer is actually asking about.

**The order-context bundle has now run over live tickets.** Re-measured
2026-08-17: **52 tickets carry a populated `resolved_context`**, one per confirmed
order number, and `getOrderContext` is the most-called tool in the whole ledger (52
calls across 80 case files). The earlier note that `context:build` "currently
considers zero" is retired.

**Two things are still unread.** Whether the bundle each of those 52 tickets got is
the order the customer was actually asking about — the same human check as the six
`message_email` writes above, over a larger set. And 28 of the 52 have no case file
at all yet, so most of this data has not been exercised by the agent (see the
preamble).

**Tracking is settled rather than blocked:** Shopify has no live parcel status here
(`delivered_at` on 1 order in 2 006, `in_transit_at` on none), so the tool can
report a number and never a state. See `AGENT_INTEGRATION_PLAN.md` § Open questions
for the four ways forward.

## 6c. A product name is being looked up as a discount code — KNOWN BUG

**Found 2026-08-14**, on the third ticket after evidence `details` were switched
on. A `product` ticket produced:

```
promotion_validity   satisfied   not_found   { code: "MASQUELEDVISAGE", found: false }
```

**FIRST DIAGNOSIS WAS WRONG, corrected 2026-08-14 by reading the email.** It
blamed `CODE_PATTERN` (`\b[A-Z][A-Z0-9]{3,}\b`) for matching a capitalised
product name. The source message contains **no all-caps run of four characters
anywhere** — the customer wrote « votre Masque LED visage » in ordinary case, and
`extractPromotionCodes` correctly found nothing, which is why
`promotion_identity` reads `none`.

**The model invented the argument.** With no code extracted, it called
`lookupPromotion({ code: 'MASQUELEDVISAGE' })` — a code-shaped string it composed
from the product name in the text — and the tool dutifully reported `not_found`,
which `evidence-rules` recorded as `promotion_validity: satisfied`.

So the regex is innocent and tightening it would fix nothing. The fault is a tool
argument that quotes the customer without being the customer's words.

**It found itself.** The finding alone reads as unremarkable; only the detail
shows the subject is nonsense. That is the argument for details generally, and
it is why this is filed rather than forgotten.

**Harm today is small and not zero.** The verdict was `answerable` either way, so
nothing wrong reached a customer. But a satisfied need is a need the loop stops
collecting, and `promotion_validity: not_found` is a branch answers key on — an
answer set could select "your code does not exist" for someone who never quoted
a code.

**THE FIX, and it generalises past promotions:** a tool argument that purports to
quote the customer must actually appear in the customer's message.
`lookupPromotion` now refuses a code absent from the ticket text and reports
`no_code_in_message` rather than looking it up, so a fabricated argument produces
no finding at all instead of a false one.

That rule is already the codebase's instinct elsewhere — the decomposition's
`entities` are "the one part the model was told to copy rather than rewrite", and
`promotion-lookup.mjs` says outright that when no code is named the tool "says so
rather than guessing which of three active promotions was meant". Guessing was
still reachable, just from the model's side of the boundary rather than the
tool's.

**What it deliberately does not do:** block the model from asking what offers
exist. `listActivePromotions` is the honest path for "is there something else I
could give this customer", which is a real support move and stays available.

**A second wrong guess, corrected by reading the whole email 2026-08-14.** This
entry previously called the routing suspect — "the decomposer split a *product*
ticket into a `promotions` task at all". It did not mis-split. The customer's
last paragraph asks outright: « avez-vous une offre ou une remise en cours sur ce
masque, ou un code promotionnel dont je pourrais bénéficier ? » Binding the
promotion tools was correct.

**And the agent answered that question well.** `listActivePromotions` found
`UKLED20` — 20 % off this exact mask — and the case file established it. That is
the propose-an-alternative-code case working on real mail.

**So the fault is one spurious call, not a misrouted ticket.** Having already
answered the promotion question, the model made an extra `lookupPromotion` with a
code name invented from the product. It cost a tool call and left a junk
`promotion_validity` finding; nothing a customer would see changed. The guardrail
above removes the finding. Whether the extra call is worth chasing further is a
budget question, not a correctness one.

## 7. Two sync gaps that would each close a real check

- **Order-level discount codes.** `orders` stores `total_discounts` (an amount),
  never which codes were applied, so `applies_once_per_customer` can be stated as
  a rule but never verified. Fixable in the orders sync query.
- **The live basket.** Not fixable: there are no cart tables and the Admin API
  does not expose an in-progress cart. The abandoned-checkout lookup is the
  partial substitute, and only for customers who reached checkout.

## 8. Automatic customer resolution HAS run — the link rate is 145 of 214, and nobody has spot-checked it

**Status, re-measured 2026-08-17:** it has run for real against the live table.
**145 of 214 tickets carry a `customer_id`** (68%), against 58 201 synced
customers. The premise this item was written under — a 15-customer dev store making
the match rate meaningless — is gone.

**What is now worth checking is correctness, not coverage.** Any ticket linked to a
customer whose address does not match the requester is a hash collision or a
denylist gap, and it is the kind of bug that quietly puts one customer's order
history in front of another's email. Spot-check a sample of the 145 by comparing
`ticket_first_inbound.from_email` against the linked customer's address.

**The three questions below are still worth reading off a dry run**, which now
reports on the 69 unlinked rather than on all of them: `cd agent && npm run
customers:resolve:dry-run`.

1. **How many tickets are refused as `not_a_customer_address`.** These are the
   contact-form messages whose body did not parse, leaving Shopify's mailer as
   the requester. The count is a direct measure of the parser's blind spots on
   live mail — the ingestion fix took the worst hash collision from 73 tickets
   to 8, and this number should be in that neighbourhood. If it is large, the
   fix is in `contact-form.mjs`, not here.
2. **That `no_match` dominates and that this is expected.** A form-entered
   address is frequently not the address the Shopify account was created with,
   which is unresolvable by design — the tool can only match what the customer
   typed. Worth measuring before anyone treats an unlinked ticket as a fault.
3. **That the daily retry does not thrash.** After a real (non-dry) run, a
   second pass minutes later must report every ticket as `deferred` and write
   nothing. That gate is what keeps a 60-second poll from rewriting a metadata
   row per unmatched ticket per minute.

**The "565 tickets" this item was written against no longer exists** — the live
table holds 214. Read the counts above rather than any figure quoted from that
larger corpus.

## 9. The investigation agent has run, and what it produced is not yet judged

**Status, re-measured 2026-08-17:** run for real on **80 tickets** — 15
`answerable`, 16 `needs_customer_input`, 49 `needs_human`. **70 of those 80 sit on
tickets that are still live** (48 `awaiting_human`, 13 `awaiting_customer`, 9 open
and `answerable`); the other 10 were auto-closed. The 113 tickets still carrying
`needs_investigation` are **not a backlog** — every one is closed and unreachable
(item 16).

| Shape of the 80 case files | |
|---|---|
| median `established` claims | 2 overall, **3** on an `answerable` verdict |
| median `unverified` / `missing` / `do_not_claim` | 2 / 0 / 2 |
| case files with **0** established | 12 — every one forced to `needs_human`, which is the rule working |
| `answerable` by level | L1 3 · L2 10 · L3 2 |
| `answerable` by subject | promotions 5 · product 4 · delivery 3 · order 3 |
| `answerable` carrying prohibitions | 10 of 15 |

Its guardrails were checked against what was actually written: **0 unsourced
claims stored, 0 claims dropped, 0 internal handoffs reaching a drafting
projection, and a maximum of 3 tool calls in any run against a ceiling of 6.**
Those are mechanical properties, and they hold.

**`needs_human` is 49 of 80 (61%), up from 25 of 40.** The expected cause is
unchanged and is now measurable: retrieval has **zero chunks** in `delivery`,
`order`, `promotions`, `payment` and `product_stock`, so for the highest-demand
subjects there is genuinely nothing to answer from. If it stays this high after
that content is written, the cause is the agent.

**What has not been checked is whether the case files are any good.** Nobody has
read a set of them against the emails that produced them and said "yes, a writer
could reply from this". That is a human judgement and it is the only one that
matters here — every mechanical check above can pass while the content is thin.

**To validate:** `cd agent && npm run investigate -- --dry-run --limit 10 --show`
and read the ten dossiers next to the original emails. Three questions:

1. **Is anything in `## Établi` actually false?** This is the one failure that is
   worse than no case file at all, because the drafting agent will treat it as
   ground truth. The ledger check proves a tool *ran*; it cannot prove the model
   read the tool's answer correctly.
2. **Is `needs_human` being used as a shrug?** 25 of 40 is high, and the expected
   cause is the knowledge library — retrieval reports `weak` or `none` on most
   product questions today, so there is genuinely nothing to answer from. If it
   stays this high *after* the ~46 messages' worth of product content is written,
   the cause is the agent, not the library, and the prompt needs the work.
3. **Do the `## Non vérifié` entries belong there?** The line between "the
   customer asserted this" and "a tool established this" is the agent's core
   discipline, and a model putting real tool output under *non vérifié* is
   throwing away evidence as surely as the reverse is inventing it.

**The order family is no longer dormant.** `order`, `delivery`, `payment` and
`return_exchange` are in `ENABLED_SUBJECTS` and all 52 tickets carrying a confirmed
order number have been investigated. **The ten-day stale-parcel trigger still
cannot fire**, and that is now settled rather than pending: `delivered_at` is set
on 1 order in 2 006 and `in_transit_at` on none, so there is no timestamp to do the
arithmetic on. See `AGENT_INTEGRATION_PLAN.md` § Open questions.

**And the cost is not yet measured.** 40 runs on `gpt-4o` at 1-3 tool calls each
is cheap; 565 tickets re-investigated on every customer reply is a different
number, and nobody has looked at it. Check the OpenAI usage for these runs before
the worker is left running unattended.

## 10. The nightly's new timeout, page size and stale-row sweep have not run unattended

Three changes went in on **2026-09-12** after the run of that morning was killed at
the 60-minute cap: `timeout-minutes: 180`, `--page-size=50` on the nightly, and
`failStaleIntegrationEvents` closing rows a killed run leaves on `processing`.
Unit tests cover the sweep; the live behaviour is unproven.

**What is measured.** Single pages against the live shop, 2026-09-12: customers
378 ms at `first:10` / 443 ms at `first:50`; orders 1054 ms / 1359 ms; `first:100`
answered on both connections without exceeding query cost.

**PROVEN THE SAME AFTERNOON, by a run started by hand rather than by the schedule.**
The sweep closed both stuck rows on its first outing (30 August and 06:42 that
morning), each now `failed` and carrying its reason. The sync wrote 58,359
customers and 5,997 orders, and `orders` reached **#6997, created 11:48** — the
two-day gap is closed.

**And it caught a mistake in the same change.** At `--page-size=50` the product
query priced at 1003 against Shopify's 1000-point ceiling and was refused, so the
run died after orders, before products, promotions and the content catalogue. Now
clamped by `PRODUCT_MAX_PAGE_SIZE = 25` (measured live: 30 passes, 40 and 50 are
refused) and re-run by hand — 116 products, 329 promotions, 35 content sources.

**AND THEN A WHOLE NIGHTLY RAN, END TO END: `completed` in 26.0 minutes**, against
71 before the page size changed and a 180-minute cap. Counts carried all five
sources — 58,360 customers, 5,998 orders, 116 products, 329 promotions, 35 content
sources — and `orders` reached #6998. Sustained throttling is therefore priced in
rather than guessed at, and 180 minutes is generous rather than merely enough.

It also ran with no stale rows to close, and printed no sweep line: the sweep fires
on what actually died, not on every start.

**CLOSED 2026-09-13.** The unattended run on GitHub's own runner `completed` in
**35.7 minutes** with all five sources in its counts (58,365 customers, 6,000
orders, 116 products, 329 promotions, 35 content sources). Slower than the 26.0
minutes this machine took — a shared runner is slower — and still a third of the
180-minute cap, against the 60 that was killing it.

**One thing the two unattended runs agree on and it is not good: the schedule is
hours late, consistently.** `0 2 * * *` produced a 06:42 start on 12 September and
06:59 on 13 September — about five hours adrift, twice, which is too consistent to
read as random queueing. 02:00 UTC on the hour is one of the most contended cron
slots on GitHub's shared runners. An uncommon minute off the hour (say `37 3 * * *`)
is the cheap thing to try, and the next two runs are the measurement. It did not
cause the failures, and now that webhooks carry order freshness it costs less than
it did — but a reconciliation pass that lands at breakfast is not the one that was
designed.

**The check that closed this, run after the 02:00 UTC run of 2026-09-13:**

- the new `integration_events` row should be `completed`, not `failed` and not left
  on `processing`. `finished_at - started_at` is the number that says whether 180
  minutes is generous or merely enough — against the 71 minutes the old page size
  took;
- `counts` should carry all five sources, not just customers and orders. Products
  at 116, promotions at 329 and the content catalogue at 35 are what a run that got
  past the cost ceiling looks like;
- `max(orders.shopify_created_at)` should reach that night, from #6997 now.

## 11. The order webhook endpoint has never been called by Shopify

Built 2026-09-12: `/api/webhooks/shopify`, `scripts/lib/shopify-order-webhooks.mjs`,
and both subscription blocks in `shopify.app.toml`. 14 unit tests, `tsc` clean,
and `fetchOrderByLegacyId` checked against the live shop (#1011 came back whole; a
nonexistent id returned null).

**AND IT WAS WRONG, exactly where this said it would be.** Probing the deployed
endpoint with a correctly signed body returned 401. The cause was not the secret
but the header reader: `request.headers` is a `Headers`, `Object.entries` on one
is `[]`, so no signature was ever found and every delivery — real or forged — got
the same 401. Fixed, and both suites now assert it with a real `Headers` rather
than a plain object. The signed probe is the check to re-run after deploying.

**PROVEN END TO END at 15:41 UTC on 2026-09-12, by Shopify itself.** Two deliveries
Shopify originated — identifiable by the `x-shopify-triggered-at` header, which
only Shopify sets — both `completed` with `counts = {"orders": 1}`. Order #6919
went from a copy a week old to current in seconds: `tags []` after the tag was
removed, `shopify_updated_at 2026-09-12T15:41:12`. The assumption the probe baked
in is therefore confirmed: **app-config webhooks are signed with the client
secret**, and `SHOPIFY_WEBHOOK_SECRET` is correctly left unset.

The retry backlog behaved as documented too: the delivery made while the endpoint
was still returning 401 arrived on its own once the fix deployed, 10 minutes after
it was first attempted.

**This item is closed, and the stream has now run unattended overnight.** Twelve
Shopify-originated `order_webhook` rows by the morning of 2026-09-13, **all
`completed`, none failed**. Order **#7001** was created at 09:16 and synced within
seconds — by the webhook, not the sync, which had finished at 07:35. That is the
whole point of the feature, working on a real order nobody staged.

`orders/create` and `orders/paid` both fired for the first time on that order,
alongside `orders/updated`. **Still unexercised: `orders/cancelled`,
`orders/fulfilled` and `refunds/create`.** `refunds/create` remains the one to
watch, since it is the only topic whose payload needs `order_id` rather than `id`
— covered by a unit test, never by a real delivery.

**Blocked on two things only a person can do:** the deployed URL in place of
`REPLACE-ME` in both `[[webhooks.subscriptions]]` blocks, and `shopify app deploy`.

**The check, once a real delivery has been made** — place or edit a test order, then:

- an `integration_events` row with `event_type = 'order_webhook'`, `status =
  'completed'` and `counts = {"orders": 1}`. A row that says `failed` with an HMAC
  error means the secret is wrong; NO row at all means the request never arrived,
  which is Deployment Protection or the middleware, not the handler;
- that order's `synced_at` in `orders` within seconds of the change, not at the
  next nightly;
- Shopify's own delivery log (Partners → the app → Webhooks) showing 200s. A 401
  there with a row here is impossible; a 401 there with no row is the signature.

**Then remove `SHOPIFY_ADMIN_API_ACCESS_TOKEN` from the question:** with it set,
each webhook reuses the stored token; without it, `createShopifyClient` mints a
fresh one per delivery, which is a second Shopify call on every webhook. Worth
measuring before the volume matters.


## 12. `import:exemplars` overwrote a dashboard-authored situation — INCIDENT, 2026-09-17

**What happened.** A new situation was written into `Email-Example-Queries.md`
under the key `P-21` and imported. `P-21` already existed in the database —
authored in the dashboard on 2026-09-04, approved, answer set `promotions`, and
absent from the document. The importer upserts on `(shop_id, exemplar_key)`, so
it replaced that row's `canonical_question`, `category`, `request_kind`,
`requirement_needs`, `demand_message_count` and `source_note`, and overwrote its
four phrasings in place.

**What it cost.** The old text. Nothing else: `approval_status`, `answer_set` and
`collection_mode` are never written by the importer, both rules
(`p21_offre_produit`, `p21_offre_en_cours`) live in another table and were
untouched, and **no ticket was affected** — no investigation had ever matched
P-21, so nothing was drafted or answered from it.

**How it was repaired.** `CHANGELOG.md` (2026-09-04) and `DECISIONS.md` § "An
empty offer dropdown says nothing" record the situation in prose, which is how
the canonical question and two of the three variants were recovered verbatim:
« Avez-vous une offre ou un code promotionnel en cours ? », the anchor ticket's
« avez-vous une offre ou un code promotionnel dont je pourrais bénéficier ? »,
and the product-scoped form the decomposer produced. The fourth phrasing ("a
customer waiting for a promotion before ordering") was described but never
quoted, so it is a REWRITE and `source_note` on the row says so. The new
situation was moved to `P-22`.

**The hole this leaves open.** `import-exemplars.mjs` only detects duplicate keys
WITHIN the document (`parseExemplars` warns and keeps the first). It has no idea
which keys exist in the database, so any key created in the dashboard can be
silently replaced by a file import. The fix — refuse to write a key that exists
in the database but not in the document, unless a flag says to adopt it — is NOT
built. Until it is, check `select exemplar_key from support_exemplars` before
adding a key to the document.

**A second, smaller lesson.** The prose documents were the only backup. That they
were enough is luck, not a system: a situation authored in the dashboard and
never written about would have been unrecoverable.

## 13. The attachment repair has run; what it uncovers has not been judged — 2026-09-20

**The fix is proven, the consequences are not.** `hasAttachments` is false for an
inline-only message, and three readers treated that as "nothing attached" (see
`CHANGELOG.md` → *A customer's inline photo was invisible to everything* and
`DECISIONS.md` → *`hasAttachments` is not evidence of absence*). The backfill has
since run over the whole corpus: **292 of 292 rows filled, 0 failed, 0 gone, 25
carry a photo**, and `ticket_messages.attachments` is now non-null everywhere.

**What is proven.** That the rows can be filled, and that `d48f1c08`'s 3.6 MB July
photo is on the record. Verified by query, not inference.

**What is not.**

1. **The photo counts in `DECISIONS.md` are stale.** « 7 carry a real photo, 36
   mention one and attached nothing, 160 neither » was measured over 203 tickets
   from the *flagged* rows only. 25 messages now carry a photo. **Check:**
   re-measure the three-way split across tickets and correct that paragraph.
2. **The furniture rule has not been re-judged against inline images it never
   saw.** The 50 KB floor plus name pattern was calibrated on the old set. The
   backfill's own output already shows one marketing banner —
   `bannières mails (16 × 3 cm) (3).png`, 87 KB — counted as a photo. **Check:**
   list the 25 and confirm each is customer evidence rather than furniture.
3. **One case file has been rebuilt on the new data: `d48f1c08`'s, and it now
   works.** `order` gained `checkPhotoEvidence`, `checkPhotoEvidence → attached`,
   and « Le client a joint une photo à son message » is an established fact where
   the dossier used to say the photo was not available. **Every other ticket whose
   messages now carry a photo is still reading a case file built before the
   repair. Check:** find them and re-investigate —
   `select distinct ticket_id from ticket_messages where jsonb_array_length(attachments) > 0`,
   intersected with `ticket_investigations.investigated_at < 2026-09-20`.
4. **`not_checked` has never been produced by a real run.** Post-backfill it can
   only appear where mail has left the mailbox, which is currently zero rows.
   Its behaviour — absent from `ASK_ANSWERED_BY`, so the ask still happens — is
   covered by unit tests and nothing else. **Check:** confirm on the first run
   that produces one.

## 14. The new Insights panels and the sales report have not been looked at — 2026-09-22

Overview, Marketing & funnel, the stock card, the month picker and the monthly
report are type-checked, linted, unit-tested, and every service was run against
the live database (August 2026, September in progress, 30 days, all time,
Amazon). What that cannot prove:

1. **Layout.** No page was opened in a browser. **Check:** open
   `/insights/overview?month=2026-08` and `/insights/marketing`, narrow the window
   to phone width, and download the August report from Overview; open the file
   with scripts on (tabs, MoM / YoY) and as an email attachment preview (all
   sections, MoM deltas).
2. **Stock that is not tracked reads as out of stock.** Five active products are
   listed out of stock, including two samples; a product Shopify does not track
   inventory for would read 0 as well. **Check:** confirm each of the five in
   Shopify admin, and whether any should be excluded.
3. **Amazon units look low** — 2 paid units over 9 Amazon orders in August 2026,
   because most Amazon lines carry no `product_id`. The Sales panel counts them
   the same way. **Check:** read three Amazon orders' `line_items` and decide
   whether units should fall back to the line quantity.
4. **The report takes ~8 s to build** (14 reads over 3 periods, 12 months and
   products). Fine for a download; revisit if it is ever built inside a request
   with a timeout.

## 15. The storefront figures are live on the panels, and unverified against the admin — 2026-09-23

`npm run probe:analytics` settled what ShopifyQL answers; the panels, the report
and `web/lib/server/insights/analytics.ts` now read it live at render time
(sessions, conversion, pageviews, bounce, channels). Measured against the live
store across every range and both marketplaces. What is **not** settled:

0. **The admin check has now found THREE errors, which is the argument for
   doing it on every new figure.** Bot traffic in the denominator (below), an
   AOV built on Total sales rather than net sales, and a funnel this repo
   declared impossible while it was a column name away. None was findable by a
   test: each figure was internally consistent and agreed with every other
   figure on the page. **Check:** before any new Shopify-sourced metric ships,
   read the same window in Analytics → Reports and compare.

1. **CLOSED 2026-09-23, and it found a real error.** The owner read 25 Aug –
   23 Sep in the admin: 5,076 human sessions, 125 completed checkouts, 2.46%.
   The panels read 6,839 at 1.89% — because `sessions` counts bots and the admin
   counts humans. Every sessions query now carries
   `WHERE human_or_bot_session = 'human'`, and the same window reads **5,148 at
   2.43%** against the admin's 5,076 at 2.46%; the residual is the current day
   moving between the two readings. **What remains:** re-check one CLOSED month
   (nothing moving) and confirm it lands within a whisker, and check whether the
   bot share is stable — it was 25% over this window, and a month where it
   swings is a month where a trend read from it misleads.
2. **The clock is reasoned about, not proven.** An hour series for this shop
   starts at 22:00Z, which is 00:00 Paris, so ShopifyQL days look like shop-clock
   days and are treated as such. **Check:** compare one day either side of a
   month boundary against `insights_orders_series`, and a DST weekend.
3. **Session history starts before the storefront was busy.** Monthly sessions
   exist from Sep 2024 (0, then 7, 71, 13, 15) and only reach thousands from
   March 2025 — the same ramp the orders show. **Check:** confirm those early
   months are real rather than a partial rollout, or the report's YoY divides by
   a number nobody trusts.
4. **Nothing yet proves the failure path in a browser.** The timeout, the
   refusal and the marketplace block are unit-tested and were exercised by the
   Amazon filter; a real Shopify outage has not been seen. **Check:** point
   `SHOPIFY_STORE_DOMAIN` at an unreachable host once and confirm the panel
   renders with blocked cards rather than an error page.
5. **AOV and net sales now depend on a live read.** When Shopify cannot be
   reached the AOV card falls back to Total sales ÷ orders and says which
   formula it used; net sales and the bridge render blocked. Seen twice in
   testing through transient local network failures. **Check:** confirm the
   fallback label is visible enough that nobody quotes the fallback as Shopify's
   figure.
6. **The line-revenue caption is untested against a reader.** Product, country
   and promotion revenue are VAT-inclusive line totals (€9,608.95 for August)
   and will not sum to either headline. **Check:** ask someone who did not build
   it whether the caption makes that obvious.
7. **The five-minute cache is per process.** Serverless means several instances,
   each with its own copy, so two readers can see figures minutes apart while
   both are within TTL. Acceptable for traffic figures; worth knowing before
   anyone reports a discrepancy as a bug.
