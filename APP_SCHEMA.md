# APP_SCHEMA

**Codebase navigator: where things are.** Why they are that way lives in `DECISIONS.md` — read the matching section there before changing any behaviour described here.

Three npm packages: root (`scripts/`), `web/`, `agent/`. Shopify (source of truth) → Supabase/PostgreSQL (+pgvector) → Next.js 14 App Router + TypeScript + React 18 dashboard (CSS Modules, no UI framework). AI provider: OpenAI.

Secrets live in one repo-root `.env.local`; `web/next.config.mjs` and `agent/src/config.mjs` both load it.
Conventions: `*.test.mjs` sits next to its source (`npm test` = `node --test`); every `.tsx` has a sibling `.module.css`. Neither is listed below.

## Map

```text
|-- *.md             # AGENTS (rules) · DECISIONS (why) · PRODUCT (design) · README (status)
|                    # AGENT_INTEGRATION_PLAN + Agent_Workflow (agent phases)
|                    # SHOPIFY_PERSONAL_DATA_PROTECTION + MERCHANT_DATA_USE_DISCLOSURE
|-- package.json     # sync:shopify:* · embed:* · import/translate:exemplars · cluster:tickets
|                    # report:knowledge-gaps · report:investigation-calls
|                    # report:evidence-vocabulary · report:completeness-gate
|                    # report:collection-planner · report:collection-replay
|                    # probe:analytics (what ShopifyQL will answer)
|                    # sync:klaviyo (flows + campaigns; key from Vault)
|                    # db:apply:migration · test
|-- shopify.app.toml # Shopify app scopes (all read_*)
|-- web/
|   |-- app/
|   |   |-- layout.tsx globals.css        # root layout · design tokens (teal, scale, radii)
|   |   |-- page.tsx                      # / -> /agent-setup redirect
|   |   |-- home/page.tsx                 # Server Component: the management chat (Beta);
|   |   |                                 # developer + management only
|   |   |-- agent-setup/page.tsx          # Server Component: article + source fetch
|   |   |-- agent-setup/layout.tsx        # AppShell + the tab bar, shared by all three
|   |   |-- agent-setup/rules/page.tsx    # Server Component: the rulebook
|   |   |-- agent-setup/parameters/page.tsx  # Server Component: the numbers
|   |   |-- tickets/page.tsx              # Server Component: the agent's queue --
|   |   |                                 # EVERY ticket, staff-sent included
|   |   |-- orders/page.tsx               # Server Component: every Shopify order, paged
|   |   |                                 # in SQL; reads ?status= ?country= ?vip= ?page=
|   |   |-- orders/[id]/page.tsx          # Server Component: one order on cards
|   |   |-- insights/                     # -> /insights/overview, then one route
|   |   |                                 # per panel: overview · sales · marketing ·
|   |   |                                 # fulfilment · support · customers · agent.
|   |   |                                 # Each reads ?range= (24h|7d|30d|6m|1y|all),
|   |   |                                 # ?month=YYYY-MM or ?from=&to=, and ?platform=
|   |   |-- settings/page.tsx             # Server Component: My info · Agent settings (?tab=agents)
|   |   |                                 # · Integrations (?tab=integrations; not contact)
|   |   |-- login/                        # page.tsx + LoginForm: the only page open
|   |   |                                 # without a session
|   |   `-- api/
|   |       |-- chat/route.ts                 # POST a question -> NDJSON stream (the
|   |       |                                # management chat's agent loop) ·
|   |       |                                # chat/conversations (+ /[id]): the user's own
|   |       |-- auth/{login,logout,me}/route.ts  # Supabase Auth: sign in (throttled,
|   |       |                                # one error for every failure) · sign out
|   |       |                                # (revoked at Supabase too) · who am I
|   |       |-- webhooks/shopify/route.ts     # PUBLIC (HMAC, not a session). One URL
|   |       |                                # for every topic, dispatched on
|   |       |                                # x-shopify-topic: orders -> order
|   |       |                                # webhooks, the three privacy topics ->
|   |       |                                # compliance. Reads request.text(), never
|   |       |                                # .json() — the HMAC is over raw bytes
|   |       |-- tickets/[id]/route.ts         # GET case file + order facts · PATCH status
|   |       |-- tickets/[id]/draft/route.ts   # PATCH approve / edit / reject a draft
|   |       |-- tickets/[id]/order/route.ts   # GET preview an order · PUT link it by hand
|   |       |-- tickets/[id]/thread/route.ts  # GET the conversation (message bodies)
|   |       |-- tickets/[id]/attachments/[index]/route.ts
|   |       |                                # GET one photo, proxied from the mailbox.
|   |       |                                # The only binary response in this API;
|   |       |                                # nothing is stored. attachment-service.ts
|   |       |-- forwarding/route.ts           # GET 14 categories · PUT upsert one
|   |       |-- settings/integrations/klaviyo/route.ts  # GET status · PUT {key} (checked
|   |       |                                  # with Klaviyo, then Vault) · DELETE. Never
|   |       |                                  # returns the key. Closed to contact
|   |       |-- insights/vip-rule/route.ts   # GET the rule / preview a draft count ·
|   |       |                                  # PUT save or clear it (vip-rule.mjs)
|   |       |-- insights/segment-finder/route.ts  # POST a segment -> matching customers
|   |       |                                  # (validated by segment-finder.mjs; logs
|   |       |                                  # access when it names anyone)
|   |       |-- insights/topic-map/route.ts  # POST rebuild the topic map (no args;
|   |       |                                  # one run at a time) — topic-map-rebuild.ts
|   |       |-- insights/support/marketable-contacts/route.ts
|   |       |                                  # GET the consented outreach list as CSV
|   |       |                                  # (the ONLY bulk personal-data export)
|   |       |-- insights/report/route.ts     # GET ?month=YYYY-MM -> the monthly sales
|   |       |                                  # report as an HTML download (default: last
|   |       |                                  # complete month). report-service.ts +
|   |       |                                  # sales-report.mjs; aggregates only
|   |       |-- knowledge/                   # shopify-sources · articles · articles/[id]
|   |       |                                 # · articles/[id]/resync
|   |       `-- agent-test/                   # run (NDJSON stream, writes no ticket) ·
|   |                                         # runs · runs/[id] (ideal answer)
|   |-- components/
|   |   |-- icons.tsx                # inline SVG icon set
|   |   |-- app-shell/               # AppShell (top bar + drawer; fetches /api/auth/me
|   |   |                            # once for both; runs sidebar navigation in a
|   |   |                            # transition: old page dimmed + "Loading …" pill,
|   |   |                            # no loading.tsx) · Sidebar (Home drawn by role) ·
|   |   |                            # UserMenu (who is signed in, Sign out)
|   |   |-- chat/                    # ChatView (conversation tabs + History menu, thread,
|   |   |                            # composer + conversation cost; reads the stream;
|   |   |                            # closing a tab only hides it) · ChatTurn (answer + "How this
|   |   |                            # was answered": each query, its SQL and rows) ·
|   |   |                            # ChatMarkdown (answers as React, never HTML)
|   |   |-- ui/                      # Button · StatusChip · Dialog (modal shell) ·
|   |   |                            # TrackingText (tracking numbers -> carrier links,
|   |   |                            # used by every surface showing a number in prose)
|   |   |-- settings/                # SettingsView (Insights kit: tabs, cards, tables) ·
|   |   |                            # KlaviyoKeyCard (write-only key field, last sync)
|   |   |-- orders/                  # OrdersView (filters + table + pager, URL state;
|   |   |                            # customer name ringed by open-ticket band) ·
|   |   |                            # OrderDetailView (Articles · Fulfilment · Payment ·
|   |   |                            # Tickets · Customer · Destination · Tags cards,
|   |   |                            # reusing insights Card + Flag)
|   |   |-- insights/                # InsightsPage (shell + header + one panel) ·
|   |   |                            # InsightsFrame (URL navigation, pending dim) ·
|   |   |                            # PinBoard (pin a row to the top, 2 max, per
|   |   |                            # panel in localStorage; Grid pin="id") ·
|   |   |                            # InsightsHeader + InsightsNav + FilterBar +
|   |   |                            # LiveRefresh (5-min refresh) · InsightsKit (Grid
|   |   |                            # Card KpiCard DeltaChip BlockedCard BarList) ·
|   |   |                            # TimeSeriesChart · ColumnChart (stacked, negative,
|   |   |                            # net line) · SplitBar · Segmented · Flag (inline SVG) ·
|   |   |                            # tables.module.css · SalesView + BestProducts (searchable,
|   |   |                            # accent-insensitive, rank kept) +
|   |   |                            # CountrySales + ProductPairs · ProductPerformance
|   |   |                            # (table: revenue, deltas, growth/declines,
|   |   |                            # search, country, VIP) + CollectionMix (the six
|   |   |                            # ranges + what falls outside) · OverviewView +
|   |   |                            # OverviewTrend (metric switch) + ReportDownload ·
|   |   |                            # MarketingView + MarketingChannels (Klaviyo
|   |   |                            # read; Paid/Social blocked) · InventoryCard (stock
|   |   |                            # table, Overview + Fulfilment) · FulfilmentView ·
|   |   |                            # OpenOrders · SupportView + TopicMap · CustomersView +
|   |   |                            # VipRuleCard + SegmentFinder + CustomerActivityRows · AgentView
|   |   |-- tickets/                 # TicketsView (orchestrator) · TicketSection ·
|   |   |                            # TicketStatCards · TicketTable · TicketDetailPanel ·
|   |   |                            # TicketThreadDialog · DroppedMailTable +
|   |   |                            # DroppedMailDialog · OrderLinkDialog (add /
|   |   |                            # change / confirm a ticket's order) · LevelChip ·
|   |   |                            # HappinessFace
|   |   |-- agent-test/              # TestChatDialog (the rehearsal, + Reuse this
|   |   |                            # message) · TestComposer · RunTranscript +
|   |   |                            # StepCard (the step cards; StepCard owns the
|   |   |                            # parcel context Verbatim links through) ·
|   |   |                            # RunHistory · IdealAnswer (the memory)
|   |   `-- agent-setup/             # AgentSetup + SetupHeader (orchestrator, mutations) ·
|   |                                # ArticleLibrary (left pane) · ArticleWorkspace +
|   |                                # BrandVoiceWorkspace (right pane) · RichTextEditor ·
|   |                                # WorkspaceHeader EditorFooter CategorySelect
|   |                                # SourcePageSelect ChipList Toast (and friends)
|   |-- lib/
|   |   |-- session-cookies.ts   # writes/clears qos_at + qos_rt (the session
|   |   |                        # outlives the hour-long access token)
|   |   |-- types.ts             # UI types + label tables (categories, levels, VipRule, RFM)
|   |   |-- chat-types.ts        # isomorphic: the management chat's API + stream shapes
|   |   |-- knowledge-mapper.ts  # isomorphic: API JSON -> UI types
|   |   |-- agent-test-types.ts  # isomorphic: the trace shapes the test chat renders,
|   |   |                        # + parcelsFromTrace (the run's parcels, for links)
|   |   |-- tracking-links.ts    # isomorphic: the one import of scripts/lib's
|   |   |                        # splitTrackingText into the browser bundle
|   |   |-- ticket-stats.ts      # isomorphic: summariseTickets + isClosed
|   |   |-- ticket-detail.ts     # pure, 3 projections: case file -> 3 blocks ·
|   |   |                        # resolved_context -> order owner / status / tracking lines ·
|   |   |                        # evidence_gaps -> the facts behind the findings
|   |   |-- api/                 # client-side fetch wrappers (knowledge, tickets, forwarding)
|   |   |-- insights-format.ts   # isomorphic: every Insights formatter, incl.
|   |   |                        # formatValue(unit) for the client charts
|   |   |-- relative-time.ts demo-data.ts
|   |   `-- server/              # knowledge-service · forwarding-service ·
|   |       |                    # tickets-service (list + detail + thread + status,
|   |       |                    # + listTicketsWithOrders for the Orders page) ·
|   |       |                    # orders-service (orders_list page + one order) ·
|   |       |                    # chat-service (Home's chat: wires the loop, writes
|   |       |                    # the chat_* log, owner-only reads) ·
|   |       |                    # dropped-mail-service · knowledge-errors ·
|   |       |                    # integrations-service (Klaviyo status/save/remove) ·
|   |       |                    # auth (getSession, re-checked not trusted) ·
|   |       |                    # access-log (a data_access_events row per
|   |       |                    # named-customer view, actor = the user) ·
|   |       |                    # shop (the shop row: id + timezone, kept 5 min,
|   |       |                    # failures never kept) · timing (PAGE_TIMING=1
|   |       |                    # prints each page read's ms to the console)
|   |       `-- insights/         # shared (readView + callRpc -- NO paging) ·
|   |                             # context (shop, tz, range, platform, freshness
|   |                             # from the URL) · series (sparse SQL -> points,
|   |                             # with coverage) · orders (shared by sales +
|   |                             # fulfilment) · one service per panel: sales ·
|   |                             # fulfilment · support · customers (+ customer-
|   |                             # activity for the ranged rows, + newsletter
|   |                             # movement) · agent · overview · marketing ·
|   |                             # inventory (stock at risk, now) · marketing
|   |                             # also reads Klaviyo (insights_klaviyo_messages) · analytics
|   |                             # (ShopifyQL, one promise per card group: the
|   |                             # money ladder LIVE for the exact window, first;
|   |                             # sessions = stored closed months + live rest;
|   |                             # trend, channels, landing, product pages live;
|   |                             # failure = blocked) · shopifyql (the priority
|   |                             # queue: one query per request, waits out the
|   |                             # analytics bucket, 5-min cache per query) ·
|   |                             # report-service
|   |                             # (the month rendered three ways: MoM, YoY and
|   |                             # 6M on the same 6M a year earlier — each mode
|   |                             # carries its own period, products, collections
|   |                             # and platform mix) ·
|   |                             # marketable-contacts (CSV; consent is the
|   |                             # query filter) · topic-map-rebuild
|   |-- middleware.ts            # THE GATE: every page + API needs a Supabase
|   |                            # session; refreshes the hour-old token; role
|   |                            # rules from dashboard-auth.mjs
|   |-- next.config.mjs          # loadEnv() from root .env.local; staleTimes 0
|   `-- tsconfig.json            # allowJs, so services can import scripts/lib/*.mjs
|-- scripts/                     # one sync orchestrator per Shopify resource
|   |-- sync-shopify-{products,customers,orders,promotions,content-catalog}.mjs
|   |-- sync-shopify-nightly.mjs         # runs them all in order, storefront months last
|   |-- sync-storefront-months.mjs       # closed months of sessions -> Supabase (backfill / button)
|   |-- sync-klaviyo.mjs                 # Klaviyo flows + campaigns -> Supabase (also last in the nightly)
|   |-- embed-{knowledge-chunks,ticket-messages,exemplars}.mjs  # embedding reconcilers
|   |-- import-exemplars.mjs             # Email-Example-Queries.md -> exemplar rows
|   |                                    # (drafts only; lib/exemplar-import.mjs parses)
|   |                                    # attaches the generated translations too
|   |-- translate-exemplars.mjs          # translate:exemplars -- every phrasing into
|   |                                    # fr/en/es/it/de, into
|   |                                    # Email-Example-Queries.translations.json.
|   |                                    # Reviewed as a diff, then imported
|   |-- cluster-ticket-messages.mjs      # cluster:tickets -- recurring topics per
|   |                                    # subject. Print-only by default;
|   |                                    # cluster:tickets:save persists a run
|   |-- sync-shopify-collections.mjs     # collections + membership of active ones;
|   |                                   #   in the nightly, and behind the Sync button
|   |-- apply-supabase-migration.mjs     # SQL runner
|   |-- process-shopify-compliance-webhook.mjs
|   |-- dashboard-users.mjs              # `npm run users -- list|add|set-password|
|   |                                    # set-role|disable|enable` against Supabase
|   |                                    # Auth. Passwords typed at a hidden prompt
|   `-- lib/
|       |-- shopify-{admin,knowledge,theme}-client.mjs
|       |-- shopify-*-mapper.mjs         # shop/product/metaobject/customer/order/promotion
|       |-- shopify-sync-mappers.mjs shop-sync-service.mjs
|       |-- supabase-rest-client.mjs     # REST select/upsert/update/delete/rpc
|       |-- tables.mjs                   # THE SCHEMA CONTRACT: 31 tables, 24 views,
|       |                                # 34 rpcs, and the recurring projections.
|                                # + CHAT_T, STOREFRONT_T, KLAVIYO_T/_RPC (incremental)
|       |                                # Asserted against the DDL by _shared.test
|       |-- order-link.mjs               # what linking an order does to a ticket:
|       |                                # reinvestigationColumns (worker + dashboard),
|       |                                # manualOrderColumns, parseOrderNumber
|       |-- ticket-record.mjs            # THE ONLY WRITER OF `tickets`: pass protocol
|       |                                # (claim/complete/skip/retry/abandon +
|       |                                # descriptors), the needs_* flags, the
|       |                                # lifecycle timestamps, the metadata trail,
|       |                                # the queue + thread reads (`inboundMessages`
|       |                                # the customer's half, `conversation` both
|       |                                # directions). Shop-scoped
|       |-- draft-record.mjs             # THE ONLY WRITER OF `ticket_drafts` +
|       |                                # `ticket_draft_edits`:
|       |                                # the upsert key, the two bodies, the human
|       |                                # decision vs the machine outcome, the review
|       |                                # stamp. Shop-scoped. Cannot send
|       |-- ticket-priority.mjs          # pure read-time queue score + band:
|       |                                # level, customer wait, inbound contacts,
|       |                                # awaiting_human, VIP
|       |-- segment-finder.mjs           # pure: Segment Finder vocabulary (orders / spend /
|       |                                # lifetime_spend, gt / lt, AND / OR), validation,
|       |                                # AND-before-OR grouping and the bracketed sentence
|       |-- order-list-query.mjs         # pure: the Orders page URL -> search + filters +
|       |                                # page, normaliseSearch, delayDays,
|       |                                # orderNumberKey (#7008 == 7008), and
|       |                                # ticketMarksByOrder (most urgent open band)
|       |-- chat-sql-guard.mjs           # the management chat: SELECT/WITH only, one
|       |                                # statement, chat schema only; the row-capped wrap
|       |-- chat-sql-executor.mjs        # runs it as mgmt_chat_ro (read-only txn, 10 s,
|       |                                # rolled back) + reads the chat schema's comments
|       |-- chat-agent-loop.mjs          # execute_sql loop: 8 steps, last one forced to
|       |                                # answer; what the model sees of a result; history
|       |-- chat-system-prompt.mjs       # the rules + the data's known limits
|       |-- sync-config.mjs              # CLI + env parsing, loadEnv
|       |-- hash.mjs collections.mjs html-to-text.mjs text-cleaning.mjs
|       |-- quoted-reply.mjs             # strips reply chains
|       |-- email-display.mjs            # display-only split of a stored body: new text / quoted / forwarded / signature
|       |-- shopify-rich-text.mjs cluster-messages.mjs message-audience.mjs
|       |-- sender-patterns.mjs           # email/domain matching, shared by the
|       |                                 # blocklist and the sender directory
|       |-- compliance-audit.mjs shopify-compliance-webhooks.mjs
|       |-- shopify-order-webhooks.mjs   # one order webhook -> re-read that order
|       |                                # through the nightly's own query and
|       |                                # mapper, with a replay guard and an
|       |                                # out-of-order guard
|       |-- dashboard-auth.mjs           # isomorphic: ROLES, what each may open
|       |                                # (canAccessPath), and the Supabase Auth
|       |                                # client — ES256 check locally, then
|       |                                # /auth/v1/user cached 60s
|       |-- dashboard-passwords.mjs      # the 12-character minimum (Supabase hashes)
|       |-- dashboard-user-admin.mjs     # the only writer of auth.users; secret key,
|       |                                # CLI only — never imported by the web app
|       |-- support-taxonomy.mjs         # THE vocabulary: 14 subjects · 4 kinds ·
|       |                                # level + team derivation · signal enums
|       |-- vip-rule.mjs                 # THE VIP RULE's reader: shops thresholds ->
|       |                                # vip_customers/vip_tickets/vip_summary RPCs;
|       |                                # validate, describe, save. Queue, panel, agent
|       |-- customer-segments.mjs        # Shopify RFM segment labels (display only)
|       |-- llm-rates.mjs                # per-model $/1M + estimateCost. Read-time
|       |                                # pricing; NOT authoritative, override with
|       |                                # LLM_RATES
|       |-- insights-range.mjs           # pure: range presets, wall-clock buckets in
|       |                                # the shop tz, like-for-like comparison,
|       |                                # coverage (measured/partial/missing), and
|       |                                # platform -> channel handles
|       |-- storefront-analytics.mjs     # pure: the ShopifyQL queries behind sessions,
|       |                                # conversion, the money ladder and traffic by
|       |                                # channel, and how their rows fold into our
|       |                                # buckets (ranges to the second when not whole days)
|       |-- storefront-months.mjs        # pure: which months are stored vs live, the
|       |                                # plan for a window, combining the pieces
|       |-- storefront-months-sync.mjs   # the nightly writer of storefront_session_months
|       |-- klaviyo-client.mjs           # Klaviyo REST (private key, revision header,
|       |                                # waits out 429s); the key never leaves it
|       |-- klaviyo-reports.mjs          # pure: key shape, Placed Order metric, report
|       |                                # bodies + 59-day windows, folding answers into
|       |                                # rows, the card's summary (clicked rows only)
|       |-- klaviyo-sync.mjs             # connect (check, then Vault) · disconnect ·
|       |                                # runKlaviyoSync (backfill a year, then 59 days)
|       |-- shopifyql-client.mjs         # one ShopifyQL query per request; reads THROTTLED
|       |                                # and its reset time
|       |-- analytics-probe.mjs          # pure: the ShopifyQL probe's queries, how a
|       |                                # refusal is read (the catalogue is discovered
|       |                                # by being refused), and the selection built
|       |                                # from introspection
|       |-- sales-collections.mjs        # pure: the six product RANGES the sales cards
|       |                                # report, by handle (a business judgement, as
|       |                                # the platform channel lists are)
|       |-- sales-overview.mjs           # pure: stock status + thresholds, AOV, the
|       |                                # gross-to-net bridge, revenue drivers, the
|       |                                # management signals. Overview + report share it
|       |-- sales-report.mjs             # pure: the monthly report data -> one static
|       |                                # HTML file (the download; later the email)
|       |-- insights-freshness.mjs       # pure: how current each source is, and when
|       |                                # that is a warning (the thresholds)
|       |-- photo-evidence-rules.mjs     # what counts as a photo vs signature
|       |                                # furniture, + toPublicAttachments (strips
|       |                                # the Exchange id before the browser).
|       |                                # Readers: agent, backfill, ticket panel
|       |-- cluster-store.mjs            # persists a cluster run + its topics
|       |-- knowledge-{chunker,categories,document-mapper,navigation}.mjs
|       |-- embeddings/                  # embedding-input · openai-embeddings-client ·
|       |                                # embed-chunks (pure staleness gate) ·
|       |                                # reconcile (THE loop, one descriptor per
|       |                                # embedded table; the 3 embed:* scripts are
|       |                                # a descriptor + a report each)
|       `-- knowledge/                   # source-discovery · knowledge-source-resolver ·
|                                        # content-resolvers/ · template-traversal ·
|                                        # template-extractors/
|-- agent/                       # always-on worker (own package.json; reuses scripts/lib/*)
|   |-- src/
|   |   |-- index.mjs config.mjs # entrypoint (--once) · env/tunables + Graph gate
|   |   |-- lib/ llm/            # logger (JSON, no PII) · shop · openai-client
|   |   |                        # (records every call's tokens into) usage-sink
|   |   |                        # -> usage-store (best-effort; never fails a pass)
|   |   |-- ingestion/           # graph-client · graph-message-mapper · contact-form ·
|   |   |                        # delta-poller · ticket-writer · message-embedder ·
|   |   |                        # spam-gate + blocklist-store + spam-classifier ·
|   |   |                        # sender-directory (who a sender is: context for
|   |   |                        # the case file, filter for the demand report,
|   |   |                        # and the gate on related-rules; `senderRole`
|   |   |                        # resolves a role PER MESSAGE -- client /
|   |   |                        # collègue (LAP Groupe) / prestataire logistique
|   |   |                        # -- for every renderer that shows a thread to a
|   |   |                        # model, and the address never travels with it) ·
|   |   |                        # duplicate-rules (same message twice -> silence) ·
|   |   |                        # related-rules (same conversation again -> context
|   |   |                        # + apology; consumers only, never suppresses) ·
|   |   |                        # contact-form-repair (undoes a form parse that
|   |   |                        # fired on a reply quoting the notification) ·
|   |   |                        # requester-repair (moves a colleague's identity
|   |   |                        # off a ticket a customer is on) ·
|   |   |                        # spam-audit (rows, body cap/clock, retention purge) ·
|   |   |                        # spam-body-backfill · attachment-backfill
|   |   |-- pipeline/            # categorise (classify-only) · categorise-runner
|   |   |-- retrieval/           # retrieval-rules (categoriesToSearch: the subject
|   |   |                        #   plus faq + brand_story + other, all three
|   |   |                        #   cross-subject) · knowledge-retrieval (dense 20
|   |   |                        #   + lexical 20, fused by rank, banded three ways) ·
|   |   |                        # exemplar-{rules,retrieval} (which situation is this) ·
|   |   |                        # situation-chooser (a small model settles a near
|   |   |                        #   miss / tie among the matcher's candidates, or
|   |   |                        #   none; skips our own side; before the rules load) ·
|   |   |                        # product-{matching,context,lookup} (four shapes:
|   |   |                        #   one product / a range / ambiguous / nothing,
|   |   |                        #   ranges derived from shared title bigrams;
|   |   |                        #   samples are never candidates) ·
|   |   |                        # product-concerns (customer cues <-> catalogue tags) ·
|   |   |                        # advice-collections (activated collections,
|   |   |                        #   requirement -> collection in 3 passes,
|   |   |                        #   one group per type of care, concerns rank
|   |   |                        #   inside it; best tier only) ·
|   |   |                        # care-cues (the types of soin, read from the
|   |   |                        #   message; cue -> token -> every matching
|   |   |                        #   active category, one group per cue;
|   |   |                        #   dry skin resolves here) ·
|   |   |                        # concern-cues (what is wrong, read from the
|   |   |                        #   message; one entry = one concern however
|   |   |                        #   many collections it covers) ·
|   |   |                        # cue-matching (shared by both cue lists:
|   |   |                        #   fold, whole-word, token/phrase in title) ·
|   |   |                        # product-lines (name - what it does - who it suits) ·
|   |   |                        # promotion-{rules,lookup} ·
|   |   |                        # abandoned-checkout (the ONLY view of a basket;
|   |   |                        #   live Shopify Admin, never synced; a tool
|   |   |                        #   since 2026-09-16, see checkout_state) ·
|   |   |                        # customer-{context,lookup} ·
|   |   |                        # purchase-{verification,lookup} (three-state
|   |   |                        #   customer check + last-order product match)
|   |   |-- investigation/       # case-file (THE output contract) · investigation-rules ·
|   |   |                        # decompose{,-rules} (tasks + needs, one call) ·
|   |   |                        # answer-selection (which answer the findings
|   |   |                        #   select, and the next need to collect) ·
|   |   |                        # evidence-rules (23 needs, scored vs the ledger;
|   |   |                        #   + findings = the value each took, + a
|   |   |                        #   requires/moot DAG and orderNeeds) ·
|   |   |                        # photo-evidence (re-exports scripts/lib/photo-evidence-rules) ·
|   |   |                        # tool-registry (14 tools; the checkout lookup is
|   |   |                        #   optional and unbound without Shopify creds) ·
|   |   |                        # investigate (bounded loop) ·
|   |   |                        # investigation-runner · create-investigation
|   |   |-- resolution/          # customer-resolution-runner · order-number-parser ·
|   |   |                        # tracking-number-parser (the second way into an
|   |   |                        #   order, via orders.tracking_numbers) ·
|   |   |                        # confirmation-evidence (every address in the
|   |   |                        #   message, as hashes; no template parsing) ·
|   |   |                        # order-verification · order-resolution-runner ·
|   |   |                        # (checkOrderPromotion reads the bundle promotions
|   |   |                        #  block: gifts, reductions, samples) ·
|   |   |                        # order-context + order-context-runner
|   |   |                        #   (orderStates: order_state, delivery_state,
|   |   |                        #    delivery_delay_state, dispatch_state,
|   |   |                        #    payment_state, refund_state,
|   |   |                        #    return_eligibility — derived against the
|   |   |                        #    ticket's latest inbound message, not `now`)
|   |   |-- routing/             # forward-rules · forwarding-store · forward-runner
|   |   |-- drafting/            # brand-voice (the Brand voice row -> the system
|   |   |                        #   prompt + INTENT_RULES per verdict: answer /
|   |   |                        #   answer-then-ask / answer-then-hand-over;
|   |   |                        #   approval gates it) · draft-rules (verdict +
|   |   |                        #   level gates and terminal/intermediary, pure) ·
|   |   |                        # compose-draft
|   |   |                        #   (per-ticket message, the thread so far — ours
|   |   |                        #   and theirs, above the new message — and the
|   |   |                        #   answer schema) ·
|   |   |                        # draft-checks (the prohibitions, in code) ·
|   |   |                        # draft-runner (+ the derived queue). NO Graph call
|   |   |-- casework/            # case-manager (what a new message changed: a
|   |   |                        #   closed relationship, which of OUR questions it
|   |   |                        #   answered, what we promised) · case-manager-rules
|   |   |                        #   (pure: whether the categoriser re-runs, which
|   |   |                        #   situation the case is in, which prior evidence
|   |   |                        #   may be reused) · case-runner (the pass; derived
|   |   |                        #   queue, no third flag) ·
|   |   |                        # closure (does the customer's last message end
|   |   |                        #   their request? code gate first -- nothing
|   |   |                        #   outstanding in the dossier -- then one cheap
|   |   |                        #   call on the message) ·
|   |   |                        # reconstruct (a finished thread -> where the case
|   |   |                        #   stands: situation from the shop's own library or
|   |   |                        #   none, what we asked, what we promised, what is
|   |   |                        #   still open; the model reads the PROSE and
|   |   |                        #   `backendPosition` reads `resolved_context`, and
|   |   |                        #   the two are never merged). READ ONLY
|   |   |-- lifecycle/           # auto-close (28d idle, level 4 exempt)
|   |   |-- tools/              # one CLI per pass -- see Agent CLIs below
|   |   `-- testing/            # THE REHEARSAL HARNESS behind /agent-setup's test
|   |                           # chat. memory-transport (a PostgREST-shaped fake
|   |                           # DB, so the REAL ticket-record and draft-record
|   |                           # run unchanged over it) · synthetic-message ·
|   |                           # trace (+ the OpenAI decorator) · article-check
|   |                           # (the five verdicts) · run-rehearsal (the passes,
|   |                           # in the poll's order, writing no row)
|   `-- eval/                    # categorisation-cases (40 dummy) · score-categorisation ·
|                                # sample-mailbox (review:sample) · compare-review-labels
`-- supabase/migrations/         # BASELINE, 8 files by domain, run in order against
                                 # an EMPTY database -- see Database Map.
                                 # _shared.test.mjs holds the cross-file invariants;
                                 # each file has its own sibling .test.mjs.
                                 # _live.test.mjs APPLIES the baseline into a
                                 # throwaway schema and asserts the views behave --
                                 # skipped unless SUPABASE_DB_URL is set
```

