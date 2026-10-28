<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Page speed

### Most of a slow page was reads waiting on each other, not the data (2026-09-18)

Measured against the live database from the dev machine, one round trip costs ~76 ms at best and ~200 ms typically. The Sales panel at "Last year" ran, **one after another**: the shop id for the badges (~200 ms), the **whole ticket queue** for the badges (~490 ms), the shop row again for Insights (~200 ms), `insights_freshness`, and only then the panel's own reads (~1.9 s in parallel). Tickets and Orders read the whole queue twice, once for the badges and once for their list.

Three changes, none of which can show older data than before:

- **The shop row is remembered for five minutes** (`lib/server/shop.ts`). It is upserted on the domain, so a sync keeps the id; the timezone is the one field a sync could move, which is why the memory is five minutes and not the process's life. **A missing row or a failed read is never remembered**, so "run a sync first" clears as soon as the sync lands.
- **The badges are started beside the page's reads, not before them.** `navBadgeCounts` never throws, so a started-and-awaited-later promise cannot fail the page.
- **The queue and sender directory are read once per request** (React `cache` in `tickets-service.ts`), shared by the badge and the list. `cache` is scoped to one server render, so nothing outlives the request, and the badge can no longer disagree with the list beside it.

**Not done, on measurement: starting `insights_freshness` beside the panel.** Warm, it takes 190–230 ms (the ~600 ms first measured was a cold call). It is not only a label: it decides whether the previous-window reads run at all (`previousCovered`, Support's `mailCurrent`), so running it in parallel would mean speculatively firing those reads and discarding them — five panel services refactored and more load on a database that is already the bottleneck (below), for ~0.2 s.

### Sidebar navigation holds the old page rather than showing a skeleton (2026-09-18)

A plain link to a server-rendered page shows nothing until the new page has arrived, so a click read as a click that missed. `AppShell` now runs sidebar clicks through `router.push` in a transition: the clicked item lights up at once and the current page stays, dimmed, under "Loading Orders…" — the Insights frame's rule, applied everywhere. Modified clicks (new tab, new window) are left to the browser.

**`loading.tsx` was the obvious tool and is wrong here, twice.** Each page draws `AppShell` itself, so a route skeleton would render with no sidebar. And Orders changes its URL on every filter and page turn; a `loading.tsx` there would swap the table for a skeleton and remount the list on each one, wiping the search box that deliberately owns its text while typing (§ Orders).

### A SQL function is planned without its arguments, and one shape did not survive that (2026-09-18)

`insights_customer_mix()` took **961 ms on a year and 1,589 ms on all time**; its body, run as a plain query with the values filled in, took **80 ms**. A SQL-language function (with `set search_path`, so never inlined) is planned generically — Postgres does not know the range, guesses a handful of rows, and planned "the range's orders as a CTE, joined back to each customer's first order" as a nested loop across both: **10,122,837 row comparisons** on a year. Reproduced with `plan_cache_mode = force_generic_plan` on the plain query.

`30_customer_mix_plan.sql` groups the range by customer first and looks each customer's first order up through `orders_shopify_customer_id_idx`, so there is no plan left that compares every row with every row: **68 / 102 / 118 ms** for six months / one year / all time, measured on the generic plan, and 69 / 106 / 118 ms on the live function once applied. Same name, arguments and columns. Before shipping, the live function and the new body were compared over every preset (current and previous window) and every platform filter — **60 combinations, 0 differences**.

**The general lesson for the ranged functions: test a new one under `force_generic_plan`**, not only as a plain query, because the plain query is not what runs. The other Sales reads were measured the same way and are 100–300 ms alone; they are slow in the panel (800 ms–1.4 s) only because eleven run at once and the database queues them. Fewer, combined calls per panel — or more database compute — is what would move that, and it is an open decision, not a fix to make quietly: it reverses "each ranged figure is its own SQL function" (§ Insights).

### Each page reads what it shows, and Insights shares one cached answer (2026-10-06)

The reads were measured live against the free plan's egress and database limits:

| Read | Size | Time | When |
|---|---|---|---|
| The whole queue, for the sidebar badges | 993 kB | 3.2 s | every page |
| Blocked emails with their text | 1.9 MB | — | every /tickets |
| Priority: linked orders with all their jsonb | 718 kB | — | every /tickets |
| Priority: every investigation's full `exemplar_match` | 256 kB | 4.9 s | every /tickets |
| `insights_freshness` | — | 12.3 s cold, 250 ms warm | before every Insights panel |

The changes:

- **The badges count open threads only, shared for a minute.**
  - `countOpenThreads` reads `queue({ openOnly: true })` (52 rows, 50 kB). Its `open` test discarded every closed or resolved row anyway, and the list item's `status` is the same column, so the counts are identical.
  - It is cached through `unstable_cache` with tag `tickets`, for 60 s.
  - Every dashboard route that changes a ticket calls `ticketsChanged()` (`lib/server/cache-tags.ts`), so a person's own change shows at once. Mail the worker stores shows within the minute.
  - This amends « the queue is read once per request, shared by the badge and the list » above: the badge now has its own, much smaller read.
- **Blocked emails are listed without their text.**
  - The dialog reads `GET /api/dropped-mail/[id]` (text and parcels) when it opens.
  - `hasBody` comes from an id-only read, so « add as ticket » is still enabled exactly where a text exists.
- **Priority reads what the band needs.**
  - It reads `exemplar_match->policy->>situation_key` and `exemplar_match->>exemplar_key` instead of the blob: the same situation for all 193 runs, 38 kB against 256.
  - It reads an order projection without line items, refunds, returns or discounts: the same state, dates and country for all 180 linked orders, 252 kB against 718.
- **The Orders marks read the order-linked threads and their case siblings, not the queue.** The siblings are read because `withCaseFacts` lets a thread borrow its case's situation, so the bands match the queue's.
- **Insights reads through Vercel's shared Data Cache, at most 15 minutes old** (`INSIGHTS_TTL_SECONDS`).
  - `callRpc`, `readView`, the freshness row and ShopifyQL are each cached on their exact arguments, with tag `insights`. Ranges are cut on hour or day boundaries, which is what makes the keys repeat.
  - A stale entry is served at once and recomputed behind it, so a panel opened before shows instantly.
  - « Live · HH:MM » now shows when the cached figures were read, not when the page rendered.
  - The 5-minute auto-refresh re-reads the cache. The ↻ button clears the tag first (`POST /api/insights/refresh`).
  - The Tickets freshness banner still reads live, because « mail synced 2 minutes ago » must not be 15 minutes old.
  - **Insights' freshness row is never served stale (2026-10-28).** Stale-while-recompute meant the first visit after two quiet days showed the row from two days earlier, and its age is taken against now: « Orders synced 2 days ago », « Email 2 days ago », while the nightly had finished that morning and mail had arrived minutes before. The cached row is used only within the TTL; past it, the row is read live (~250 ms, once per stale visit). « Live · HH:MM » still dates the cached panel figures.
  - Settings → Agents' usage figure goes through `callRpc` and is cached the same way.
- **The other Insights tabs are prefetched in full once the tab bar is on screen**, so switching tabs shows a page already rendered. This is affordable only because every read behind it is the shared cache.
- **The cold freshness.** `max(updated_at)` on `customers` was a full scan of about 76 MB of pages, slow whenever they had fallen out of the free plan's small cache. `77_updated_at_indexes.sql` adds `(shop_id, updated_at)` indexes on customers, orders and tickets. The worker's change gate asks the same question.

**Closed threads are read when the Closed tab opens** (decided by the user). /tickets renders the open threads only (51 kB). The tab's count is a `count=exact` HEAD (`countClosedTickets`), checked equal to the rows the tab loads (847 = 847). `GET /api/tickets/closed` reads them the first time the tab is opened. Three details:
- **A link to a closed ticket still opens.** `?ticket=` is read on its own by the page. A view restored from sessionStorage loads the closed threads first.
- **Status changes move rows between the two halves.** The count adjusts for rows closed or reopened before the tab loaded.
- **The priority of a partial list scores its case siblings too**, as the Orders marks do.

**The blocked-email list is paged, and a clear is the shop's** (decided by the user).
- `78_dropped_mail_list.sql` adds `dropped_mail_clears` and the view `dropped_mail_list`. The view holds blocked decisions minus the cleared and the promoted ones, with `has_body`, and gave the same 1,272 rows and 1,171 with text as the old two-step logic.
- The page reads 200 rows at a time, newest first, with the total in the same request (108 kB). « Load more » appends the next page.
- **The search runs in the database**, because the page holds only what it loaded.
- **A clear is recorded server-side.** « Clear » was a localStorage list in one browser, so the server still sent every cleared row to every page. Cleared mail is now never sent to the UI again until « restore ».
- **Shared across the shop.** One person's clear hides the row for everyone, and « restore » brings every cleared row back.
- **Old clears move over once.** What an older page left in localStorage is posted to the server on the next visit, then the key is removed.

**Not done, deliberately: no timed warm-up job.** The stale-while-recompute behaviour already makes every panel and range opened before instant. A job would only speed the first-ever view of a range, at the cost of Shopify and Supabase traffic every 15 minutes through the night.

### A period switch shows at once; the other tabs are prefetched after it, one at a time (2026-10-26)

The owner's complaint was the wait when switching time frame, the left-hand presets especially. It was measured on a production build against the production database, starting from an empty cache. The click → screen times and the server log of each read agreed:
- 1 year took **18 s**, though Overview's own reads took 0.9 s;
- 7 d / 24 h / 6 m took 1–2 s;
- going back to 30 d took 3 s;
- tab switches were instant.

**Three causes, three changes:**
- **The prefetch storm.** Every range change made the tab bar prefetch all seven other panels at once, for the new range. At 1 year that was Sales 9 s, Marketing 10 s and Fulfilment 14 s. Their setup reads took 2–4 s, against ~0.2 s alone. Marketing's Shopify queries also ran against the same throttled minute as Overview's money cards.
  - Now the other tabs are prefetched **3 s after the panel has arrived, one every 2 s**, and the queue restarts if the range changes meanwhile. A pointer on a tab prefetches it at once (`InsightsNav`).
  - Tabs stayed instant in the measurement, which is why prefetching was rescheduled rather than dropped.
- **The transition waited for Shopify.** Under the same React key, a Suspense boundary already showing content is kept rather than shown loading, so a range switch waited for the slowest Shopify card. The panel is now keyed by its shop, period and platform (`InsightsPage` `periodKey`): the switch lands with the database figures and each Shopify card fills in on its own.
  - Only those keys: a filter inside a panel (Sales' product) keeps the panel and its search box.
- **Fulfilment rebuilt the ticket queue on every render** to ring orders that have a ticket: 3.4–6 s, cached or not. The marks (order number → band, count; nothing about a person) are now shared for 60 s under the `tickets` tag (`order-ticket-marks.ts`), like the sidebar badges; a dashboard ticket change clears them.

**A preset is prefetched on hover** (`FilterBar` → `useInsightsFrame().prefetch`). Next keeps a full prefetch for 5 minutes, so going back to a range is instant too. `staleTimes.dynamic: 0` stays, for Agent Setup's sake.

Not prefetched up front: five ranges rendered on load would spend Shopify's minute on ranges nobody picks.