## Database Map

Every table has RLS on with no policies: **service-role access only**. Shopify stays source of truth; all syncs idempotent.

### Shopify snapshots

| Table | Holds |
| --- | --- |
| `shops` | shop records, environment, app settings, `sync_cursors` (incl. mail delta link), `storefront_url` (Shopify `primaryDomain.url` — where customers go, unlike `shop_domain` which is the *.myshopify.com identity webhooks key on; the base for `/account/login`), `customer_accounts_version` (`CLASSIC` — decides whether a password exists at all), `iana_timezone` (Shopify's `ianaTimezone` — where a day starts on the Insights charts; null until a sync runs the current `mapShop`), `sync_cursors` (incl. the mail delta link — **never written by `mapShop`**), **order retention switch** `order_retention_mode` (`months`/`indefinite`) + `_months` + `_changed_at` + `_reason` — read by `scripts/lib/order-retention.mjs`, never written by `mapShop`; **the VIP rule** `vip_min_spend` + `vip_min_orders` + `vip_window_months` (all or none) + `vip_rule_changed_at` — set on the Customers panel, read by `scripts/lib/vip-rule.mjs` |
| `customers` | lean support snapshot: contact, marketing state, coarse location, lifetime totals, last order, `rfm_group`. No addresses or notes |
| `orders` | identity, links, channel, derived `order_status`, totals, line items, fulfillments, returns, refunds. Contacts hashed, plus `customer_email_masked` (`j***l@orange.fr`) for the one question a hash cannot answer; `tracking_numbers text[]` (GIN) lifted out of fulfillments so a ticket can be resolved from a parcel number; destination coarse; `retention_rule` names only WHY the clock started, `retention_delete_after` carries the period and is **null when kept indefinitely** |
| `products` | snapshots + first-class metafields, `variants` jsonb, `available_stock` |
| `promotions` | one row per redeem code (`code = null` for automatic); `rule_snapshot` carries values, not just type names |
| `advice_collections` | every Shopify collection (175), plus the team's decision about each: `is_active` (may support answer from it), `axis` (`concern` / `category`), `note`. `product_ids` holds the LIVE products, refreshed for active collections only — see DECISIONS.md § advice from collections |
| `shopify_metaobjects` | shared metaobjects (FAQ, ingredient lists) referenced by products |
| `shopify_content_sources` | content-free catalog of live pages + policies. Feeds Agent Setup only; no FK to knowledge |

### Curated knowledge

Never auto-synced — every row is an explicit import or a hand-written article.

| Table | Holds |
| --- | --- |
| `knowledge_documents` | `content_html` is the editor's truth; `approval_status` independent of Shopify publish `status`; `core_topic` = 1 of 6 slots, max one per shop; `voice_profile` jsonb = the drafting agent's system prompt on the singleton `brand` row (`roleDescription`, `toneAndVoice`, `responseFramework[]`, `guidelinesAndGuardrails[]`, `closingLine`, `signature`) — all five stored, so the worker reads one source rather than a constant in `web/` |
| `knowledge_chunks` | retrieval chunks + `embedding vector(1536)` HNSW cosine, plus the determinism quadruple; `category` and `product_ids` denormalised from the parent document |

### Support exemplars

The recurring situations, not the answers to them. Same document/chunk mechanics as knowledge, in their own tables so retrieval can never reach a *question* while looking for policy.

| Table | Holds |
| --- | --- |
| `support_exemplars` | canonical question, `exemplar_key` (`P-16`), subject + kind, `requirement_needs text[]` constrained to the `evidence-rules.mjs` vocabulary, `approval_status` (gates the vector), `demand_message_count`, `answer_set` naming which policy family it draws on (`commande` on the 11 order/delivery situations) |
| `support_exemplar_phrasings` | one row per canonical + real phrasing, each with its own `embedding vector(1536)` and the determinism quadruple. `language` is declared in the document — a variant's annotation may open with a code (`_(en)_`), and **12 of the 168 authored phrasings are real English, Spanish or Dutch mail**. Translations live at `phrasing_index >= 100` (`TRANSLATION_INDEX_BASE + source * 10 + language slot`, from `lib/exemplar-translation.mjs`), out of reach of the importer's pruner; every authored phrasing is translated into each of `fr en es it de` it is not already written in, giving **674 rows for 168 phrasings** (counted 2026-09-21; 842 in all, of which 832 are embedded — the 10 unembedded are soft-deleted `O-11`'s). `match_support_exemplars()` returns one row per **exemplar**, scored by its best phrasing, reports which language matched, and over-fetches `match_count * 64` — above the 60-row ceiling one exemplar's translations can reach |
| `support_answers` | the policy rules. Two axes: `situation_key` (what the customer wants, from the matched exemplar; null = any) and `when_conditions jsonb` = `{need: [findings]}` (what is true). A matched rule carries an `answer_skeleton`, and may `route` to `needs_human`/`needs_customer_input`, hand out **`offer_code`** (a live discount code, picked by an operator from the promotions cleared on `/agent-setup/promotions`; no FK because `promotions` is Shopify-synced, so it is re-checked at drafting time and dropped if it stops being ACTIVE + offerable), and name **`ask text[]`** (`MISSING_FIELDS` keys — a list since 2026-08-30, because a reaction with no product named needs the product *and* the batch number) — **never to `answerable`**, enforced by a check constraint, so a rule can only ever tighten. A rule may also pin **`knowledge_document_id`** — the approved article it answers from, chosen in the editor like a code and carried into the drafting prompt under its own heading, separate from what retrieval found. A real FK (`on delete set null`) unlike `offer_code`, because no sync rewrites these rows; approval is still re-checked at drafting and the article dropped if it is no longer approved. **`tones text[]`** (keys of `scripts/lib/reply-tones.mjs`, check-constrained, `{}` = Brand voice alone) reach the drafting prompt as `## Ton de cette réponse`; unioned across requests. **`link_url` + `link_label`** (https only, both or neither): the prompt gets only the label and asks for one `[[ici]]` marker; the address is copied to `ticket_drafts.reply_link` and put on the marked word wherever a draft is rendered (`TrackingText`, marker rules in `scripts/lib/reply-link.mjs`); checks `link_placed` / `no_orphan_link_marker`. One `is_fallback` per `answer_set`. Selected by `answer-selection.mjs` (situation outranks condition depth), which also derives the next need to collect. **119 approved rules, counted 2026-09-21 — 63 in `orders`, 20 in `products`, 8 each in `cosmetovigilance`, `returns` and `promotions`, 6 each in `accounts` and `payments`**, beside 11 drafts (5 `orders`, 5 `products`, 1 `promotions`) that no run can reach, loaded per ticket by `loadAnswers` (approved only) and selected after the tool loop closes. **Live: a matched route tightens the verdict in `buildCaseFile`, never loosens it**, and the selection is recorded on `ticket_investigations.exemplar_match.policy` with `verdict_before_policy` beside it. `answer_skeleton` travels into the drafting prompt as `## Ce que cette réponse doit faire` — read out of `exemplar_match.policy` **by name**, so the diagnostics beside it cannot reach a model |

### Agent email workflow

| Table | Holds |
| --- | --- |
| `tickets` | one per Graph `conversationId`. Taxonomy axes, `level`, `responsible_team`, `customer_id`, `shopify_order_number`, signals (`language`, `happiness`, `categorisation_confidence`), `resolved_context` jsonb, `duplicate_of_ticket_id` + `duplicate_reason` + `duplicate_detected_at` (**linked, never merged** — set by deterministic rules only; the drafting *and* investigation queues skip a linked ticket), `sender_label` (`internal`/`contractor` when one of OUR addresses opened the thread — stamped at creation from `sender_directory`, skips drafting, investigation still runs), `related_ticket_id` + `related_score` + `related_detected_at` (an earlier ticket this one **continues** — embedding cosine ≥ 0.90, consumers only; **never suppresses a draft**, it adds thread context and drives the apology for a cross-ticket chase), lifecycle + retention timestamps |
| `ticket_messages` | one per Graph message. Envelope, cleaned `body_text`, sanitised payload, `embedding vector(1536)`, the RFC 5322 reply chain (`in_reply_to` + `reference_ids[]`, captured for deduplication — only those two headers are kept, the rest is `Received` chains carrying relay IPs), and `attachments jsonb` -- part METADATA only (name, contentType, size, isInline), never bytes. **NULL means never fetched**, `[]` means fetched and empty |
| `ticket_investigations` | **the case file**: `established` / `unverified` / `missing` / `do_not_claim` (four separate columns), `handoff`, `context_ref`, `dropped_claims`, `evidence_gaps` (what the ticket required vs what was obtained, each entry carrying the `finding` and the `details` naming WHICH product or code it is about — diagnostic, does not move the verdict), `exemplar_match` (which recurring situation this is; recorded, never acted on), `candidate_order` (**internal**: the customer's last order as a FULL bundle, same shape and builder as `resolved_context`, fetched in the order tool's unresolved branch so it can never sit beside a confirmed order. Rendered in the human brief and the dashboard under Last order headings, **never** in the drafting prompt). `reaction_report` (**cosmetovigilance only, nullable**: the product the customer BLAMES, their words for it, and the symptoms — attribution, never causation. Lifted out of the ledger by `reactionReportFrom` because `tool_calls` drops every tool's `data`. On the detail projection, deliberately **not** on the drafting one). `findings_trace` (**nullable**: the derived findings after each tool call, in call order — one entry per `tool_calls` entry, `{call, tool, findings}`, scored over the whole need vocabulary. The replay tape: `tool_calls` drops every tool's `data` and 8 of the finding derivations read it, so a replay over `tool_calls` alone would score those as absent and stop earlier. NULL means the row predates the column and can never be filled; `[]` means the run made no calls. On no projection at all). `recommendations` (**what `recommendProducts` put forward, as the tool rendered it** — one entry per type of care, with the product lines a reply quotes. Written by code off the tool ledger like `knowledge`, never by the model, and printed FIRST in the drafting prompt, before `## Établi`; migration 32). `unique(shop_id, trigger_message_id)` |
| `ticket_drafts` | **what the agent would send**: `body_text` (the model's, never edited) beside `approved_body_text` (a reviewer's rewrite), `source_verdict` (all three — `needs_human` gets an acknowledgement), `disposition` (`terminal` = sending closes the ticket \| `intermediary` = somebody still owes an answer; derived from the verdict + the case file's `handoff`, never model-chosen, and enforced by two check constraints), `level` (1–3; level 4 is never drafted), `status` (the human decision) kept apart from `checks_passed` (the machine outcome), `auto_send_eligible` (four conditions: level 1–2, customer not visibly unhappy, checks passed, verdict not `needs_human` — plus a subject gate, `cosmetovigilance` never qualifying unless **both** `DRAFT_ONLY` and `DRAFT_ONLY_COSMETOVIGILANCE` are false), `prompt_inputs`, `review_sent_at`. `unique(shop_id, trigger_message_id)`. **Holds no recipient and cannot send.** Owned by `scripts/lib/draft-record.mjs` |
| `ticket_draft_edits` | **append-only record of every human rewrite**, each carrying `model_body_text` — the agent's text as it stood when the edit was made, COPIED rather than referenced, because `ticket_drafts.body_text` is replaced by the next drafting run. `source` (dashboard / mailbox), `edited_by` (null until auth exists). Capture for Phase 7 memory; nothing reads it yet |
| `email_blocklist` | per-shop sender email/domain rules + hit counts |
| `sender_directory` | per-shop sender email/domain → `label` (internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other) + free-text `note`. Read into the case file as context and by `cluster:tickets` to tell customer demand from our own mail. Replaces `INTERNAL_EMAIL_DOMAINS`. Rows are exceptions; an unlisted sender is a consumer |
| `spam_audit` | one row per gate decision. `outcome`, `decided_by`, `reason`, `label`, `model`, `failed_open`, sender, subject, and on a block `body_text` + `body_captured_at` + `body_expires_at` |
| `category_forwarding` | per-category address book. A null address is the off switch |
| `ticket_forwards` | attempt ledger, `unique(ticket_message_id)`, `sent`/`failed` + attempt counter |
| `categorisation_review` | **testing artefact, not runtime**: hand-labelled sample scored against the agent |

### Projections

Views and functions for shapes that were being assembled client-side by reading
rows and discarding most of them. Joins and aggregates only — judgement stays in
tested JavaScript. Every view is `security_invoker`, or it would read past the
RLS on the tables under it.

| Object | Answers | Replaces |
| --- | --- | --- |
| `ticket_message_counts` | messages per ticket + inbound/outbound activity facts, soft-deleted excluded | a full read of `ticket_messages` to count in a Map |
| `ticket_first_inbound` | one row per ticket: its earliest inbound message, incl. `from_email` | a read of every inbound body in the shop, keeping one per ticket |
| `ticket_queue` | the dashboard row: ticket + customer + count + `requester_email` (the address that opened the thread, so `sender_directory` can be asked whether it is a customer), soft-deleted excluded | `TICKET_LIST_SELECT` + the count join, in `tickets-service.ts` |
| `order_number_range(shop)` | lowest and highest `order_number`, live orders only | an asc/desc pair of `limit 1` reads |

**The 21 Insights views (`06_analytics.sql`).** The all-time aggregates. The panels
now read the ranged functions below instead — only the Customers panel still reads
two of these (a snapshot has no range). The rest have no reader and are kept as the
all-time definitions, and the ranged functions build on `order_fulfilment_timing`.
Either way nothing is aggregated in the browser or the server, because
PostgREST caps a response at 1,000 rows and pages an unordered query in
overlapping slices — see `DECISIONS.md § Insights`.

| Group | Views |
| --- | --- |
| Fulfilment | `order_fulfilment_timing` (base, per order; also carries `total_refunded` + `return_status`) · `fulfilment_summary` (timing **and** the returns/refunds counts) · `fulfilment_by_month` · `fulfilment_by_carrier` (also the contact rate: orders that produced a ticket) · `fulfilment_by_bucket` · `fulfilment_ticket_coverage` (the denominator that makes that rate a floor) |
| Fulfilment, per sales channel | `fulfilment_summary_by_channel` · `fulfilment_by_channel_month` · `fulfilment_by_channel_bucket` — the same three cut by `orders.sales_channel_handle`, read with a `channel` filter. Additive: the views above keep their one-row-per-shop shape |
| Support | `ticket_reply_times` (base, per ticket) · `support_by_month` · `support_by_category` · `support_purchase_states` + `support_purchase_by_category` (who wrote in, by whether an online purchase is visible) |
| Customers | `customer_ticket_facts` · `customer_segment_totals` |
| Agent | `agent_pipeline_funnel` · `investigation_evidence_gaps` · `investigation_verdicts` · `llm_usage_by_month` · `llm_usage_summary` |

**The 28 ranged functions (`RANGED READS`, `06_analytics.sql`).** Every Insights
figure is now read over a date range: `insights_orders_summary` / `_series` /
`_by_channel`, `insights_customer_mix`, `insights_fulfilment_buckets` /
`_carriers`, `insights_product_sales`, `insights_country_product_sales`,
`insights_orders_by_country`, `insights_product_pairs`, `insights_orders_per_customer`,
`insights_marketing_summary` / `_series`, `insights_capture_series`,
`insights_support_summary` / `_series` / `_categories`, `insights_agent_funnel` /
`_verdicts` / `_blockers`, `insights_llm_usage` / `_series` / `_ticket_stats`, and
`insights_freshness` (when each source last moved), and — for Overview, Marketing
and the report — `insights_sales_overview` (paid units, discounts, discounted vs
full-price revenue), `insights_promotions` (per promotion name, plus full price)
`insights_inventory_exceptions` (active products out of stock or low; stock
now, rate over a window) and `insights_collection_sales` (per collection, or
just the ranges `p_handles` names). One convention: the range as
wall-clock `timestamp`s plus `p_tz`, half-open; series take `p_grain` and return
only non-empty buckets; order functions take `p_channels` / `p_not_channels`.

**The VIP rule** is three functions in `06_analytics.sql`: `vip_customers()` (the rule: net spend AND orders in the window, both strictly above the shop's thresholds; Shopify orders only), and `vip_tickets()` / `vip_summary()` built on it, plus `open_orders()` — orders not fulfilled, cancelled or closed, each buyer marked VIP through it.

**The Orders page** is two functions in `06_analytics.sql`: `orders_list()` (one page of every live order, newest first, with buyer name, VIP through `vip_customers()`, units, normalised carrier, destination and `total_count` of the filtered set) and `orders_list_facets()` (each fulfilment status and country with its count, grouped on the same expressions the list filters on). The status in both is `order_fulfilment_display()` (Shopify's, or `CANCELLED` / `REFUNDED` for an unshipped order with 0 items left), the SQL twin of `fulfillmentDisplay` in `scripts/lib/order-list-query.mjs`.

They expose `rfm_group` and never `is_vip`: who counts as a VIP is a business
rule owned by `customer-segments.mjs` and applied at read time.

### Agent rehearsals

| Table | Holds |
| --- | --- |
| `agent_test_runs` | one run of the Agent Setup **test chat**: a message an operator typed, put through the real pipeline. References no ticket, message, investigation or draft — a rehearsal writes none of them (`agent/src/testing/`). `trace` jsonb is the record (every step, every tool's returned text, every model call's prompt and response); the flat columns beside it index it so a history list never parses one. Identity is `requester_email_masked` only — neither the address nor a hash. `ideal_body_text` is **the memory**: what the operator would have sent instead — the same capture `ticket_draft_edits` makes for real mail, except the situation can be invented. Cost is recorded here and deliberately not in `llm_usage` |

### Management chat

Migration 17. Two halves, on two connections — see `DECISIONS.md § Management chat`.

| Object | Holds |
| --- | --- |
| role `mgmt_chat_ro` | what the model's SQL runs as (`CHAT_DB_URL`). `USAGE` on `chat`, `SELECT` on its views, `EXECUTE` on `normalise_carrier` — nothing else. Read-only default, 10 s timeout, `search_path = chat`, 5 connections |
| schema `chat` | 13 **owner-rights** views, one per thing management asks about: `shop` · `orders` · `order_lines` · `fulfilment_timing` · `customers` · `products` · `promotions` · `tickets` · `ticket_reply_times` · `ticket_message_counts` · `ticket_investigations` · `ticket_drafts` · `llm_usage`; and `vip_customers` (migration 21), over the security-definer, argument-less `chat.vip_customer_rows()`, which applies `vip_customers()` with the shop's thresholds. **No names, emails, phones, addresses, subjects or message text.** Their `comment on` text is the schema description the model is given, read at request time |
| `storefront_session_months` | per shop and CLOSED month (shop clock): human sessions, pageviews, cart / checkout / converted sessions from ShopifyQL. Written nightly (every month rewritten), read by `analytics.ts`; the last two months are never read from here. No money — net sales and AOV are always live. Named in `STOREFRONT_T` |
| `chat_conversations` | one thread, owned by one dashboard user (`user_id` = auth id); title = first question |
| `chat_turns` | one question + answer: `status` (running / ok / step_limit / empty / error), `error`, `model`, `steps`, tokens, `duration_ms`. Spend here, **not** in `llm_usage` |
| `chat_queries` | every query tried: `sql`, `ok`, `error` (a refusal or a Postgres error), `row_count`, `truncated`, `duration_ms`, `columns`, the first 50 rows |

### Compliance and audit

| Table | Holds |
| --- | --- |
| `integration_events` | metadata-only sync/webhook log, idempotent on `event_key` |
### Klaviyo

Migration 39. Named in `KLAVIYO_T` / `KLAVIYO_RPC`, not `T` / `RPC`. See `DECISIONS.md § Insights → Klaviyo`.

| Object | Holds |
| --- | --- |
| `klaviyo_connections` | one row per shop: `secret_id` (the key, in **`vault.secrets`**), `key_hint` (last 4), `conversion_metric_id` (Placed Order), `saved_at` / `saved_by`, `last_sync_at` / `_status` / `_error` |
| `klaviyo_flow_days` | per shop, flow and day (Klaviyo account clock): recipients, delivered, opens_unique, clicks_unique, conversions, conversion_value — counts only. Last 59 days rewritten nightly |
| `klaviyo_campaigns` | per shop and campaign: name, channel, `send_time`, the same counts, for the campaign as a whole |
| `klaviyo_save_key` / `_read_key` / `_clear_key` | security definer, `search_path ''`, **service_role only** — the only way to touch the key |
| `insights_klaviyo_messages(p_shop, p_from, p_to, p_tz)` | flows summed over their days + campaigns by send time, in the Insights range convention |

| `privacy_requests` | Shopify compliance webhook lifecycle (hashed contacts, deletion counts) |
| `data_access_events` | personal-data access audit trail. Sync paths and the agent's customer lookup write here, and so does the dashboard: one row each time a signed-in user is shown customers by name (ticket list, ticket detail and thread, Conversations, Fulfilment's waiting orders, the Customers call list, the contacts CSV), with `actor_type = user` and `actor_id` the Supabase `auth.users.id` — counts in `metadata`, never names |

Dashboard accounts are **not** in this schema: they are Supabase Auth users (`auth.users`), with the role in `app_metadata.dashboard_role`. See Surfaces → Sign-in and roles.

### Analytics

Written by the worker and the CLIs, read only by the Insights panels.

| Table | Holds |
| --- | --- |
| `llm_usage` | one row per model call: `pass` (`spam`, `categorise`, `decompose`, `situation`, `investigate`, `draft`, `embed`, `other` — `USAGE_PASSES`), `model`, token counts, `ticket_id`, `succeeded`. Append-only, written through one sink in the OpenAI transport. **Tokens are stored; money is computed at read time** from `scripts/lib/llm-rates.mjs` |
| `cluster_runs` | one row per manual rebuild of the topic map: `built_at`, `threshold`, `min_size`, corpus counts. What the panel reads to state the map's age |
| `ticket_clusters` | one row per topic in a run: subject, size, cohesion, excerpt, `member_message_ids uuid[]` (GIN) |

### Migration files

**Nine files, by domain, run in order against an empty database.** The order is a plain dependency chain, and every table is created *complete* — there is no `alter table … add column` anywhere in the baseline, and a test asserts that.

| File | Creates | Depends on |
| --- | --- | --- |
| `01_foundation.sql` | extensions, `set_updated_at()`, `shops`, `integration_events`, `privacy_requests`, `data_access_events` | — |
| `02_shopify.sql` | `is_valid_product_faqs()`, `customers`, `orders`, `products`, `shopify_metaobjects`, `promotions`, `shopify_content_sources`, `order_number_range()` | 01 |
| `03_knowledge.sql` | `knowledge_documents` (+ `product_ids`), `knowledge_chunks` (+ `product_ids`), `match_knowledge_chunks()`, `search_knowledge_chunks_text()` — both RPCs return `product_ids` | 01 |
| `04_support.sql` | `tickets`, `ticket_messages`, `email_blocklist`, `sender_directory`, `spam_audit`, `ticket_investigations`, `category_forwarding`, `ticket_forwards`, `categorisation_review`, the three views | 01, 02 |
| `05_exemplars.sql` | `support_exemplars`, `support_exemplar_phrasings`, `support_answers`, `match_support_exemplars()` | 01, 03 (`french_unaccent`) |
| `09_parameters.sql` | `support_parameters` | 01 |
| `06_analytics.sql` | `normalise_carrier()`, `llm_usage`, `cluster_runs`, `ticket_clusters`, the **21 Insights views**, and the **28 ranged functions** | 01, 02, 04 |
| `07_drafting.sql` | `ticket_drafts`, `ticket_draft_edits` | 01, 04 |
| `08_testing.sql` | `agent_test_runs` | 01, 03 |

**Incremental migrations** run on top of the baseline, and are deliberately not part of it — the invariants above (creates schema, never migrates data; final shape with no corrective re-work) are properties of the baseline alone. Each is idempotent, so applying one to a fresh install is a no-op.

| File | Does | Depends on |
| --- | --- | --- |
| `10_order_retention.sql` | order retention becomes a shop setting: adds the `shops` switch, rewrites `retention_rule` to reason-only names (reconciling a live/repo drift), sets this shop to `indefinite` and clears its delete dates | 01, 02 |
| `12_vip_rule.sql` | adds the `shops` VIP rule columns + check, and `vip_customers()` / `vip_tickets()` / `vip_summary()`, copied from 06 (its test asserts it, and that the rule is AND with strict comparisons). Sets no rule. Applied 2026-09-11 | 01, 02, 04, 06 |
| `11_insights_ranges.sql` | adds `shops.iana_timezone` and the 18 ranged Insights functions, **copied byte-for-byte from 06** (its test asserts it). Applied to the live database 2026-09-11 | 01, 02, 04, 06 |
| `14_fulfilment_waiting.sql` | replaces `insights_fulfilment_buckets()` with the version that also returns a `Not shipped yet` bucket, counted as `open_orders()` counts it — orders with no duration to bucket were previously drawn nowhere. Copied byte-for-byte from 06; supersedes 11's copy of that one function. Applied 2026-09-12 | 01, 02, 06 |
| `15_orders_list.sql` | adds `orders_list()` + `orders_list_facets()` for the Orders page, copied byte-for-byte from 06 (its test asserts it). No table, no data. Applied 2026-09-14 | 01, 02, 06, 12 |
| `16_orders_search.sql` | drops the 11-argument `orders_list()` and recreates it with `p_search` and an `awaiting_fulfilment` column (open_orders()'s waiting rule); copied byte-for-byte from 06, supersedes 15's copy of that one function | 01, 02, 06, 12, 15 |
| `17_management_chat.sql` | the management chat: login role `mgmt_chat_ro` (no password in the file), the `chat` schema of 13 owner-rights views with no personal data, and the log tables `chat_conversations` / `chat_turns` / `chat_queries` (named in `CHAT_T`, not `T`). Applied 2026-09-14 | 01, 02, 04, 06, 07 |
| `18_product_customer_mix.sql` | drops the draft six-argument `insights_product_customer_mix()` and creates the one-product version (`p_product_id`): distinct Shopify customers who bought only it / with other products / not at all, plus its top 7 co-bought products; free lines ignored. Copied byte-for-byte from 06. Applied 2026-09-14 | 01, 02, 06 |
| `19_product_mix_filters.sql` | drops 18's seven-argument `insights_product_customer_mix()` and recreates it with `p_country`, `p_vip_only` and the VIP rule arguments (through `vip_customers()`); both filters narrow the whole population. Copied byte-for-byte from 06, where the function now sits after `orders_list_facets()` because it calls `vip_customers()`. Supersedes 18's copy. Applied 2026-09-14 | 01, 02, 06, 12, 18 |
| `20_best_products_vip.sql` | drops and recreates `insights_product_sales()` and `insights_country_product_sales()` with `p_vip_only` + the VIP rule arguments (through `vip_customers()`, off by default); both now sit below `vip_customers()` in 06. Copied byte-for-byte from 06, supersedes 11's copies. Applied 2026-09-14 | 01, 02, 06, 11, 12 |
| `30_customer_mix_plan.sql` | replaces the body of `insights_customer_mix()` — same signature, same four numbers — grouping the range by customer before looking up each first order, because the old shape planned as a nested loop (~1 s on a year). Copied byte-for-byte from 06, supersedes 11's copy. Applied 2026-09-18 | 01, 02, 06, 11 |
| `31_orders_status_filter.sql` | adds `order_fulfilment_display()` and re-creates `orders_list()` + `orders_list_facets()` to filter and group on it, so the status filter selects what the pill shows (Cancelled / Refunded instead of Unfulfilled for emptied orders). Same signatures: `create or replace`, nothing dropped. Copied byte-for-byte from 06, supersedes 16's `orders_list` and 15's `orders_list_facets`. Applied 2026-09-18 | 01, 02, 06, 15, 16 |
| `38_storefront_months.sql` | the `storefront_session_months` table (named in `STOREFRONT_T`, not `T`). Applied 2026-09-24 and backfilled (36 months) | 01 |
| `37_collection_handles.sql` | drops 36's seven-argument `insights_collection_sales()` and recreates it with `p_handles`, so the Collection mix card reports the six ranges rather than all 176 collections. Copied byte-for-byte from 06 (its test asserts it); supersedes 36. Applied 2026-09-23 | 01, 02, 06, 27, 36 |
| `36_collection_sales.sql` | adds `insights_collection_sales()`: per collection for a range, on `insights_product_sales` line rules, plus a null-id row for paid lines in no reported collection. Superseded by 37. Applied 2026-09-23 | 01, 02, 06, 27 |
| `35_sales_overview.sql` | adds `insights_sales_overview()`, `insights_promotions()` and `insights_inventory_exceptions()` for Overview, Marketing & funnel, the stock card and the monthly report, copied byte-for-byte from 06 (its test asserts it). No table, no data. Applied 2026-09-22 | 01, 02, 06 |
| `32_investigation_recommendations.sql` | adds `ticket_investigations.recommendations jsonb` — the shop's own product list, carried verbatim so the drafting stage reads what the tool said rather than a paraphrase of it. Idempotent, no data written. Applied 2026-09-20 | 04 |
| `39_klaviyo.sql` | the three Klaviyo tables (`KLAVIYO_T`), the Vault key functions and `insights_klaviyo_messages()` (`KLAVIYO_RPC`). No data. Applied 2026-09-25 | 01 |
| `23_agent_situations.sql` | adds `insights_agent_situations()`: tickets investigated in a range (latest run each) split by how the situation was picked — matched, tie settled by rules, near miss chosen by the model, chooser said none, not settled, no match, not recorded — from `ticket_investigations.exemplar_match`. Always one row. Copied byte-for-byte from 06. Applied 2026-09-15 | 04, 06 |
| `24_rule_tones.sql` | adds `support_answers.tones text[] not null default '{}'` and `support_answers_tones_check` (the keys of `scripts/lib/reply-tones.mjs`), with the column comment — all copied from 05, which its test asserts. Every existing rule takes `{}`. Applied 2026-09-15 | 05 |
| `29_order_promotion_need.sql` | widens `support_exemplars.requirement_needs` by one value, `order_promotion`, so a situation can declare "was the promotion applied to this order?". Copied from 05. No data. Applied 2026-09-17 | 05 |
| `28_order_discounts.sql` | adds `orders.discount_applications` (one entry per promotion: kind, name, percentage or amount, target) and `orders.discount_codes`. The order already stored how much came off; this stores WHAT came off, which is what answers « mon cadeau a-t-il été appliqué ? ». Copied from 02. No data — the values arrive with a re-sync. Applied 2026-09-17 | 02 |
| `27_advice_collections.sql` | adds `advice_collections`: one row per Shopify collection (175 on this shop), with `is_active` / `axis` / `note` owned by the team and `product_ids` refreshed from Shopify for active ones only. Copied byte-for-byte from 02. No data. Applied 2026-09-16 | 01, 02 |
| `26_product_order_frequency.sql` | adds `insights_product_orders_per_customer()`: for one product, how many of its buyers placed 1, 2, 3… orders carrying a paid line of it, on the same filters as `insights_product_customer_mix()`. Copied byte-for-byte from 06. No table, no data. Applied 2026-09-16 | 01, 02, 06, 12, 19 |
| `25_rule_links.sql` | adds `support_answers.link_url` / `link_label` (checks: https only; both or neither, label ≤ 120) with their comments, and `ticket_drafts.reply_link jsonb` (object check) — copied from 05 and 07, which its test asserts. All null. Applied 2026-09-15 | 05, 07 |
| `22_segment_finder.sql` | adds `customer_segment_find()`: customers matching OR-of-AND conditions over orders and net spend in the last N months and lifetime net spend, every customer on file except marketplace-synthetic records; always one totals row plus the top 25 by lifetime spend. Copied byte-for-byte from 06. Applied 2026-09-14 | 01, 02 |
| `21_chat_vip.sql` | VIP status for the management chat: `chat.vip_customer_rows()` (security definer, no arguments, fixed `search_path`) applies `vip_customers()` with the shop's thresholds and the marketplace handles `vipArgs` excludes; `chat.vip_customers` reads it (ids, windowed orders + net spend), `SELECT` for `mgmt_chat_ro` only. Updates the `chat.shop` comment. Applied 2026-09-14 | 06, 12, 17 |

`_shared.test.mjs` holds the cross-file invariants (no data statements, RLS on every table, every table and view documented, nothing referenced before it is created, every view `security_invoker` and revoked from the anon roles, every embedded table carrying the whole determinism quadruple, and `scripts/lib/tables.mjs` naming exactly what the baseline creates). Each file has a sibling test for its own contents.

`_live.test.mjs` is the only test that **runs** the SQL: it applies the baseline into a throwaway schema, seeds a handful of rows, asserts each projection returns what it claims, and drops the schema. Skipped unless `SUPABASE_DB_URL` is set, so `npm test` still passes without a database.

### Read-only reports

`scripts/report-*.mjs`. No writes, no model calls, every figure from a table the
pipeline already fills. Each exists because the question it answers was being
argued about rather than measured.

| Command | Answers |
| --- | --- |
| `report:knowledge-gaps` | what customers asked that the library could not answer — the commissioning list for new articles |
| `report:investigation-calls` | how much of an investigation the MODEL chose, against what the opening moves had already decided. An upper bound: `tool_calls` drops the ledger's `source`, so opening moves are reconstructed from `openingMoves()` and a decomposed ticket's extra moves count as the model's |
| `report:evidence-vocabulary` | whether `state` and `finding` agree with each other. They read the same ledger by different routes, so a disagreement means one is wrong — no labelled set needed. `--since` cuts the corpus to runs after a date, because a derivation fixed last week leaves its wrong rows behind for ever |
| `report:completeness-gate` | what a §7 completeness gate would downgrade, before one is enforced. Scores each stored run on `response_complete` / `decision_complete` / `mandatory_gaps` / `tool_errors_affecting_answer`, and splits the downgrades by whether the open gap could EVER be closed — `gapClosability` in `evidence-rules.mjs`. Measured 2026-09-03 over 91 fresh runs: 12 downgrades, of which **4 are on gaps nobody can ever close**. `--since` and `--subject` |
| `report:collection-planner` | what rule-directed collection would collect, per situation, before one is switched on. Replays `collection-planner.mjs` over stored runs. **A FLOOR, not an estimate**: `tool_calls` drops each tool’s `data`, so a chained call (`lookupPromotion` from an extracted code) reads as unassemblable even where a live run could make it. Measured 2026-09-03: **30 of 90** fresh runs would get a proposal. `--since`, `--situation` |
| `report:collection-replay` | what stopping collection early WOULD have cost, per situation, from `findings_trace`. Walks each traced run to the point both stopping conditions first held and counts calls saved, **established facts lost**, and `answerable` runs stopped with an open gap. State comes from `tool_calls`, findings from the trace — both are needed, and re-deriving findings from the ledger alone would flatter suppression. Measured 2026-09-03 over 47 traced runs: **13 calls saved, 7 facts lost**, so nothing is suppressed. `--situation` |

## Surfaces

All Route Handlers are server-only and use the Supabase service-role key.

### Sign-in and roles

Accounts live in **Supabase Auth** (`auth.users`); the role is `app_metadata.dashboard_role`, which only the secret key can write. There is no sign-up page: `npm run users -- add --email … --role …` (hidden password prompt) is the only way to make one, and an account without a known role may open nothing.

`web/middleware.ts` stands in front of every page and every API route. Without a usable session a page redirects to `/login?next=…` and an API call gets a 401; with one, the role is checked against `canAccessPath` in `scripts/lib/dashboard-auth.mjs` (a page redirects to the role's first allowed panel, an API call gets a 403). Only `/login`, `/api/auth/login`, `/api/auth/logout` and `/api/webhooks/shopify` are open — the last because Shopify authenticates with an HMAC over the body rather than a cookie, and the handler checks it before doing anything else.

| Role | May open |
| --- | --- |
| `developer` | everything |
| `management` | everything |
| `contact` | everything except Insights → Overview, Sales and Marketing & funnel and the sales report download (the tabs are not drawn; the URLs redirect to Fulfilment) and Home — the management chat, page and `/api/chat` (not drawn in the sidebar) |

Two HttpOnly cookies carry the session: `qos_at` (the Supabase access token, one hour) and `qos_rt` (the refresh token). Each request checks the token's ES256 signature locally against the project's JWKS, then confirms it against `/auth/v1/user` — cached for a minute per token — so a ban, a role change or a sign-out takes effect within a minute rather than at the token's expiry. The middleware refreshes the pair when the hour is nearly up; both cookies expire twelve hours after the password was typed (`amr`), which is the longest a session can live without signing in again.

Managing accounts: `npm run users -- list | add | set-password | set-role | disable | enable`. Disabling is a Supabase ban, not a delete, so an audit row still resolves to a person.

### `/home` — the management chat (Beta)

`web/app/home/` → `components/chat/ChatView`, over `lib/server/chat-service.ts`. Developer and Management only (`canUseManagementChat`). A question goes to `POST /api/chat`, which streams NDJSON (`conversation` · `step` · `done` · `failed`) while `runChatTurn` (`scripts/lib/chat-agent-loop.mjs`) calls the model with one tool, `execute_sql`, for at most 8 steps.

Each query: `checkSql` (guard) → `createSqlExecutor` (as `mgmt_chat_ro`, `begin read only`, `set local statement_timeout`, wrapped `limit 1001`, rolled back). The model sees ≤ 200 rows of a result; the screen shows it all (preview 200), the log keeps 50. The system prompt (`chat-system-prompt.mjs`) = rules + the data's known limits + the `chat` schema's comments, re-read every 10 minutes. Follow-ups replay earlier questions, answers and **their SQL**, never their rows.

Env: `CHAT_DB_URL` (the role's pooler URL; unset = the page says so and nothing runs), `CHAT_MODEL` (default `gpt-5.2`; the OpenAI transport sends reasoning models `max_completion_tokens` and no `temperature`).

- `POST chat` — `{question, conversationId?}` → NDJSON
- `GET chat/conversations` · `GET chat/conversations/:id` — the signed-in user's own; another user's id is a 404

### `/agent-setup` — knowledge library

`web/app/agent-setup/` → `web/components/agent-setup/`, over `web/lib/server/knowledge-service.ts` (which imports `scripts/lib/*` directly rather than duplicating the resolver, mapper and chunker).

- `GET knowledge/shopify-sources` — the catalog, flagging what is already imported
- `GET|POST knowledge/articles` — list; create empty, or resolve a `sourceId`'s live content
- `PATCH knowledge/articles/:id` — converts `source_type` to `manual`; demotes `approved` → `in_review` on a text change; re-embeds inline (best-effort)
- `POST knowledge/articles/:id/resync` — 400 once `manual`. `DELETE` — hard delete, chunks cascade

**Parameters** (`/agent-setup/parameters` → `components/agent-setup/ParameterList`, over `lib/server/parameters-service.ts`). One number held once, so a rule comparing against it, an article stating it and a skeleton quoting it cannot disagree — the failure that argued for it was live: two approved articles gave two different returns windows. **The catalogue is code** (`scripts/lib/parameters.mjs`) and only the values are data, so the screen offers exactly the parameters something reads; rows are created on demand. **Every value starts null**, which is a real state each reader handles. No approval step, unlike a rule: a parameter is a fact rather than a behaviour. Two of them are a pair: `france_delivery_days` and `abroad_delivery_days` are the same window for different destinations, picked on the order's `country_code`, and either one unset leaves `delivery_delay_state` `unknown` for the destinations it covers rather than for all of them — which is why `POWERED_BY` in `policy-service.ts` maps a state to a LIST of parameters and the editor names which is missing.

- `GET|PUT parameters` — every parameter set or not · set one, or clear it with a null

**Forwarding** (`/agent-setup/forwarding` → `components/agent-setup/ForwardingSettings`, saves per row on blur). `GET|PUT /api/forwarding` over `forwarding-service.ts`: all 14 ticket categories with their address (`null` where unset); `PUT` upserts one, an empty address clears it. Moved here from `/settings` 2026-09-15.

**Navigation is a tab bar** in `agent-setup/layout.tsx` — Knowledge · Rules · Parameters · Promotions · Recommendations · Forwarding, places of equal standing. Matched exactly rather than by prefix, since `/agent-setup` is a prefix of the other two.

**Which product an article is about** (`ProductAttachSelect` in the article workspace, over `PATCH /api/knowledge/articles/[id]`; the catalogue comes from the existing `/api/recommendations`). Writes `knowledge_documents.product_ids`, denormalised onto `knowledge_chunks` by `buildKnowledgeChunks` the same way `category` is, and returned by both retrieval RPCs. `agent/src/retrieval/product-from-knowledge.mjs` turns a retrieved chunk's tag into an identity, and `evidence-rules.mjs` reads it from one helper (`productFromArticles`) shared by `product_identity`'s `satisfiedBy` and its `derive`, so the need and the finding cannot disagree. Deliberately NOT in `content_hash`: retagging rewrites chunk rows without re-embedding a word.

> `category` and `product_ids` answer different questions — the first decides **when** an article is searched (`categoriesToSearch` = the ticket's subject plus `faq`/`brand_story`/`other`), the second decides **what it resolves to** once found. Attaching a product does not make an article reachable from another subject.

**What we can advise on** (`/agent-setup/collections` → `components/agent-setup/CollectionList`, over `lib/server/collections-service.ts`, `/api/collections` and `/api/collections/[id]`). All 175 Shopify collections, searchable, with a switch and an axis (`concern` / `category`) per row writing `advice_collections.is_active` / `axis` / `note` — the three columns on that synced table this app owns. A **Sync from Shopify** button (`POST /api/collections/sync`) runs the collections sync on demand and returns the refreshed list — it cannot switch anything on. **Activation is its own endpoint** (`PATCH`), separate from the axis and note (`PUT`), the same split `setRuleApproval` keeps: switching a collection on is what lets its products reach a customer. **An axis is required to go live and cannot be cleared while live** — a `category` is a group of products the answer offers and a `concern` ranks products inside those groups, so a collection with neither cannot be placed; refused from both directions. Nothing is active by default: a product sits in 18–30 collections, most of them seasonal (`Black Friday` 92 products) or diagnostic-quiz output.

**What we suggest, by skin type** (`/agent-setup/recommendations` → `components/agent-setup/RecommendationList`, over `lib/server/recommendations-service.ts` and `/api/recommendations`). Writes `products.recommended_for_concerns` — the one column on that synced table this app owns. Curated rather than derived from the tags: `peaux sensibles` is on 52 of 90 sellable products and « tous les types de peaux » on 52 more, so a tag query answers "these 64", which is not a recommendation. The tag match is shown as a starting hint, and the list is searchable over title AND description (90 rows, and half these products are looked for by what they do rather than by the name on the box). `agent/src/retrieval/product-concerns.mjs` holds the closed concern vocabulary (catalogue `tags` ↔ customer `cues`) and `unclassifiedSkinTags` reports skin-family tags belonging to no concern after a product sync. **Since 2026-09-16 the tabs are the five skin concerns AND the live collections**, both valid in the same column: a concern's ticks ARE the answer (the agent reads the concern out of the message), where a collection's only reorder an answer the intersection already found — so an untouched collection is no preference rather than a gap. `tickableKeys` refuses anything outside the two vocabularies.

**Codes support may offer** (`/agent-setup/promotions` → `components/agent-setup/PromotionList`, over `lib/server/promotions-service.ts` and `/api/promotions`). Every ACTIVE code discount from Shopify, with one switch per row writing `promotions.offerable_in_replies` — the only column on that synced table this app owns, and the only thing on the screen that is editable. `?offerable=true` is what the drafting screen fetches, so partner rates and the 100%-off product code never reach a reply surface.

**The rulebook** (`/agent-setup/rules` → `components/agent-setup/RuleBook` + `RuleEditor`, over `lib/server/policy-service.ts`). Per-situation workflow view: left rail selects answer set and situation, center canvas projects the existing `support_answers` rows into evidence decisions and branches, right inspector summarises the selected outcome. **Editing is a slide-in panel** (`RuleEditor`, over the canvas): scope (answer set, situation) comes from where it was opened and changes only behind a disclosure; cards When · Then · Reply (guidance, tones, link, code, article); opened from a branch a general rule already answers, it offers "Use a general rule" (lists the set's general rules, drafts marked; the pick is stored per branch in the browser by `lib/general-rule-choices.ts` and marks that branch "General rule applies", with a note where the agent would not use it — never sent to the backend). Each situation canvas's General rules section has "Create a general rule" (situation null, conditions narrowed on the situation it was started from via `contextSituationKey`). A branch no situation rule answers but a live general rule does reads "General rule applies" rather than a gap (`generalRulesCovering` in `lib/rule-labels.ts`, which also holds the English display names of the shared rules — keys unchanged); a collapsible "How a rule is chosen" recap; conditions open on the situation's needs (`requirementNeeds` from `listSituations`, the needs its other rules name, this rule's own, plus prerequisites) with "show all" one click away. **The decisions come from the situation's OWN rules**; the set's situation-less rules keep a separate lane below, because they can never win where a situation-keyed rule matches. The canvas is a projection only: runtime still uses `answer-selection.mjs` (situation outranks condition depth, priority breaks ties), not first-match visual order. Reads and writes `support_answers`. The editor's every choice — which states a condition may name, where a rule may route, what it may ask for — is derived from `evidence-rules.mjs` and `case-file.mjs` at request time, so the dashboard can never offer a state the agent cannot score. The vocabulary also carries each need's `requires` list from `needRequires()`, so the UI can show prerequisites such as `order_identity` before dependent order states. Needs with no findings are excluded rather than shown empty. Validation is `normaliseConditions` + `auditAnswerSet`, the agent's own functions, run before the row exists.

- `GET|POST policy/rules` — the rules, situations and vocabulary in one payload · save (always as `draft`)
- `PATCH|DELETE policy/rules/:id` — approve or withdraw · remove

**Saving never approves.** Approval is its own endpoint, because editing a rule is authoring and approving one is what lets it move somebody's mail.

**The test chat** (`components/agent-test/`, over `lib/server/agent-test-service.ts`). Opened from the header button (a free test) or from an article's rail (that article's retrieval, asserted). A message goes in, the real passes run against an in-memory database, and the transcript shows every tool call with the exact text the model was handed.

- `POST agent-test/run` — streams the run as NDJSON, one line per step. No ticket is written
- `GET agent-test/runs` — the history, without traces, plus readiness (OpenAI key, brand voice)
- `GET|PATCH|DELETE agent-test/runs/:id` — one run · save/clear the **ideal answer** · delete

**Reuse this message** on an opened run puts its name, subject, body and order number back in the composer. The address is not among them — `agent_test_runs` stores only the mask — and the notice above the composer says so, because a rerun that silently dropped the identity would resolve no customer and read as a regression in the agent.

### `/tickets` — the queue

**Consumer threads only.** `listTickets` and `listConversations` are two halves of one partition on `tickets.sender_label` (`partitionBySender`), so a thread is on exactly one of the two pages and never on neither: 234 = 220 + 14.

**The URL holds the reading state**: `?view=&q=&level=&category=&sender=&sort=&ticket=&mail=` (defaults omitted). `page.tsx` passes `searchParams` to `TicketsView` as `initialParams`; the view keeps the address in step with `replaceState` and mirrors it to `sessionStorage` (`tickets.lastSearch`), restoring from there when opened as a bare `/tickets`. `reconcilePageState` follows a saved ticket to its current tab. See DECISIONS.md § Tickets dashboard.

`web/app/tickets/` → `web/components/tickets/`, over `tickets-service.ts` + `dropped-mail-service.ts`. `tickets-service.ts` does not touch `tickets` itself: every read and the one write go through `scripts/lib/ticket-record.mjs`, and the list reads the `ticket_queue` view. Queue priority is computed in `scripts/lib/ticket-priority.mjs`; the view supplies facts (`inbound_count`, `waiting_since`), JavaScript owns the tunable judgement. Four stacked collapsible sections, each scrolling inside a fixed height:

| Section | Source | Row action |
| --- | --- | --- |
| **Queue** | `tickets`, status not resolved/closed, waiting less than 14 days | Close ticket |
| **Irrelevant** | `spam_audit`, `outcome = 'blocked'`, minus the promoted, minus the cleared | **Add as ticket** · **Select → Clear** |
| **Backlog** | `tickets`, status not resolved/closed, waiting 14+ days | Close ticket |
| **Closed** | `tickets`, status resolved/closed | Reopen ticket |

**Add as ticket** overturns one gate decision. `POST /api/dropped-mail/:id/promote` → `dropped-mail-service.ts` → `agent/src/ingestion/promote-dropped-mail.mjs`, which maps the `spam_audit` row into the shape `mapGraphMessage` produces and writes it through `writeIngestedMessages` — the ordinary ingestion path, so threading, idempotency, `needs_categorisation` and the reopen rule are ingestion's and not a second copy of them. The worker's next poll then categorises, resolves and investigates it like any other ticket. Disabled where the row has no stored body. **No schema change and no write to `spam_audit`**: promoted is derived — a blocked row whose `graph_message_id` now exists in `ticket_messages` — and drops out of the section on that basis.

**Select → Clear** hides dropped mail somebody has finished reading. `IrrelevantWorkspace` in `TicketsView.tsx` and nothing else: **no route, no service, no write** — the cleared ids live in `localStorage` under `tickets.clearedMail`, are subtracted from the list and from the tab count, and **Restore N** in the same header brings them all back. Select mode turns each row into a checkbox (row click ticks instead of previewing); Cancel leaves it untouched.

Layout: **three panes, selection-driven** (`TicketWorkspace`) — `TicketListPane` (the queue), `detailPane` (`TicketDetailWorkspace`: one header block — title row, the investigation's **Next action** on one line, and a **Conversation | Activity** tab strip as its bottom edge — then `ConversationThread` (date-grouped, each message shows only its new text via `scripts/lib/email-display.mjs`; quoted history, forwards, signature and the original sit behind disclosures) or `ActivityTimeline` (one oldest-first feed: every email in/out off the thread, the investigation's tool-call ledger from `summariseActivity` in `tickets-service.ts`, and draft generation — an icon per kind) — then `DraftResponsePanel`), and the right-hand `contextPane` (`TicketContextPane`: Customer · Ticket · Order · Investigation · Required action · **Attachments** · **Situation & rule**). The context rail is also the mobile `contextSheet`. **`TicketTable` and `TicketDetailPanel` are NOT on this page** — they render `/conversations` only, and this line described them as the Tickets row expansion until 2026-09-09, which is a stale description that cost a feature being built into the wrong component. **Situation & rule** is last, off `ticket_investigations.exemplar_match` (`summarisePolicy` in `tickets-service.ts`, read field by field so the case file's diagnostics cannot leak onto a support screen): which situation the run settled on and how (`matched` / `near miss, chosen by the agent` / `nothing close enough`, with the score and the closest loser), which rule its findings selected, whether that rule **changed the verdict** or only shaped the reply, and what it asked for (route, asks, offer code). Shown even when nothing matched — a ticket no rule answered is a gap in the rulebook and is otherwise invisible until read in a transcript. The Attachments block is above it and renders only on the 114 of 383 tickets that carry a file or claim to: the customer's photos inline — proxied per view from the mailbox through `/api/tickets/[id]/attachments/[index]`, never stored — plus a warning where a photo was mentioned and none arrived, and the names of any non-image files. The **Order** block lets a person link the order themselves, through `OrderLinkDialog` and `/api/tickets/[id]/order`. A confirmed order carries a pencil beside its number. No order shows **Add order number**. A candidate last order shows **Confirm this order** (plus **Add order number**). The popup has two steps: look the number up and see a preview (order, date, channel, name, masked contact, and how it relates to the sender's email), then confirm that it re-runs the investigation. Open to every role. The service is `previewTicketOrder` / `changeTicketOrder` in `tickets-service.ts`; the write is `ticket-record.linkOrderManually`, conditional on the order the popup was opened on. Four header cards, plus level tabs, category filter (matches the primary **or** the secondary category), sender filter and sort, all client-side over the open-ticket set. Search is per view. In the Irrelevant view the subject opens the dropped email (`DroppedMailDialog`).

### `/conversations` — threads we opened

`web/app/conversations/` → `web/components/tickets/ConversationsView.tsx`, over `listConversations` in `tickets-service.ts`. The other half of the `/tickets` partition: threads whose opening sender is one of ours (`sender_label` = `internal` | `contractor`), stamped at ingestion from `sender_directory`. The agent investigates these but never drafts on them (`draftDecision` → `internal_sender`).

Two sections over the same `TicketTable` the queue uses — **Open** (expanded, leads the page) and **Closed** (collapsed). No level tabs, category filter or stat cards: 14 rows where the only useful questions are what is still open and where a forward went.

`countOpenThreads` (one `queue()` read, both halves of the partition — shared per request with the page's own list through React `cache`, and started beside the page's reads rather than before them) feeds the sidebar's open-count badges — Tickets in the warning colour, Conversations grey, both hidden on the collapsed rail — rendered from **every** page in the shell via `navBadgeCounts` in `lib/server/conversation-badge.ts`. The same call also returns `unfulfilledOrders` (`countOrdersAwaitingFulfilment` in `orders-service.ts`, a `count=exact` HEAD using `open_orders()`'s rule) for a grey badge on Orders; each count fails on its own. That is the mitigation for routing these off the queue at all — the arrangement failed once by being silent. See DECISIONS.md § Tickets dashboard.

### `/insights` — the seven analytics panels

`web/app/insights/{overview,sales,customers,marketing,fulfilment,support,agent}/page.tsx` → `InsightsPage` (tabs in that order, from `INSIGHTS_PANELS` in `web/lib/types.ts`)
→ one view in `web/components/insights/`, over `web/lib/server/insights/*-service.ts`.
`/insights` redirects to `/insights/overview` (Fulfilment for the contact role).

**The URL is the state.** `context.ts` resolves shop, timezone, range
(`resolveRange` in `scripts/lib/insights-range.mjs` — a preset, `?month=` or from/to),
the month picker's options, platform and freshness from
the query string; `FilterBar` and `InsightsNav` write it (tabs carry the range
across). The server re-renders; nothing is aggregated in the browser.
`LiveRefresh` re-renders every 5 minutes while visible.

| Panel | Range | Platform | Reads |
| --- | --- | --- | --- |
| **Overview** | yes (the stock card is "now") | yes | orders summary + series (revenue, orders, AOV), `insights_sales_overview` (units, discounts), orders by channel, product sales (top 5), `insights_inventory_exceptions`; **every money figure from one live ShopifyQL ladder** (`liveSales` / `liveSalesSeries` in `analytics.ts`: net sales, orders, AOV, refund rate = returns ÷ gross sales, the trend, the drivers, the signals, net sales per session, the platform mix; our orders only as a labelled fallback); **sessions and conversion from stored months + live**; each card streamed in on its own (Suspense); units and top products from our orders; signals + bridge + drivers from `sales-overview.mjs`; the report download (`ReportDownload`, months that have ended) |
| **Marketing & funnel** | yes | yes (newsletter always Shopify) | orders summary, `insights_sales_overview`, `insights_promotions`, the newsletter rows (churn, movement, capture — moved here from Customers), and **ShopifyQL** (`analytics.ts`, each card streamed in on its own): the four-step funnel, acquisition channels, landing-page types and the busiest product pages (named from `products.handle`); **Klaviyo** from `insights_klaviyo_messages` (open rate first: tiles over every flow and campaign in the range, table of those with ≥ 1 click sorted by open rate; blocked when not connected, not yet synced, or on a marketplace). Product VIEWS stay blocked — no metric; Paid / Social blocked — not connected |
| **Sales** | yes | yes | orders summary + series + by channel + by country, customer mix (marketplaces excluded), product sales, country product sales (re-read over VIP customers' orders with `?bestVip=1`), product pairs, and the "Who buys this product" card (`insights_product_customer_mix` + `insights_product_orders_per_customer` for `?product=`, both on the same arguments, optionally `?mixCountry=` and `?mixVip=1`, marketplaces excluded; `ProductCustomerMixCard` with a searchable product picker and its buyers-by-order-count chart) |
| **Fulfilment** | yes (the open-orders list and the stock card are "now") | yes | orders summary + series, fulfilment buckets + carriers, `open_orders()` (orders waiting to ship, VIP-marked, with name + email — `open-orders.ts`), `insights_inventory_exceptions` (`inventory.ts`) |
| **Support** | yes | no — tickets have none | support summary + series + categories, orders summary (contact-rate denominator), the latest `cluster_runs` for the topic map (all-time, with a Rebuild button) |
| **Customers** | the activity rows only (the base is a snapshot) | no — people, so always Shopify | `customer_segment_totals` + `customer_ticket_facts` + `customer-segments.mjs`; orders per customer (`customer-activity-service.ts`; the newsletter and capture rows moved to Marketing & funnel on 2026-09-23 — the order-count columns are folded by `order-frequency.ts`, shared with the Sales product card so both charts cut the tail at 10+ the same way); the Segment Finder under the base cards, on demand through `POST /api/insights/segment-finder` -> `segment-finder-service.ts` -> `customer_segment_find()` |
| **AI agent** | yes | no | llm usage + series + ticket stats (priced by `llm-rates.mjs`), agent funnel + situation picking (`insights_agent_situations`) + verdicts + blockers |

**One panel read is not from our database.** `analytics.ts` calls Shopify
(ShopifyQL): **net sales and AOV live for the exact window at every range
length** (they cannot be derived from our columns), and sessions from
`storefront_session_months` for closed months plus live for the last two months
and a range's edges — see `DECISIONS.md` § "Closed months of sessions are
stored". Every live query goes through `shopifyql.ts` (one per request,
priority queue, waits for the analytics bucket's reset, 5-min cache per
query). Each part is its own promise; the views await them inside Suspense, so
database cards render at once and each Shopify card streams in. Nothing throws:
a failure becomes a `blockedReason` the card renders as a dash.

**Every chart point carries a state** — `measured` / `partial` / `missing` from
`bucketCoverage` against the freshness edges — and `TimeSeriesChart` hatches
`missing`, so an unsynced day never draws as zero. A figure that cannot be
computed is a `BlockedCard` with a required reason, never `0`.

The Support topic map reads the latest `cluster_runs` row and renders each
`ticket_clusters` row as its own treemap tile; labels come from
`clusterLabel()` in `web/lib/insights-support.ts`.

### `/orders` — every Shopify order

`web/app/orders/` → `web/components/orders/`, over `lib/server/orders-service.ts`. Replaced the "Knowledge — Soon" sidebar item. Open to every role.

**List** (`OrdersView`): Order · Date · Name (+ crown when VIP) · Total · Fulfilment status (amber dot until fulfilled) · Delay (whole days waiting to ship, red at 3+, blank once not waiting) · Articles · Carrier · Destination. A search box (order name, buyer name or email, tracking number; debounced) plus filters for fulfilment status, Global / By country, and All customers / VIP only; with the page number they live in the query string (`?q= ?status= ?country= ?vip= ?page=`, parsed by `order-list-query.mjs`) and the server re-renders. 50 rows per page, paged and counted by `orders_list()`. **The customer name is ringed** red / orange / green when an open ticket is confirmed against that order (`tickets.shopify_order_number`), in the most urgent ticket's queue band — read off `listTicketsWithOrders`, folded by `ticketMarksByOrder`, never re-scored. A row opens `/orders/[id]`.

**Detail** (`OrderDetailView`): Articles, **Promotions**, Fulfilment (shipments, tracking links, returns), Payment (totals, refunds) on the left; Tickets, Customer (name, email unless marketplace, lifetime orders/spend, VIP), Destination (coarse — no street is stored), Tags on the right; "Open in Shopify" in the header. Both pages write a `data_access_events` row (`resourceType: orders`). **Promotions** lists what was applied by name (from `orders.discount_applications`), the gifts with their value and the promotion that gave them, plain reductions, the codes used and — listed apart, never as gifts — the samples; "no promotion was applied" is rendered rather than hidden. Opened as `/orders/[id]?ticket=<uuid>` (the link on a ticket's order number), the page leads with **← Back to the ticket** to `/tickets?ticket=<uuid>`, with Orders beside it.

### `/settings` — My info · Agent settings · Integrations

`web/app/settings/page.tsx` → `components/settings/SettingsView` (the Insights page frame, tab bar, cards and tables). Tab in the URL: `/settings`, `?tab=agents` or `?tab=integrations`; only the open tab's data is read.

- **Integrations** — developer and management only (`canManageIntegrations`; the tab is not drawn for contact and `/api/settings/integrations` is denied in `dashboard-auth.mjs`). `KlaviyoKeyCard` over `lib/server/integrations-service.ts` and `PUT|DELETE /api/settings/integrations/klaviyo`: the key is checked with Klaviyo (`connectKlaviyo`), then stored in Vault; the card shows `pk_…` + last 4 and the last sync.

- **My info** — the signed-in user from `getSession()`, and which areas the role may open (`canAccessPath` in `dashboard-auth.mjs`).
- **Agent settings** — `lib/server/agent-settings-service.ts`: one row per agent (spam, categorise, situation chooser, decompose, investigate, draft, embed from `insights_llm_usage`; the management chat from `chat_turns`), last 30 days: model (most-called in the window, else the configured one from `loadAgentConfig` / `chatModel()`), calls, failed, cost via `llm-rates.mjs`. Read-only.

## Agent Worker

Run `npm run ingest:once` or `npm start` from `agent/`. One poll runs every pass below, **in this order** — the order is load-bearing (see `DECISIONS.md`), and `agent/src/poll-order.test.mjs` asserts it rather than trusting this table.

| # | Pass | Module |
| --- | --- | --- |
| 1 | load config, assert Graph creds, resolve `shops.id` | `index.mjs` |
| 2 | follow Graph delta pages, persist cursor | `ingestion/delta-poller.mjs` |
| 3 | map messages; derive direction + normalise contact-form identity | `ingestion/graph-message-mapper.mjs` |
| 3a | **Known-sender exemption** — an address in `sender_directory` bypasses BOTH gates; the LLM call is skipped, not overruled. Can only keep mail, never block it | `ingestion/known-senders.mjs` |
| 4 | **Gate 1** (no LLM): blocklist match → dropped before any write | `ingestion/spam-gate.mjs` |
| 5 | thread survivors by conversation; embed inline (best-effort) | `ingestion/ticket-writer.mjs` |
| 5a | **Duplicate link** (deterministic, pre-embedding): reply chain, or identical body inside an hour → the ticket is skipped by drafting *and* investigation. Fires only on the message that *creates* a ticket | `ingestion/duplicate-rules.mjs` |
| 5a2 | **Sender label** — the opening address is looked up in `sender_directory`; `internal`/`contractor` stamped onto the ticket | `ingestion/sender-directory.mjs` |
| 5b | **Related link** (post-embedding, consumers only): cosine ≥ 0.90 from the same sender inside 30 days → context + cross-ticket chase. Never suppresses | `ingestion/related-rules.mjs` |
| 6 | **Gate 2** (LLM, new conversations only): drops `spam` **and** `irrelevant`; fails open | `ingestion/spam-classifier.mjs` |
| 7 | flush gate decisions (with body on a block) to `spam_audit` | `ingestion/spam-audit.mjs` |
| 8 | **Customer resolution** — needs no category, order number or LLM key | `resolution/customer-resolution-runner.mjs` |
| 8a | **Casework** (LLM, existing cases only) — what the newest message changed. Claims only a ticket that ALREADY has a case file and whose newest inbound message has no reading, so a genuinely new case matches nothing. Writes `ticket_case_state` | `casework/case-runner.mjs` |
| 9 | **Categorisation** (LLM) — 25/poll, oldest first, selects on the pending flag. **Skips the call on a `continuation`** and re-completes the existing labels, so the pass still clears the flag and raises `needs_investigation` | `pipeline/categorise-runner.mjs` |
| 10 | **Order resolution** then **order context** — no LLM, no category needed. **Before the investigation, and that is load-bearing**: `getOrderContext` READS `tickets.resolved_context` rather than querying, so an investigation that ran first could not see an order however clearly the customer quoted it | `resolution/order-*-runner.mjs` |
| 11 | **Investigation** (LLM + tools) — decompose (every investigated ticket — the structural gate was removed 2026-08-09), then 6 tool calls +2 per extra task, 4 turns, `ENABLED_SUBJECTS` only. Reads the thread **both directions** since 2026-09-21 and renders it as a labelled transcript; a one-message ticket still renders bare | `investigation/investigation-runner.mjs` |
| 12 | **Forwarding** — `contact` kind + a configured address; needs `Mail.Send` | `routing/forward-runner.mjs` |
| 13 | **Auto-close** — 28d idle, level 4 exempt; last so it sees this poll's timestamps | `lifecycle/auto-close.mjs` |
| 14 | **Retention purge** — nulls expired `spam_audit` bodies; best-effort | `ingestion/spam-audit.mjs` |
| 15 | **Cost flush** — one insert of this poll's `llm_usage` rows. Like 14, runs whatever `--stop-after` says: the calls were already billed | `llm/usage-store.mjs` |

Built through Phase 4 (retrieval tools + the agent that uses them). **Drafting is built as a standalone pass (`npm run draft`) and is deliberately NOT in the poll yet** — it is the first pass whose output a customer would read, and it stays operator-triggered until the drafts have been reviewed.

### Agent CLIs

From `agent/`. Every pass has a standalone runner, most with `:dry-run`.

| Command | Does |
| --- | --- |
| `ingest:once` / `start` | one poll / the loop. Supports `--limit=N` (the newest N messages, written oldest first; the cursor is not saved); with `--stop-after=categorise`, that limit applies to both Graph ingestion and the categorisation batch |
| `ingest:reset` | clear the delta cursor |
| `blocklist:add` | add a blocklist rule |
| `spam:backfill[:dry-run] -- --limit=N` | re-read dropped mail from Graph to fill `spam_audit` bodies |
| `attachments:backfill[:dry-run] -- --limit=N` | fetch attachment metadata from Graph for messages ingested before the column existed |
| `customers:resolve[:dry-run]` | link `tickets.customer_id` from the requester hash |
| `customer:lookup -- <email> [--json] [--with-email]` | the CRM tool, no ticket needed |
| `orders:resolve[:dry-run]` | confirm order numbers |
| `context:build[:dry-run] [--refresh]` | fill `tickets.resolved_context` |
| `investigate[:dry-run] [--show/--brief] [--backfill] [--include-closed] [--ticket <id>]` | run + render case files. `--backfill` re-queues **open** categorised tickets; `--include-closed` widens the claim to threads the queue has moved past, leaving their status untouched. Both print what the run cost. `--ticket` narrows the queue to one ticket without bypassing its flag |
| `draft[:dry-run] [--show] [--ticket <id>] [--limit N] [--redraft]` | the drafting pass. Reads case files, writes `ticket_drafts`; **no Graph call**. Refuses unless the Brand voice article is `approved`. `--redraft` overwrites an existing draft — the queue is derived, so a ticket leaves it once one exists |
| `cases:reconstruct [--ticket <id>] [--limit N] [--min-inbound N] [--json <path>]` | reads finished threads and reports where each case stands. **Writes no ticket, no case file and no draft** — it is built with a reader and no record module. Defaults to threads with 2+ customer messages, because a one-message thread has no trajectory to reconstruct. The output is a review artefact nothing downstream reads: correct it by hand and it becomes the labelled set a regression suite can rest on |
| `cases:review -- --in <json> --out <name>-review.html` | the reconstruction JSON plus each thread, as a page to disagree with. No model call, no write. `*-review.html` is a gitignored name because these quote real customer mail in full |
| `tickets:requeue[:dry-run] -- --ticket <id> [--unlink-customer] [--reopen]` | put named tickets back in the investigation queue after a repair; optionally clear `customer_id` (then run `customers:resolve`) and reopen an agent-set status |
| `forward:once` / `forward:dry-run` | the forwarding pass |
| `tickets:autoclose[:dry-run]` | the lifecycle pass |
| `eval:closure [-- --repeat N] [--show]` | closure detection over every thread where a customer wrote after our reply — the whole population, 16 threads. The one eval whose corpus is real mail: ids and labels are checked in, bodies are read live. A false closure fails the command; a missed one does not |
| `eval:categorise` · `eval:retrieval` · `eval:diagnose` · `eval:exemplars` (`-- --authored-only` drops the translations, for a same-corpus A/B) · `review:sample` · `review:compare` | every measurement — indexed in **`agent/eval/README.md`**, which says what each is judged against (three labelled sets, two proxies) |

## Read Order

`AGENTS.md` (rules) → **this map** → `DECISIONS.md` (why, per section, on demand) → `PRODUCT.md` (design direction) → `README.md` (status + setup).

Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
