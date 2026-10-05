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
|                    # sync:social (Meta + Google Ads; tokens from Vault)
|                    # probe:meta (which Meta metric names still answer)
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
|   |   |-- agent-setup/policies/page.tsx # Server Component: the company policies
|   |   |-- agent-setup/rules/page.tsx    # Server Component: the rulebook
|   |   |-- agent-setup/parameters/page.tsx  # Server Component: the numbers
|   |   |-- tickets/page.tsx              # Server Component: the agent's queue --
|   |   |                                 # EVERY ticket, staff-sent included
|   |   |-- orders/page.tsx               # Server Component: every Shopify order, paged
|   |   |                                 # in SQL; reads ?status= ?country= ?vip= ?page=
|   |   |-- orders/[id]/page.tsx          # Server Component: one order on cards
|   |   |-- insights/                     # -> /insights/overview, then one route
|   |   |                                 # per panel: overview · sales · marketing ·
|   |   |                                 # fulfilment · support · customers · social ·
|   |   |                                 # agent. social also reads ?mode= ?network=
|   |   |                                 # ?view= ?connections=1
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
|   |       |-- webhooks/graph/route.ts       # PUBLIC (clientState, not a session).
|   |       |                                # Graph change notifications: echoes the
|   |       |                                # validationToken, else queues one
|   |       |                                # `sync_mailbox` job per folder and
|   |       |                                # answers 202. Reads no mail. Dormant
|   |       |                                # until MAIL_WEBHOOK_URL names it
|   |       |                                # (scripts/lib/graph-notifications.mjs)
|   |       |-- tickets/[id]/route.ts         # GET case file + order facts · PATCH status
|   |       |-- tickets/[id]/draft/route.ts   # PATCH approve / edit / reject a draft;
|   |       |                                # with OUTBOUND_SEND_ENABLED, approve/edit
|   |       |                                # also queues an outbound action + job
|   |       |-- tickets/[id]/order/route.ts   # GET preview an order · PUT link it by hand
|   |       |-- tickets/[id]/overrides/route.ts # PUT « Edit case »: a person's corrections
|   |       |                                # (saveTicketOverrides); re-folds the ticket
|   |       |-- tickets/[id]/thread/route.ts  # GET the conversation (message bodies)
|   |       |                                # + `reply` (can a person send here, the
|   |       |                                # target message, their manual replies)
|   |       |-- tickets/[id]/reply/route.ts   # POST a reply a person wrote (« Create
|   |       |                                # draft »): queues a `manual` outbound
|   |       |                                # action + job; sends nothing itself
|   |       |-- company-policies/route.ts     # GET the library · POST a new policy
|   |       |-- company-policies/[key]/route.ts  # PUT save (text change raises the
|   |       |                                # version; stale save refused)
|   |       |-- company-policies/links/route.ts  # POST link to a situation or rule ·
|   |       |                                # DELETE ?id= unlink
|   |       |-- tickets/[id]/snooze/route.ts  # POST snooze (a time, or a party with the
|   |       |                                # shop's delay as deadline) · DELETE wake
|   |       |                                # now. snooze-service.ts
|   |       |-- tickets/[id]/attachments/[index]/route.ts
|   |       |                                # GET one photo, proxied from the mailbox.
|   |       |                                # The only binary response in this API;
|   |       |                                # nothing is stored. attachment-service.ts
|   |       |-- forwarding/route.ts           # GET destinations + ack settings + default templates
|   |       |-- forwarding/destinations/      # POST add · [id] PUT replace · DELETE
|   |       |-- forwarding/settings/route.ts  # PUT the acknowledgement (on/off, FR/EN templates)
|   |       |-- settings/integrations/klaviyo/route.ts  # GET status · PUT {key} (checked
|   |       |                                  # with Klaviyo, then Vault) · DELETE. Never
|   |       |                                  # returns the key. Closed to contact
|   |       |-- settings/integrations/social/ # GET Meta + Google status · accounts/[id]
|   |       |                                  # PATCH {enabled}. Never returns a token
|   |       |-- settings/integrations/[provider]/  # meta|google: start (GET -> consent
|   |       |                                  # screen, signed state + cookie) · callback
|   |       |                                  # (code -> Vault, accounts, queues
|   |       |                                  # sync_social) · sync (POST, Sync now) ·
|   |       |                                  # DELETE disconnect. social-connections-service
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
|   |       |-- reports/sales/route.ts       # PUBLIC (Bearer SALES_REPORT_SECRET; 404
|   |       |                                  # while unset). GET ?month= -> the same
|   |       |                                  # report, for the worker's monthly mail
|   |       |-- knowledge/                   # shopify-sources · articles · articles/[id]
|   |       |                                 # · articles/[id]/resync · format (« Format as
|   |       |                                 # FAQ », stateless, writes nothing)
|   |       `-- agent-test/                   # run (NDJSON stream, writes no ticket) ·
|   |                                         # runs · runs/[id] (ideal answer)
|   |-- lib/i18n/                          # UI language (fr default, en): locales.ts (choice,
|   |                                      # cookie `qos_lang`) · en.ts (owns the keys) ·
|   |                                      # fr.ts (typed against en) · translate.ts (params,
|   |                                      # plurals) · format.ts (numbers, money, dates) ·
|   |                                      # server.ts getT() · client.tsx useT()/useLocale().
|   |                                      # PUT /api/preferences/locale sets the cookie and
|   |                                      # user_metadata.locale; sign-in restores it
|   |                                      # messages/ holds the strings: shared.ts (enum labels: category,
|   |                                      # status, level, team, need, sender, time) + tickets-*.ts +
|   |                                      # insights-*.ts. lib/insights-labels.ts words periods,
|   |                                      # buckets and freshness; lib/segment-messages.ts the
|   |                                      # Segment Finder. Insights numbers: useFormat()/getFormat()
|   |                                      # Screens pick keys; services return codes, not sentences
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
|   |   |                            # FreshnessStrip (Orders / Email / Nightly sync
|   |   |                            # pills: Insights header + Tickets header) ·
|   |   |                            # TrackingText (tracking numbers -> carrier links,
|   |   |                            # used by every surface showing a number in prose)
|   |   |-- settings/                # SettingsView (Insights kit: tabs, cards, tables) ·
|   |   |                            # KlaviyoKeyCard (write-only key field, last sync) ·
|   |   |                            # AgentModelPicker (one agent's model, Agent settings)
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
|   |   |                            # VipRuleCard + SegmentFinder + CustomerActivityRows · AgentView ·
|   |   |                            # SocialView (organic / paid) + SocialHeader (network,
|   |   |                            # mode, view, status pills) + SocialTrend + PaidTrend +
|   |   |                            # SocialPostsTable + PaidCampaignsTable (links to Ads
|   |   |                            # Manager / Google Ads) + SocialConnectionsDialog +
|   |   |                            # SocialProviderCard (also on Settings → Integrations)
|   |   |-- tickets/                 # TicketsView (orchestrator) · TicketSection ·
|   |   |                            # TicketStatCards · TicketTable · TicketDetailPanel ·
|   |   |                            # TicketThreadDialog · DroppedMailTable +
|   |   |                            # DroppedMailDialog · OrderLinkDialog (add /
|   |   |                            # change / confirm a ticket's order) · LevelChip ·
|   |   |                            # HappinessFace · ReplyEditor (the reply box:
|   |   |                            # bold/italic/underline/lists/links, paste
|   |   |                            # sanitised) + ReplyHtmlView (read-only) ·
|   |   |                            # SnoozeControl (the header's Snooze menu /
|   |   |                            # Unsnooze) + SnoozeBanner + SnoozeChip (row)
|   |   |                            # · ForwardingTag (ForwardingChip on a row,
|   |   |                            # ForwardingBanner under the ticket header)
|   |   |-- agent-test/              # TestChatDialog (the rehearsal, + Reuse this
|   |   |                            # message) · TestComposer · RunTranscript +
|   |   |                            # StepCard (the step cards; StepCard owns the
|   |   |                            # parcel context Verbatim links through) ·
|   |   |                            # RunHistory · IdealAnswer (the memory)
|   |   `-- agent-setup/             # AgentSetup + SetupHeader (orchestrator, mutations) ·
|   |                                # ArticleLibrary (left pane) · ArticleWorkspace +
|   |                                # BrandVoiceWorkspace (right pane) · RichTextEditor ·
|   |                                # WorkspaceHeader EditorFooter CategorySelect
|   |                                # (labels « <subject> FAQ ») · FaqWritingGuide
|   |                                # (« How to write an FAQ »: inline panel in the
|   |                                # editor + FaqGuideDialog popup from SetupHeader) ·
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
|   |   |-- social-types.ts      # isomorphic: the Social panel's + Connections' shapes
|   |   |-- ticket-stats.ts      # isomorphic: summariseTickets + isClosed
|   |   |-- draft-outbound.ts    # what Approve does, worded once for TicketsView +
|   |   |                        # TicketThreadDialog: outbound line, button labels,
|   |   |                        # the hand-off notice, awaiting (grey) / delivered
|   |   |                        # (steps aside), canComposeReply, manual reply lines
|   |   |-- reply-html.ts        # isomorphic: the one import of scripts/lib's
|   |   |                        # reply-html into the browser bundle
|   |   |-- snooze.ts            # isomorphic: isSnoozed, the menu's times, the
|   |   |                        # « at the latest » date (shared working days)
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
|   |       |                    # ticket-priority-service (bulk latest situation +
|   |       |                    # current order/threshold facts for the pure scorer) ·
|   |       |                    # orders-service (orders_list page + one order) ·
|   |       |                    # order-ticket-marks (the ticket ring, per order:
|   |       |                    # Orders + Fulfilment's waiting orders) ·
|   |       |                    # chat-service (Home's chat: wires the loop, writes
|   |       |                    # the chat_* log, owner-only reads) ·
|   |       |                    # dropped-mail-service · knowledge-errors ·
|   |       |                    # integrations-service (Klaviyo status/save/remove) ·
|   |       |                    # social-connections-service (Meta / Google OAuth:
|   |       |                    # start, callback, queue a sync, track, disconnect)
|   |       |                    # + social-return (the fixed return paths) ·
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
|   |                             # query filter) · topic-map-rebuild · social-service
|   |                             # (the Social panel + Marketing's Paid / Social
|   |                             # tabs; Instagram reach read live, <= 30 days)
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
|   |-- sync-social.mjs                  # Meta + Google Ads -> Supabase (after Klaviyo in the nightly;
|   |                                    # the worker runs it for sync_social jobs)
|   |-- probe-meta.mjs                   # read-only: which META_METRICS names Meta answers
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
|       |-- promotion-mechanic.mjs       # what a promotion does, from Shopify's structure (agent + web)
|       |-- shopify-sync-mappers.mjs shop-sync-service.mjs
|       |-- supabase-rest-client.mjs     # REST select/upsert/update/delete/rpc
|       |-- tables.mjs                   # THE SCHEMA CONTRACT: 31 tables, 24 views,
|       |                                # 34 rpcs, and the recurring projections.
|                                # + CHAT_T, STOREFRONT_T, KLAVIYO_T/_RPC (incremental)
|       |                                # Asserted against the DDL by _shared.test
|       |-- order-link.mjs               # what linking an order does to a ticket:
|       |                                # reinvestigationColumns (worker + dashboard),
|       |                                # manualOrderColumns, parseOrderNumber
|       |-- ticket-overrides.mjs         # a person's corrections: field classes
|       |                                # (meaning / gate / workflow), overrideChange,
|       |                                # keepOverrides (categoriser), statusHeld,
|       |                                # activeSituationOverride, versionMaterial (fold)
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
|       |                                # stamp, `markSent` (only after a confirmed
|       |                                # send). Shop-scoped. Cannot send
|       |-- outbound-record.mjs          # THE ONLY WRITER OF `outbound_actions`:
|       |                                # actionFromDraft, actionFromManual, the
|       |                                # conditional state moves, CANCEL_REASONS.
|       |                                # Holds no recipient
|       |-- reply-html.mjs               # THE REPLY HTML: sanitiseReplyHtml (rebuilds
|       |                                # an allowlist), textToReplyHtml ([[marker]]
|       |                                # -> link), replyHtmlToText. Browser + worker
|       |-- company-policies.mjs         # THE ONLY WRITER OF `company_policies`,
|       |                                # `company_policy_versions`, `company_policy_links`:
|       |                                # create / save (version) / link / unlink,
|       |                                # policiesFor, renderPolicy, POLICY_INSTRUCTION
|       |-- snooze-record.mjs            # THE ONLY WRITER OF `ticket_snoozes`: snoozeRow,
|       |                                # snooze / wake (conditional on open) / retarget
|       |                                # (an open auto snooze, in place) / due,
|       |                                # fallbackWakeAt (the shop's delay per party)
|       |-- case-record.mjs              # THE ONLY WRITER OF `cases` + `case_links`:
|       |                                # create, applyDecision (moves a thread through
|       |                                # the ticket record, deletes an emptied case),
|       |                                # refreshTarget(s), conversation (every thread,
|       |                                # email-time order), families (config tables)
|       |-- case-reply-target.mjs        # pure, isomorphic: caseReplyTarget (newest
|       |                                # customer message no later outbound answers, on
|       |                                # any thread) · caseTimeline
|       |-- order-signature.mjs          # what a customer would notice about an
|       |                                # order (fulfilment, payment, cancellation,
|       |                                # parcels): snooze wake + pre-send check
|       |-- snooze-order-wake.mjs        # an order update that moved a parcel, a
|       |                                # refund or a cancellation wakes tickets
|       |                                # snoozed on a partner about that order
|       |-- mail-job-record.mjs          # THE ONLY WRITER OF `mail_jobs`: enqueue /
|       |                                # claim (RPCs) / complete / fail, backoff,
|       |                                # dead after MAIL_JOB_MAX_ATTEMPTS
|       |-- mail-subscription-record.mjs # THE ONLY WRITER OF `mail_subscriptions`;
|       |                                # clientState hashed, compared in constant time
|       |-- graph-notifications.mjs      # what the Graph webhook does (pure-ish)
|       |-- ticket-priority.mjs          # pure read-time queue band + score:
|       |                                # current situation/action window chooses
|       |                                # High/Medium/Low; wait, contacts, level and
|       |                                # awaiting_human sort only inside that band
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
|       |-- company.mjs                  # who the company is: shops.shop_name + the
|       |                                # company_description / logistics_provider_name
|       |                                # parameters; loadCompany, serviceClientOf. Every
|       |                                # runtime text naming the company reads it
|       |-- sync-config.mjs              # CLI + env parsing, loadEnv
|       |-- hash.mjs collections.mjs html-to-text.mjs text-cleaning.mjs
|       |-- faq-format.mjs               # pure: « Format as FAQ » — article -> numbered blocks,
|       |                                # model plan (block indices) -> rebuilt FAQ HTML
|       |-- quoted-reply.mjs             # strips reply chains
|       |-- email-display.mjs            # display-only split of a stored body: new text / quoted / forwarded / signature
|       |-- forwarding-tag.mjs           # pure: the queue's forwarding tag off ticket_routing + ticket_forwards (after first reply / pending / failed / forwarded), and situationForwarding for the Rules rail (planRoute on a situation)
|       |-- shopify-rich-text.mjs cluster-messages.mjs message-audience.mjs
|       |-- sender-patterns.mjs           # email/domain matching, shared by the
|       |                                 # blocklist and the sender directory
|       |-- compliance-audit.mjs shopify-compliance-webhooks.mjs
|       |-- shopify-order-webhooks.mjs   # one order webhook -> re-read that order
|       |                                # through the nightly's own query and
|       |                                # mapper, with a replay guard and an
|       |                                # out-of-order guard; then the snooze wake
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
|       |                                # coverage (measured/partial/missing)
|       |-- marketplaces.mjs             # the shop's marketplaces from sales_channels:
|       |                                # buildMarketplaces / loadMarketplaces -> handles,
|       |                                # platforms, channelFilter, platformOfChannel,
|       |                                # platformOfAnalyticsChannel. No module state
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
|       |-- social-model.mjs             # isomorphic: providers, kinds, publishers,
|       |                                # audience dimensions (70's checks mirror them),
|       |                                # campaignUrl (the one place campaign links are built)
|       |-- social-oauth.mjs             # app credentials from env, signed state,
|       |                                # Meta / Google consent URLs
|       |-- meta-client.mjs              # Graph API (appsecret_proof, rate-limit waits,
|       |                                # a retired metric -> null, 190 -> reconnect)
|       |-- meta-insights.mjs            # pure: META_METRICS (the one name table) +
|       |                                # folders for days, posts, audience, ads
|       |-- google-ads-client.mjs        # REST searchStream, refresh token, developer
|       |                                # token, login-customer-id
|       |-- google-ads-reports.mjs       # pure: GAQL, micros -> money, discovery
|       |-- social-sync.mjs              # connectMeta / connectGoogle (code -> Vault +
|       |                                # accounts) · runSocialSync (never throws;
|       |                                # status on social_connections)
|       |-- social-figures.mjs           # pure: organic / paid totals, series sums,
|       |                                # drivers, never across currencies
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
|   |   |-- mail/                # THE PROVIDER BOUNDARY. mail-provider (the
|   |   |                        # MailProvider contract, CursorExpiredError,
|   |   |                        # replyHtml) · outlook-graph-adapter (graph-client
|   |   |                        # + mapper behind the contract; the poller and the
|   |   |                        # outbound worker see nothing else) ·
|   |   |                        # subscription-manager (Graph subscriptions per
|   |   |                        # folder; no-op without MAIL_WEBHOOK_URL)
|   |   |-- reports/             # sales-report-mail: the monthly sales report,
|   |   |                        # mailed from the support mailbox on the 1st
|   |   |                        # (fetched from /api/reports/sales; recorded in
|   |   |                        # integration_events, one key per shop + month)
|   |   |-- outbound/            # THE ONLY SENDER OF CUSTOMER REPLIES. outbound-rules
|   |   |                        # (preSendCheck, pure) · outbound-store (reads) ·
|   |   |                        # outbound-runner (confirmSentActions after the
|   |   |                        # mailbox read; createAutoSendActions + runOutbound
|   |   |                        # in the `send` stage)
|   |   |-- ingestion/           # graph-client · graph-message-mapper · contact-form ·
|   |   |                        # delta-poller · ticket-writer · message-embedder ·
|   |   |                        # immutable-ids (plan + proof for `ids:translate`) ·
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
|   |   |-- retrieval/           # retrieval-rules (categoriesToSearch: the subject,
|   |   |                        #   its search group — order/delivery/promotions —
|   |   |                        #   then faq + brand_story for every subject) ·
|   |   |                        #   knowledge-retrieval (dense 20
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
|   |   |                        # promotion-{rules,lookup} (lookup.identify: code
|   |   |                        #   or automatic offer, from typed codes + the
|   |   |                        #   decomposer's described offers; the
|   |   |                        #   identifyPromotion tool; lookup.outcome: why
|   |   |                        #   one applied or not, the checkPromotionOutcome
|   |   |                        #   tool, chained after identification) ·
|   |   |                        # promotion-outcome (pure: promotion + order or
|   |   |                        #   abandoned basket -> applied / expired /
|   |   |                        #   outside_destination / not_combinable / ...;
|   |   |                        #   rewardProductIds + rewardStock: the free
|   |   |                        #   item, and whether it is in stock now ->
|   |   |                        #   need promotion_reward_stock) ·
|   |   |                        # stock-by-id (stock of products named by id —
|   |   |                        #   a gift, an order's samples; one reader so
|   |   |                        #   both mean the same "in stock"; samples NOT
|   |   |                        #   excluded) ·
|   |   |                        # abandoned-checkout (the ONLY view of a basket;
|   |   |                        #   live Shopify Admin, never synced; a tool
|   |   |                        #   since 2026-09-16, see checkout_state) ·
|   |   |                        # customer-{context,lookup} ·
|   |   |                        # purchase-{verification,lookup} (three-state
|   |   |                        #   customer check + last-order product match)
|   |   |-- investigation/       # case-file (THE output contract) · investigation-rules ·
|   |   |                        # decompose{,-rules} (tasks + needs, one call) ·
|   |   |                        # case-delta (a follow-up's « Dossier connu »: what
|   |   |                        #   stands, what to refresh, what the message brought;
|   |   |                        #   only when the Case Manager read THIS message) ·
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
|   |   |                        # order-verification · order-resolution-runner
|   |   |                        #   (first message + the customer's own words in
|   |   |                        #   later ones, via laterInboundByTicket; later
|   |   |                        #   numbers count only when they confirm) ·
|   |   |                        # order-identity (the order_identity situation:
|   |   |                        #   no number known/unknown sender, number not
|   |   |                        #   found, other_email[_same_name]) ·
|   |   |                        # (checkOrderPromotion reads the bundle promotions
|   |   |                        #  block: gifts, reductions, samples) ·
|   |   |                        # order-context + order-context-runner
|   |   |                        #   (orderStates: order_state, delivery_state,
|   |   |                        #    delivery_delay_state, dispatch_state,
|   |   |                        #    payment_state, refund_state,
|   |   |                        #    return_eligibility — derived against the
|   |   |                        #    ticket's latest inbound message, not `now`;
|   |   |                        #    the router and a routed run use `now`).
|   |   |                        #   The bundle carries sourceUpdatedAt +
|   |   |                        #   sourceSignature; the context pass rebuilds
|   |   |                        #   a bundle whose order carries another stamp
|   |   |-- routing/             # forward-rules · forwarding-store · forward-runner · destination-router (planRoute + the model chooser)
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
|   |   |                        # health-topic + health-terms (the customer names
|   |   |                        #   a health condition -> never auto-sent) ·
|   |   |                        # draft-runner (+ the derived queue). NO Graph call
|   |   |-- cases/               # the `link` pass (61_cases.sql): case-link-rules
|   |   |                        # (pure: tracking / order_family / unique_match,
|   |   |                        # families) · case-linker-runner (store + runner,
|   |   |                        # candidates ≤ 5, embedding = retrieval only) ·
|   |   |                        # case-linker-model (LINK:<id> | NEW_CASE, off
|   |   |                        # unless CASE_LINKER_ENABLED)
|   |   |-- casework/            # case-fold (the current state of a case, pure) ·
|   |   |                        # case-current-store (the fold pass) ·
|   |   |                        # change-router (pure: what a moved order state
|   |   |                        #   or an elapsed window means for a case we owe
|   |   |                        #   a reply on -- none / redraft / reinvestigate)
|   |   |                        #   + change-router-runner (the `route` pass) ·
|   |   |                        # actors (message -> customer/support/colleague/
|   |   |                        # partner via sender_directory + AGENT_ACTOR_BY_LABEL) ·
|   |   |                        # case-manager (what a new message changed: a
|   |   |                        #   closed relationship, which of OUR questions it
|   |   |                        #   answered, what we promised) · case-manager-rules
|   |   |                        #   (pure: whether the categoriser re-runs, which
|   |   |                        #   situation the case is in, which prior evidence
|   |   |                        #   may be reused, the situation plan, whether the
|   |   |                        #   order changed) · case-runner (the pass; derived
|   |   |                        #   queue, no third flag; createSituationPlanner, which
|   |   |                        #   the investigation reads as planSituation) ·
|   |   |                        # closure (does the customer's last message end
|   |   |                        #   their request? code gate first -- nothing
|   |   |                        #   outstanding in the dossier -- then one cheap
|   |   |                        #   call on the message) ·
|   |   |                        # reconstruct (a finished thread -> where the case
|   |   |                        #   stands: situation from the shop's own library or
|   |   |                        #   none, what we asked, what we promised, what is
|   |   |                        #   still open; the model reads the PROSE and
|   |   |                        #   `backendPosition` reads `resolved_context`, and
|   |   |                        #   the two are never merged). READ ONLY ·
|   |   |                        # snooze-rule (pure: after a SENT reply of ours,
|   |   |                        #   snooze while someone else owes the next step;
|   |   |                        #   wake when the case comes back to us; an auto
|   |   |                        #   snooze follows a switch to another party)
|   |   |-- lifecycle/           # auto-close (28d idle, level 4 and snoozed exempt) ·
|   |   |                        # snooze-wake (the deadline sweep, no model)
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
| `shops` | shop records, environment, app settings, `sync_cursors` (incl. mail delta link), `storefront_url` (Shopify `primaryDomain.url` — where customers go, unlike `shop_domain` which is the *.myshopify.com identity webhooks key on; the base for `/account/login`), `customer_accounts_version` (`CLASSIC` — decides whether a password exists at all), `iana_timezone` (Shopify's `ianaTimezone` — where a day starts on the Insights charts; null until a sync runs the current `mapShop`), `sync_cursors` (mail keys `mail_ingest_delta_link` · `mail_ingest_resume_link` · `mail_sent_delta_link` · `mail_sent_resume_link` · `mail_ingest_cutover_at` (written once) · `mail_id_type` (`immutable` after `ids:translate`), all owned by `ingestion/delta-poller.mjs` `CURSOR_KEYS` — **never written by `mapShop`**), **order retention switch** `order_retention_mode` (`months`/`indefinite`) + `_months` + `_changed_at` + `_reason` — read by `scripts/lib/order-retention.mjs`, never written by `mapShop`; **the VIP rule** `vip_min_spend` + `vip_min_orders` + `vip_window_months` (all or none) + `vip_rule_changed_at` — set on the Customers panel, read by `scripts/lib/vip-rule.mjs` |
| `customers` | lean support snapshot: contact, marketing state, coarse location, lifetime totals, last order, `rfm_group`. No addresses or notes |
| `orders` | identity, links, channel, derived `order_status`, totals, line items, fulfillments, returns, refunds. Contacts hashed, plus `customer_email_masked` (`j***l@orange.fr`) for the one question a hash cannot answer; `tracking_numbers text[]` (GIN) lifted out of fulfillments so a ticket can be resolved from a parcel number; destination coarse; `retention_rule` names only WHY the clock started, `retention_delete_after` carries the period and is **null when kept indefinitely** |
| `products` | snapshots + first-class metafields, `variants` jsonb, `available_stock` |
| `sales_channels` | the shop's marketplaces (migration 60): `platform_key` (URL/filter id, never `all`/`shopify`, never changes), `label`, `handles` (Shopify `sales_channel_handle`s), `analytics_names` (ShopifyQL `sales_channel`, lower case), `position`. Every handle not listed is the shop's own store. Read by the Insights platform filter and services (`getMarketplaces`), the VIP rule, order resolution's anonymous-buyer rule, the chat prompt and `chat.vip_customer_rows()`. Edited on Setup → Sales channels |
| `promotions` | one row per discount, its redeem codes in the `codes` jsonb (empty for automatic); `method` `code`/`automatic`; two local columns the sync never writes, `offerable_in_replies` (codes, default false) and `describable_in_replies` (automatic offers, default true); `rule_snapshot` carries values, not just type names — complete product/collection lists per leg and `destination` (country codes) for shipping discounts |
| `advice_collections` | every Shopify collection (175), plus the team's decision about each: `is_active` (may support answer from it), `axis` (`concern` / `category`), `note`. `product_ids` holds the LIVE products, refreshed for active collections only — see DECISIONS.md § advice from collections |
| `shopify_metaobjects` | shared metaobjects (FAQ, ingredient lists) referenced by products |
| `shopify_content_sources` | content-free catalog of live pages + policies. Feeds Agent Setup only; no FK to knowledge |

### Curated knowledge

Never auto-synced — every row is an explicit import or a hand-written article.

| Table | Holds |
| --- | --- |
| `knowledge_documents` | `content_html` is the editor's truth; `approval_status` independent of Shopify publish `status`; `core_topic` = `brand` or null since migration 56 (the « Core setup » checklist is gone; policies live in `company_policies`); `voice_profile` jsonb = the drafting agent's system prompt on the singleton `brand` row (`roleDescription`, `toneAndVoice`, `responseFramework[]`, `guidelinesAndGuardrails[]`, `closingLine`, `signature`) — all five stored, so the worker reads one source rather than a constant in `web/` |
| `knowledge_chunks` | retrieval chunks + `embedding vector(1536)` HNSW cosine, plus the determinism quadruple; `category` and `product_ids` denormalised from the parent document |

### Support exemplars

The recurring situations, not the answers to them. Same document/chunk mechanics as knowledge, in their own tables so retrieval can never reach a *question* while looking for policy.

| Table | Holds |
| --- | --- |
| `support_exemplars` | canonical question, `exemplar_key` (`P-16`), subject + kind, `requirement_needs text[]` constrained to the `evidence-rules.mjs` vocabulary, `approval_status` (gates the vector), `demand_message_count`, `answer_set` naming which policy family it draws on (`commande` on the 11 order/delivery situations), `never_auto_send` (Rules page switch: its drafts never send themselves, migration 63) |
| `support_exemplar_phrasings` | one row per canonical + real phrasing, each with its own `embedding vector(1536)` and the determinism quadruple. `language` is declared in the document — a variant's annotation may open with a code (`_(en)_`), and **12 of the 168 authored phrasings are real English, Spanish or Dutch mail**. Translations live at `phrasing_index >= 100` (`TRANSLATION_INDEX_BASE + source * 10 + language slot`, from `lib/exemplar-translation.mjs`), out of reach of the importer's pruner; every authored phrasing is translated into each of `fr en es it de` it is not already written in, giving **674 rows for 168 phrasings** (counted 2026-09-21; 842 in all, of which 832 are embedded — the 10 unembedded are soft-deleted `O-11`'s). `match_support_exemplars()` returns one row per **exemplar**, scored by its best phrasing, reports which language matched, and over-fetches `match_count * 64` — above the 60-row ceiling one exemplar's translations can reach |
| `company_policies` | **the company's policies** (migration 55): `policy_key` (fixed once created; the `getPolicy` tool's argument), `name`, `purpose` (the agent reads it to decide whether to fetch), `content` (plain text, may quote `{parameter}` placeholders), `active`, `version` (raised on every change of text), `updated_by`. Not the rulebook: says what the company's rule is, never what happens in a case. Screen: **Agent Setup → Policies** (`PolicyLibrary`) |
| `company_policy_versions` | every version of every policy's text, append-only (`policy_id`, `version`, `content`, `saved_by`) |
| `company_policy_links` | a policy made available to a whole situation (`situation_key`) or one rule (`answer_id`, cascade), exactly one; unique per target. A reference, never a copy. Edited on the rulebook's « Linked policies » blocks |
| `support_answers` | the policy rules. Two axes: `situation_key` (what the customer wants, from the matched exemplar; null = any) and `when_conditions jsonb` = `{need: [findings]}` (what is true). A matched rule carries an `answer_skeleton`, and may `route` to `needs_human`/`needs_customer_input`, hand out **`offer_code`** (a live discount code, picked by an operator from the promotions cleared on `/agent-setup/promotions`; no FK because `promotions` is Shopify-synced, so it is re-checked at drafting time and dropped if it stops being ACTIVE + offerable), and name **`ask text[]`** (`MISSING_FIELDS` keys — a list since 2026-08-30, because a reaction with no product named needs the product *and* the batch number) — **never to `answerable`**, enforced by a check constraint, so a rule can only ever tighten. A rule may also pin **`knowledge_document_id`** — the approved article it answers from, chosen in the editor like a code and carried into the drafting prompt under its own heading, separate from what retrieval found. A real FK (`on delete set null`) unlike `offer_code`, because no sync rewrites these rows; approval is still re-checked at drafting and the article dropped if it is no longer approved. **`tones text[]`** (keys of `scripts/lib/reply-tones.mjs`, check-constrained, `{}` = Brand voice alone) reach the drafting prompt as `## Ton de cette réponse`; unioned across requests. **`link_url` + `link_label`** (https only, both or neither): the prompt gets only the label and asks for one `[[ici]]` marker; the address is copied to `ticket_drafts.reply_link` and put on the marked word wherever a draft is rendered (`TrackingText`, marker rules in `scripts/lib/reply-link.mjs`); checks `link_placed` / `no_orphan_link_marker`. **`checks jsonb`** (`[{owner, need}]`, migration 44): the checks the rule opens on a case, in order; copied onto `exemplar_match.policy.check_sequences` and walked by the fold (`casework/rule-checks.mjs`). One `is_fallback` per `answer_set`. Selected by `answer-selection.mjs` (situation outranks condition depth), which also derives the next need to collect. **119 approved rules, counted 2026-09-21 — 63 in `orders`, 20 in `products`, 8 each in `cosmetovigilance`, `returns` and `promotions`, 6 each in `accounts` and `payments`**, beside 11 drafts (5 `orders`, 5 `products`, 1 `promotions`) that no run can reach, loaded per ticket by `loadAnswers` (approved only) and selected after the tool loop closes. **Live: a matched route tightens the verdict in `buildCaseFile`, never loosens it**, and the selection is recorded on `ticket_investigations.exemplar_match.policy` with `verdict_before_policy` beside it. `answer_skeleton` travels into the drafting prompt as `## Ce que cette réponse doit faire` — read out of `exemplar_match.policy` **by name**, so the diagnostics beside it cannot reach a model. `notify_on` (`refund_recorded`): the rule is the template for the refund notice; its answer set is the notice's scope (migration 72). Set from the rule editor's « Tell the customer when a refund is recorded » box, shown only in a set whose rules read `refund_state` (returns); one rule at a time, locked on the others |

### Agent email workflow

| Table | Holds |
| --- | --- |
| `tickets` | one per Graph `conversationId` — a THREAD. **`case_id`** (not null: the case above the thread, migration 61) + **`case_link_state`** (`pending` until the `link` pass decides, once; `decided` after). Taxonomy axes, `level`, `responsible_team`, `customer_id`, `shopify_order_number`, signals (`language`, `happiness`, `categorisation_confidence`), `resolved_context` jsonb, `duplicate_of_ticket_id` + `duplicate_reason` + `duplicate_detected_at` (**linked, never merged** — set by deterministic rules only; the drafting *and* investigation queues skip a linked ticket. **Since migration 61 a new duplicate joins its original's case instead**, and the existing links were folded into cases), `sender_label` (`internal`/`contractor` when one of OUR addresses opened the thread — stamped at creation from `sender_directory`, skips drafting, investigation still runs), `related_ticket_id` + `related_score` + `related_detected_at` (**no longer written since migration 61**: a similar message is a candidate for the `link` pass instead; the old rows stay, shown only on a thread with no case of several threads), lifecycle + retention timestamps, `overrides` jsonb (a person's corrections per field: `{value, ai_value, set_by, set_at, source}`; the column of an overridden field holds the person's value — migration 48), `fact_drift` jsonb (the change router's record of order states that moved under the latest case file: `{changed, outcome, reason, case_file_at, checked_at}`; hashed into the case version by the fold — migration 69) |
| `ticket_overrides` | **every correction and reset** made in « Edit case »: `field`, `action` (`set` / `cleared`), `value`, `ai_value`, `source`, `set_by` (user id), `set_at`. Append-only audit; the active values are `tickets.overrides` (migration 48) |
| `ticket_snoozes` | **a case hidden from the queue until something happens** (migration 54): `source` (`auto`: the fold, after a message of ours was sent / `manual`), `waiting_for` (customer / colleague / partner / date), `reason` (a person's note), `wake_at` (**never null**: the deadline), `trigger_message_id` + `case_version` (auto), `snoozed_by`, `woke_at` + `wake_reason` (a new message by actor, `deadline`, `manual`, `case_changed`, `resolved`, `order_update`) + `woken_by`. One open row per ticket (`woke_at` null); one automatic snooze per message of ours. Not a ticket status. Written only by `scripts/lib/snooze-record.mjs` |
| `case_current` | **the current state of each case**, one row per ticket, overwritten in place (migration 41). Folded in code by `casework/case-fold.mjs` from the messages (with their actor), the Case Manager readings and the latest case file: `pending_customer_inputs`, `commitments`, `contradictions`, `obligations` (each `{id, owner, need, quote, status, opened_at, cleared_by}`, stage 5; a rule step adds `rule`, `step`, `steps`, and `status: queued` until its turn), `last_actor`, `next_actor` (customer / support / colleague / partner / nobody), `resolved`, `version` (raised only when `material_hash` changes), `folded_at`. No model writes it. `next_actor` sets the ticket's status (5c, `casework/case-status.mjs`; the move is recorded in `tickets.metadata.case_status`). Shown on the ticket's **Case** block |
| `ticket_case_actions` | **a person settled an open check** from the ticket page: `obligation_id`, `action` (`fulfilled` / `cancelled`), `acted_by` (user id), `acted_at`. Append-only; the fold applies the latest per check (migration 43) |
| `cases` | **the customer's problem, above its threads** (migration 61). A ticket inserted without one gets one from the trigger `tickets_open_case`. Several tickets share a `case_id`; nothing is merged. `latest_actionable_inbound_message_id` + `reply_thread_id` (**the reply target**: the newest customer message no later outbound answers, on any thread — `case-reply-target.mjs`; plain uuids, not FKs; recomputed after the fold and on every link; `target_computed_at` null = never computed, which turns the case gates off), `case_key` (`requester hash \| order \| family`), `issue_family`. **No address stored.** Written only by `scripts/lib/case-record.mjs` |
| `case_links` | **every linking decision**, append-only, a new case included: `ticket_id`, `from_case_id` → `to_case_id`, `decision` (`link` / `new_case`), `method` (`first_contact`, `reply_chain`, `identical_body`, `tracking`, `order_family`, `unique_match`, `model`, `model_off`, `no_candidates`, `excluded_sender`, `backfill`), `candidates` (`[{case_id, reasons}]`), `model` + `model_answer` |
| `issue_family_members` · `issue_family_transitions` | **configuration**, per shop: subject or situation → family (DELIVERY, ORDER_CHANGE, REFUND_RETURN, PAYMENT, PROMOTION, PRODUCT, ACCOUNT, COSMETOVIGILANCE), and which family may continue as which (directed; a family is always compatible with itself). Seeded by migration 61; read by `case-link-rules.mjs` |
| `ticket_messages` | one per Graph message. **`actor`** (customer / support / colleague / partner, migration 41) is stamped at arrival from the direction and the sender directory through `AGENT_ACTOR_BY_LABEL`, and moves with a re-filed direction. Envelope, cleaned `body_text`, sanitised payload, `embedding vector(1536)`, the RFC 5322 reply chain (`in_reply_to` + `reference_ids[]`, captured for deduplication — only those two headers are kept, the rest is `Received` chains carrying relay IPs), and `attachments jsonb` -- part METADATA only (name, contentType, size, isInline), never bytes. **NULL means never fetched**, `[]` means fetched and empty |
| `ticket_investigations` | **the case file**: `established` / `unverified` / `missing` / `do_not_claim` (four separate columns), `handoff`, `context_ref`, `dropped_claims`, `evidence_gaps` (what the ticket required vs what was obtained, each entry carrying the `finding` and the `details` naming WHICH product or code it is about — diagnostic, does not move the verdict), `exemplar_match` (which recurring situation this is; recorded, never acted on), `candidate_order` (**internal**: the customer's last order as a FULL bundle, same shape and builder as `resolved_context`, fetched in the order tool's unresolved branch so it can never sit beside a confirmed order. Rendered in the human brief and the dashboard under Last order headings, **never** in the drafting prompt). `reaction_report` (**cosmetovigilance only, nullable**: the product the customer BLAMES, their words for it, and the symptoms — attribution, never causation. Lifted out of the ledger by `reactionReportFrom` because `tool_calls` drops every tool's `data`. On the detail projection, deliberately **not** on the drafting one). `findings_trace` (**nullable**: the derived findings after each tool call, in call order — one entry per `tool_calls` entry, `{call, tool, findings}`, scored over the whole need vocabulary. The replay tape: `tool_calls` drops every tool's `data` and 8 of the finding derivations read it, so a replay over `tool_calls` alone would score those as absent and stop earlier. NULL means the row predates the column and can never be filled; `[]` means the run made no calls. On no projection at all). `recommendations` (**what `recommendProducts` put forward, as the tool rendered it** — one entry per type of care, with the product lines a reply quotes. Written by code off the tool ledger like `knowledge`, never by the model, and printed FIRST in the drafting prompt, before `## Établi`; migration 32). `unique(shop_id, trigger_message_id)` |
| `ticket_drafts` | **what the agent would send**: `body_text` (the model's, never edited) beside `approved_body_text` (a reviewer's rewrite), `source_verdict` (all three — `needs_human` gets an acknowledgement), `disposition` (`terminal` = sending closes the ticket \| `intermediary` = somebody still owes an answer; derived from the verdict + the case file's `handoff`, never model-chosen, and enforced by two check constraints), `level` (1–3; level 4 is never drafted), `status` (the human decision) kept apart from `checks_passed` (the machine outcome), `auto_send_eligible` (four conditions: level 1–2, customer not visibly unhappy, checks passed, verdict not `needs_human` — plus subject holds: `cosmetovigilance` never qualifying unless **both** `DRAFT_ONLY` and `DRAFT_ONLY_COSMETOVIGILANCE` are false, a customer naming a health condition, a situation marked `never_auto_send`), `auto_send_blockers` (every reason it is not, `[{ reason, detail }]`, migration 63; the subject holds are shown on the draft), `prompt_inputs`, `review_sent_at`, `approved_body_html` (a formatted rewrite as sanitised HTML; `approved_body_text` is its text, migration 52). **One row per case version** (migration 45): `unique(shop_id, ticket_id, case_version)`, with `trigger_event_id` (the message that produced the version) and `stale_reason` (`case_changed` \| `superseded_by_outbound`, present exactly when `status = stale`; set by the fold, never decided on, never mailed). `trigger_message_id` is indexed, no longer the key; rows from before carry no version. **Holds no recipient and cannot send.** Owned by `scripts/lib/draft-record.mjs`. `purpose`: `reply`, or `refund_notice` (a message of ours, unasked; never auto-sent — migration 72) |
| `outbound_actions` | **a reply we decided to send** (migration 47): `draft_id` (null exactly for a `manual` reply, migration 52), `case_version`, `mode` (`human_approved` \| `auto_send` \| `manual`: a person's own reply from « Create draft », `action_type` `manual_reply`, keyed on `client_key`, not on the version), `reply_to_message_id` (the recipient is its `from_email`, read at send time; **no address stored**), `body_text` (copied) + `body_html` (what is sent, sanitised by `reply-html.mjs`; the draft's `[[marker]]` is its link), `state` approved → draft_created → send_requested → sent_confirmed, or cancelled (`cancel_reason`) / failed, `provider_draft_id` (immutable: equals the Sent Items copy's `graph_message_id`), `provider_internet_message_id`, `sent_message_id`. **One live or sent action per `(shop_id, ticket_id, case_version, action_type)`** (unique index ignoring cancelled/failed). Owned by `scripts/lib/outbound-record.mjs`; carried out only by `agent/src/outbound/outbound-runner.mjs` |
| `ticket_draft_edits` | **append-only record of every human rewrite**, each carrying `model_body_text` — the agent's text as it stood when the edit was made, COPIED rather than referenced, because `ticket_drafts.body_text` is replaced by the next drafting run. `source` (dashboard / mailbox), `edited_by` (null until auth exists). Capture for Phase 7 memory; nothing reads it yet |
| `email_blocklist` | per-shop sender email/domain rules + hit counts |
| `sender_directory` | per-shop sender email/domain → `label` (internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other) + free-text `note`. Read into the case file as context and by `cluster:tickets` to tell customer demand from our own mail. Replaces `INTERNAL_EMAIL_DOMAINS`. Rows are exceptions; an unlisted sender is a consumer |
| `spam_audit` | one row per gate decision. `outcome`, `decided_by`, `reason`, `label`, `model`, `failed_open`, sender, subject, and on a block `body_text` + `body_captured_at` + `body_expires_at` |
| `category_forwarding` | the old per-category address book. **Nothing reads it since 2026-09-29** (superseded by `forwarding_destinations`); left in place, to be dropped |
| `forwarding_destinations` | who receives mail the contact team does not own (migration 49): `label`, `forward_email`, `active_since` (**the destination's switch**: null = off, otherwise when it was switched on; it receives only mail received since then; needs an address — migration 51), `description` (the business's words; what the router reads), `categories`, `request_kinds` (empty = any), `match_description` (the agent checks even a lone destination), `timing` (`immediate` / `after_first_reply`), `acknowledge`, `public_name_fr/en` + `ack_note_fr/en` (the acknowledgement's wording), `position`. Validated by `scripts/lib/forwarding-destinations.mjs` |
| `forwarding_settings` | one row per shop: `forward_since` (**the master switch**: null forwards nothing; otherwise only inbound mail received since then — migration 50), `ack_enabled` (default false) and the FR/EN acknowledgement templates (null = the defaults in `forwarding-destinations.mjs`) |
| `agent_models` | the model an agent runs on, chosen in Settings (migration 53): `(shop_id, agent)` key, `agent` ∈ spam/categorise/situation/decompose/investigate/draft/chat, `model`, `updated_by`. **Overrides the env var**; no row = the env decides. Read by `scripts/lib/agent-models.mjs` — the worker every poll (`refreshModels` in `agent/src/index.mjs` rebuilds the model clients on a change), the test chat and the management chat (`currentChatModel`) |
| `ticket_routing` | the router's decision per ticket (migration 50): `outcome` forward/keep, `method` fixed/model, `destination_id` + `destination_label`, `reason`, `model`, the `category`/`request_kind` it was taken on (re-taken when they change); and the once-per-ticket acknowledgement: `ack_state` requested/sent/failed/skipped, `ack_at`, `ack_error`, `ack_attempts` |
| `ticket_forwards` | attempt ledger, `unique(ticket_message_id)`, `sent`/`failed` + attempt counter, snapshots `category`, `forward_email`, `destination_label` |
| `mail_jobs` | **the durable queue** (migration 46): `sync_mailbox` (a change notification asking for a folder read) , `send_outbound` (the attempts of one outbound action) and `sync_social` (a Meta / Google Ads sync asked for by Connect or Sync now; migration 70). `state` queued/running/done/dead, `retry_count`, `last_error`, `last_attempt_at`, `next_attempt_at`, `locked_until` (lease). Unique `dedupe_key` among **queued** rows only. RPCs `enqueue_mail_job()` + `claim_mail_jobs()` (SKIP LOCKED; an expired lease is reclaimable and counts as an attempt). Case processing is not a kind. Owned by `scripts/lib/mail-job-record.mjs` |
| `mail_subscriptions` | one Graph change-notification subscription per shop + provider + folder: `subscription_id`, `client_state_hash` (never the secret), `expires_at`, `needs_renewal`, `last_error`. Owned by `scripts/lib/mail-subscription-record.mjs` |
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
| `case_message_counts` | messages per case over every live thread (`thread_count`, `inbound_count`, latest inbound/outbound, `last_activity_at`) | — (61) |
| `case_facts` | **one row per case**: the earliest thread's subject, the highest level and worst mood, a folded status, the lead thread, first reply across threads (`reply_hours`). Read by the queue and the Insights support figures | counting tickets for support volume (61) |
| `ticket_queue` | the dashboard row: ticket + customer + count + `requester_email` (the address that opened the thread, so `sender_directory` can be asked whether it is a customer), soft-deleted excluded. Since 61 also the case: `case_id`, `is_case_lead`, `case_thread_count`, `case_message_count`, `case_inbound_count`, `case_waiting_since`, `case_level`, `case_status` (the queue shows lead rows and ranks them on these) | `TICKET_LIST_SELECT` + the count join, in `tickets-service.ts` |
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
`insights_inventory_exceptions` (active products out of stock, low on cover, or
under a unit floor; stock now, rate over a window) and `insights_collection_sales` (per collection, or
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

### Klaviyo

Migration 39. Named in `KLAVIYO_T` / `KLAVIYO_RPC`, not `T` / `RPC`. See `DECISIONS.md § Insights → Klaviyo`.

| Object | Holds |
| --- | --- |
| `klaviyo_connections` | one row per shop: `secret_id` (the key, in **`vault.secrets`**), `key_hint` (last 4), `conversion_metric_id` (Placed Order), `saved_at` / `saved_by`, `last_sync_at` / `_status` / `_error` |
| `klaviyo_flow_days` | per shop, flow and day (Klaviyo account clock): recipients, delivered, opens_unique, clicks_unique, conversions, conversion_value — counts only. Last 59 days rewritten nightly |
| `klaviyo_campaigns` | per shop and campaign: name, channel, `send_time`, the same counts, for the campaign as a whole |
| `klaviyo_save_key` / `_read_key` / `_clear_key` | security definer, `search_path ''`, **service_role only** — the only way to touch the key |
| `insights_klaviyo_messages(p_shop, p_from, p_to, p_tz)` | flows summed over their days + campaigns by send time, in the Insights range convention |

### Social and paid media

Migration 70. Named in `SOCIAL_T` / `SOCIAL_RPC`. See `DECISIONS.md § Insights → Social and paid`.

| Object | Holds |
| --- | --- |
| `social_connections` | per shop and provider (`meta` / `google`): `secret_id` (the OAuth token, in **`vault.secrets`**), `token_expires_at`, `scopes`, `conversion_action` (Meta; null = `omni_purchase`), `last_sync_at` / `_status` (`ok` · `failed` · `needs_reconnect`) / `_error` |
| `social_accounts` | what a connection sees: `kind` (`instagram` · `facebook` · `meta_ads` · `google_ads`), `external_id`, name, handle, currency, `login_customer_id` (Google manager), `enabled` (the team's choice; reads skip disabled) |
| `social_account_days` | per organic account and day: followers (that day's count), follows, unfollows, views, engagement, profile visits, link taps, posts — additive counts only, null = not measured |
| `social_posts` | per post: published_at, type, 140-char caption, permalink, thumbnail, lifetime views / reach / likes / comments / shares / saves / follows / engagement |
| `social_audience` | per Instagram account and capture day: follower counts by gender / age / country / city |
| `ad_days` | per ad account, day and publisher: spend, impressions, clicks, conversions, conversion value, currency |
| `ad_campaigns` · `ad_campaign_days` | migration 71 (`CAMPAIGN_T`): per campaign name / status / objective, and the same counts per campaign and day. Read by `insights_paid_campaigns` (the Paid view's campaign table) |
| `social_save_token` / `_read_token` / `_clear_token` | security definer, `search_path ''`, **service_role only** |
| `insights_social_series` · `_followers` · `_posts` · `_post_totals` · `_audience` · `insights_paid_series` | the panel's reads; wall-clock range, enabled accounts only |

### Compliance and audit

| Table | Holds |
| --- | --- |
| `integration_events` | metadata-only sync/webhook log, idempotent on `event_key` |
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
| `04_support.sql` | `tickets`, `ticket_messages`, `email_blocklist`, `sender_directory`, `spam_audit`, `ticket_investigations`, `category_forwarding`, `ticket_forwards`, `forwarding_destinations`, `forwarding_settings`, `ticket_routing`, `categorisation_review`, the three views | 01, 02 |
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
| `40_customer_questions.sql` | widens `support_answers_ask_check` by five `MISSING_FIELDS` keys (postal_address, preferred_remedy, receipt_confirmation, skin_type, skin_concern). No data. Applied 2026-09-26 | 05 |
| `48_ticket_overrides.sql` | `tickets.overrides` + its check, `ticket_overrides`, `ticket_queue` gains `overrides` last (copied from 04). No data. Applied 2026-09-29 | 04 |
| `49_forwarding_destinations.sql` | `forwarding_destinations`, `forwarding_settings` (copied from 04). No data. Applied 2026-09-29 | 04 |
| `50_forwarding_routing.sql` | `forwarding_settings.forward_since`, `ticket_forwards.destination_label`, `ticket_routing` (copied from 04). No data. Applied 2026-09-29 | 04, 49 |
| `51_destination_switch.sql` | `forwarding_destinations.active_since` + its needs-an-address check (copied from 04); switches on the destinations that had an address. Applied 2026-09-29 | 49 |
| `60_sales_channels.sql` | `sales_channels` (copied from 02); `chat.vip_customer_rows()` reads its handles instead of a literal; the chat comments naming Amazon/Yves Rocher made generic. No data (this shop's two rows were inserted separately). Applied 2026-10-02 | 02, 17, 21 |
| `61_cases.sql` | `cases`, `case_links`, `issue_family_members` + `issue_family_transitions` (seeded per shop), `tickets.case_id` + `case_link_state`; **data**: one case per ticket (its own id), duplicates joined to their original's case (chains to the root, `backfill` rows), every ticket `decided`; `case_link` in the `agent_models` and `llm_usage` checks; `case_message_counts`, `case_facts`, `ticket_queue` (case columns appended), `customer_ticket_facts` + the three `insights_support_*` functions on `case_facts` (copied from 04/06), `chat.tickets.case_id`; trigger `tickets_open_case` (a ticket inserted without a case opens one). **Applied 2026-10-02**: 1015 tickets → 1003 cases, 12 `backfill` links (9 duplicates + 3 mutual pairs); then `npm run cases:targets` (agent/) | 04, 06, 17, 53 |
| `64_casework_usage_pass.sql` | widens `llm_usage_pass_check` by `casework` and `closure` (copied from 06), which the sink was recording as `other`. No data. **Applied 2026-10-03** — before the worker that emits them | 06 |
| `62_case_lead.sql` | `case_facts` re-stated, copied from 04: with nothing owed, a case's lead is its most recently active thread **still live**, not just the most recent. **Applied 2026-10-02** | 61 |
| `59_order_identity_situations.sql` | data only: rules whose `when_conditions.order_identity` names `none` also name its five replacements (`none` kept so old and new code agree). 16 rules. Applied 2026-10-02 | 05 |
| `65_inventory_stock_floor.sql` | drops 35's five-argument `insights_inventory_exceptions()` and recreates it with `p_max_stock_units`, so the stock card also lists every active product under the unit floor (`INVENTORY_MIN_STOCK_UNITS`, 50) whatever its cover. Copied from 06. No table, no data. **Applied 2026-10-04** | 01, 02, 06 |
| `72_refund_notice.sql` | `support_answers.notify_on` (`refund_recorded`; marks a notice template) + `ticket_drafts.purpose` (`reply` / `refund_notice`). Copied from 05 / 07. No data. **Applied 2026-10-05** | 05, 07 |
| `71_ad_campaigns.sql` | `ad_campaigns` + `ad_campaign_days` (`CAMPAIGN_T`) and `insights_paid_campaigns()` (`CAMPAIGN_RPC`). No data. **Applied 2026-10-05** | 70 |
| `70_social.sql` | the six social tables (`SOCIAL_T`), the Vault token functions and six reads (`SOCIAL_RPC`), and `mail_jobs_kind_check` widened to `sync_social` (copied from 04 / 46). No data. **Applied 2026-10-05** | 01, 46 |
| `69_fact_drift.sql` | `tickets.fact_drift` jsonb (null until something moves; object check) + `outbound_actions.cancel_reason` comment gains `facts_pending`. Copied from 04 / 07. No data. **Applied 2026-10-04** | 04, 47 |
| `68_order_gift_stock_need.sql` | widens `support_exemplars.requirement_needs` by `order_gift_stock` (whether the order's gift lines are in stock now). Copied from 05; head of the needs check since. No data. Applied 2026-10-04 | 05, 67 |
| `67_sample_stock_need.sql` | widens `support_exemplars.requirement_needs` by `sample_stock` (whether the order's samples are in stock now). Copied from 05; head of the needs check until 68. No data. Applied 2026-10-04 | 05, 66 |
| `66_promotion_reward_stock_need.sql` | widens `support_exemplars.requirement_needs` by `promotion_reward_stock` (whether the free item is in stock now). Copied from 05; head of the needs check until 67. No data. Applied 2026-10-04 | 05, 58 |
| `58_promotion_outcome_need.sql` | widens `support_exemplars.requirement_needs` by `promotion_outcome` (why a promotion applied or not). Copied from 05; head of the needs check until 66. No data. Applied 2026-10-01 | 05, 56 |
| `57_describable_offers.sql` | adds `promotions.describable_in_replies` (default true), the automatic-offer counterpart of `offerable_in_replies`. Copied from 02. No data. Applied 2026-10-01 | 02 |
| `58_faq_articles.sql` | narrows `knowledge_documents_category_check`: `other` is no longer an article category (a ticket subject only); any article/chunk under it moves to `faq`. Copied from 03. None moved. Applied 2026-10-01 | 03 |
| `57_situation_choose_rule.sql` | `support_exemplars.choose_rule` (copied from 05): when to pick a situation and when not to, shown to the situation chooser. No data in the migration; the 40 rules were written from `Email-Example-Queries.md` after it. Applied 2026-10-02 | 05 |
| `56_policy_search_retired.sql` | Removes `policy_answer` from `support_exemplars.requirement_needs` (data: 20 situations) and from its check, adds `policy_attached`; narrows `knowledge_documents.core_topic` to `brand`. Copied from 03 and 05. Applied 2026-10-01 | 03, 05, 33 |
| `55_company_policies.sql` | `company_policies`, `company_policy_versions`, `company_policy_links` (copied from 05) + `ticket_investigations.company_policies`. No data (the library starts empty). Applied 2026-09-30 | 04, 05 |
| `54_ticket_snoozes.sql` | `ticket_snoozes` (copied from 04). No data. Applied 2026-09-30 | 04 |
| `53_agent_models.sql` | `agent_models` (copied from 04). No data. Applied 2026-09-30 | 01 |
| `52_manual_replies.sql` | `outbound_actions`: `draft_id` nullable, `client_key`, `body_html`; `manual` mode + `manual_reply` type + their shape check; the version key narrowed to `reply`, `client_key` unique. `ticket_drafts.approved_body_html`. Copied from 07. No data. Applied 2026-09-30 | 07, 47 |
| `47_outbound_actions.sql` | `outbound_actions` (copied from 07) and the new `ticket_drafts.status` comment. No data. Applied 2026-09-28 | 04, 07, 45 |
| `46_mail_jobs.sql` | `mail_jobs`, `enqueue_mail_job()`, `claim_mail_jobs()`, `mail_subscriptions` (copied from 04). No data. Applied 2026-09-28 | 01 |
| `45_draft_versions.sql` | `ticket_drafts`: `case_version`, `trigger_event_id`, `stale_reason`, `stale` status, key `(shop_id, ticket_id, case_version)` (the old key dropped by its columns). Copied from 07. No data. Applied 2026-09-28 | 07 |
| `44_rule_checks.sql` | `support_answers.checks` + its array check (copied from 05). No data. Applied 2026-09-27 | 05 |
| `43_case_actions.sql` | `ticket_case_actions` (copied from 04). No data. Applied 2026-09-27 | 04 |
| `42_case_state_every_message.sql` | `ticket_case_state`: nullable `case_relationship` + `actor`, `effect`, `asked`, `obligations_opened`, `obligations_cleared` with checks (copied from 04). No data. Applied 2026-09-27 | 04, 34 |
| `41_case_current.sql` | `ticket_messages.actor` + its check, and the `case_current` table (copied from 04). No data. Applied 2026-09-26 | 04 |
| `39_klaviyo.sql` | the three Klaviyo tables (`KLAVIYO_T`), the Vault key functions and `insights_klaviyo_messages()` (`KLAVIYO_RPC`). No data. Applied 2026-09-25 | 01 |
| `38_storefront_months.sql` | the `storefront_session_months` table (named in `STOREFRONT_T`, not `T`). Applied 2026-09-24 and backfilled (36 months) | 01 |
| `37_collection_handles.sql` | drops 36's seven-argument `insights_collection_sales()` and recreates it with `p_handles`, so the Collection mix card reports the six ranges rather than all 176 collections. Copied byte-for-byte from 06 (its test asserts it); supersedes 36. Applied 2026-09-23 | 01, 02, 06, 27, 36 |
| `36_collection_sales.sql` | adds `insights_collection_sales()`: per collection for a range, on `insights_product_sales` line rules, plus a null-id row for paid lines in no reported collection. Superseded by 37. Applied 2026-09-23 | 01, 02, 06, 27 |
| `35_sales_overview.sql` | adds `insights_sales_overview()`, `insights_promotions()` and `insights_inventory_exceptions()` for Overview, Marketing & funnel, the stock card and the monthly report, copied byte-for-byte from 06 (its test asserts it). No table, no data. Applied 2026-09-22 | 01, 02, 06 |
| `32_investigation_recommendations.sql` | adds `ticket_investigations.recommendations jsonb` — the shop's own product list, carried verbatim so the drafting stage reads what the tool said rather than a paraphrase of it. Idempotent, no data written. Applied 2026-09-20 | 04 |
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
- `POST knowledge/format` — « Format as FAQ » (the old Optimize button): `{title, content}` in, the content rearranged by `scripts/lib/faq-format.mjs` out, plus counts (questions, without rewordings, unplaced). Stores nothing; the editor shows it unsaved. Model `KNOWLEDGE_FORMAT_MODEL`, default `gpt-6-luna`; usage logged to `llm_usage` as pass `other`. Hidden on the brand voice and on Brand story articles

**Parameters** (`/agent-setup/parameters` → `components/agent-setup/ParameterList`, over `lib/server/parameters-service.ts`). One number held once, so a rule comparing against it, an article stating it and a skeleton quoting it cannot disagree — the failure that argued for it was live: two approved articles gave two different returns windows. **The catalogue is code** (`scripts/lib/parameters.mjs`) and only the values are data, so the screen offers exactly the parameters something reads; rows are created on demand. **Every value starts null**, which is a real state each reader handles. No approval step, unlike a rule: a parameter is a fact rather than a behaviour. Two of them are a pair: `france_delivery_days` and `abroad_delivery_days` are the same window for different destinations, picked on the order's `country_code`, and either one unset leaves `delivery_delay_state` `unknown` for the destinations it covers rather than for all of them — which is why `POWERED_BY` in `policy-service.ts` maps a state to a LIST of parameters and the editor names which is missing.

- `GET|PUT parameters` — every parameter set or not · set one, or clear it with a null

**Forwarding** (`/agent-setup/forwarding` → `components/agent-setup/ForwardingSettings`). A **master switch** first (« Turn on forwarding » sets `forward_since` to now; off clears it; `PUT /api/forwarding/settings {forwardingOn}`), then three parts: **Where each category goes** (derived by `routingModeByCategory`: stays / fixed → one destination / agent decides between several, or keeps it), **Destinations** (a card each with its own on/off switch — `PATCH /api/forwarding/destinations/[id] {on}` → `setDestinationOn`; Edit opens the form, one Save per destination, Delete asks first; a new destination starts off), and **Acknowledgement to the sender** (on/off, FR/EN templates, a live preview per destination and language through `renderAcknowledgement`). Over `forwarding-service.ts`: `GET /api/forwarding`, `POST /api/forwarding/destinations`, `PUT|DELETE /api/forwarding/destinations/[id]`, `PUT /api/forwarding/settings`. Validation is `scripts/lib/forwarding-destinations.mjs`, shared with the worker. The acknowledgement signs with `shops.shop_name` (`getShop().shopName`). Moved here from `/settings` 2026-09-15; destinations replaced the per-category boxes 2026-09-29.

**Sales channels** (`/agent-setup/sales-channels` → `components/agent-setup/SalesChannelList`). `GET|POST /api/sales-channels`, `PATCH|DELETE /api/sales-channels/[id]` over `sales-channels-service.ts`, each returning the whole view: the `sales_channels` rows and every handle the orders carry (`insights_orders_by_channel` over all time) with Shopify's label, an order count and what it counts as. A handle belongs to one marketplace at most; the key is derived from the name and never changes. The shop name, storefront URL and marketplace names reach client components through `web/lib/shop-context.tsx` (`ShopProvider`, filled by the root layout); `useT` resolves `{store}` and `{marketplaces}` in any string.

**Senders** (`/agent-setup/senders` → `components/agent-setup/SenderDirectory`). `GET|POST /api/senders`, `PATCH|DELETE /api/senders/[id]` over `senders-service.ts`, each returning the whole directory: rows of `sender_directory` (address or domain, label, note) with the actor each label maps to (`AGENT_ACTOR_BY_LABEL`), whether the brand has an operations partner (`obligationOwners`), and the support mailbox's domain. A label change applies to new mail only.

**Navigation is a tab bar** in `agent-setup/layout.tsx` — Knowledge · Rules · Parameters · Promotions · Recommendations · Forwarding, places of equal standing. Matched exactly rather than by prefix, since `/agent-setup` is a prefix of the other two.

**Which product an article is about** (`ProductAttachSelect` in the article workspace, over `PATCH /api/knowledge/articles/[id]`; the catalogue comes from the existing `/api/recommendations`). Writes `knowledge_documents.product_ids`, denormalised onto `knowledge_chunks` by `buildKnowledgeChunks` the same way `category` is, and returned by both retrieval RPCs. `agent/src/retrieval/product-from-knowledge.mjs` turns a retrieved chunk's tag into an identity, and `evidence-rules.mjs` reads it from one helper (`productFromArticles`) shared by `product_identity`'s `satisfiedBy` and its `derive`, so the need and the finding cannot disagree. Deliberately NOT in `content_hash`: retagging rewrites chunk rows without re-embedding a word.

> `category` and `product_ids` answer different questions — the first decides **when** an article is searched (`categoriesToSearch` = the ticket's subject, the other two of order/delivery/promotions when it is one of them, plus `faq`/`brand_story`), the second decides **what it resolves to** once found. Attaching a product does not make an article reachable from another subject.

**What we can advise on** (`/agent-setup/collections` → `components/agent-setup/CollectionList`, over `lib/server/collections-service.ts`, `/api/collections` and `/api/collections/[id]`). All 175 Shopify collections, searchable, with a switch and an axis (`concern` / `category`) per row writing `advice_collections.is_active` / `axis` / `note` — the three columns on that synced table this app owns. A **Sync from Shopify** button (`POST /api/collections/sync`) runs the collections sync on demand and returns the refreshed list — it cannot switch anything on. **Activation is its own endpoint** (`PATCH`), separate from the axis and note (`PUT`), the same split `setRuleApproval` keeps: switching a collection on is what lets its products reach a customer. **An axis is required to go live and cannot be cleared while live** — a `category` is a group of products the answer offers and a `concern` ranks products inside those groups, so a collection with neither cannot be placed; refused from both directions. Nothing is active by default: a product sits in 18–30 collections, most of them seasonal (`Black Friday` 92 products) or diagnostic-quiz output.

**What we suggest, by skin type** (`/agent-setup/recommendations` → `components/agent-setup/RecommendationList`, over `lib/server/recommendations-service.ts` and `/api/recommendations`). Writes `products.recommended_for_concerns` — the one column on that synced table this app owns. Curated rather than derived from the tags: `peaux sensibles` is on 52 of 90 sellable products and « tous les types de peaux » on 52 more, so a tag query answers "these 64", which is not a recommendation. The tag match is shown as a starting hint, and the list is searchable over title AND description (90 rows, and half these products are looked for by what they do rather than by the name on the box). `agent/src/retrieval/product-concerns.mjs` holds the closed concern vocabulary (catalogue `tags` ↔ customer `cues`) and `unclassifiedSkinTags` reports skin-family tags belonging to no concern after a product sync. **Since 2026-09-16 the tabs are the five skin concerns AND the live collections**, both valid in the same column: a concern's ticks ARE the answer (the agent reads the concern out of the message), where a collection's only reorder an answer the intersection already found — so an untouched collection is no preference rather than a gap. `tickableKeys` refuses anything outside the two vocabularies.

**Codes support may offer** (`/agent-setup/promotions` → `components/agent-setup/PromotionList`, over `lib/server/promotions-service.ts` and `/api/promotions`). Every ACTIVE code discount from Shopify, with one switch per row writing `promotions.offerable_in_replies` — the only column on that synced table this app owns, and the only thing on the screen that is editable. `?offerable=true` is what the drafting screen fetches, so partner rates and the 100%-off product code never reach a reply surface.

**Automatic offers**, below it on the same page (`components/agent-setup/AutomaticOfferList`, over `/api/promotions/automatic`). Every ACTIVE automatic discount, labelled by `scripts/lib/promotion-mechanic.mjs` (free shipping · gift · multi-buy · order/product discount · app) from Shopify's structure, never the title. One switch per row writing `promotions.describable_in_replies`; on by default, so the operator only ever switches one off. The agent's `listActivePromotions` skips the ones switched off and marks the rest « offre automatique, sans code ».

**Company policies** (`/agent-setup/policies` → `components/agent-setup/PolicyLibrary`, over `lib/server/company-policy-service.ts` and `/api/company-policies`). The tab before Rules. A list (name, key, version, link count) and an editor: name, key (on create only), when to use it, text (parameter chips insert `{key}`), active; « Used by » lists the situations and rules linked. Links are made on the rulebook: a **Linked policies** block (`LinkedPolicies`) under the situation's header (the whole situation) and under the selected rule's inspector (that rule; its situation's policies shown greyed as inherited), and the same block in `RuleEditor`'s Reply card beside the article picker (an existing rule's links save at once; a new rule's picks are held and linked by `RuleBook` right after its first save). At runtime a situation's policies are read as opening moves, a selected rule's are attached after selection, and any other active policy is one `getPolicy(policy_key)` call away for the model; drafting reads each one's current text under `## Politiques de l'entreprise`. The case file records which (`ticket_investigations.company_policies`), shown on the ticket's Situation & rule block.

**The rulebook** (`/agent-setup/rules` → `components/agent-setup/RuleBook` + `RuleEditor`, over `lib/server/policy-service.ts`; stored rows cross into its UI contract through `policy-rule-mapper.mjs`, reusing the agent's `answerFromRow` normalization). Per-situation workflow view: left rail selects answer set and situation, center canvas projects the existing `support_answers` rows into evidence decisions and branches, right inspector summarises the selected outcome. **Editing is a slide-in panel** (`RuleEditor`, over the canvas): scope (answer set, situation) comes from where it was opened and changes only behind a disclosure; cards When · Then · Reply (guidance, tones, **checks this rule opens** — ordered owner + need steps, owners from `checkOwnersFor` in `senders-service.ts` — link, code, article, linked policies); opened from a branch a general rule already answers, it offers "Use a general rule" (lists the set's general rules, drafts marked; the pick is stored per branch in the browser by `lib/general-rule-choices.ts` and marks that branch "General rule applies", with a note where the agent would not use it — never sent to the backend). Each situation canvas's General rules section has "Create a general rule" (situation null, conditions narrowed on the situation it was started from via `contextSituationKey`). A branch no situation rule answers but a live general rule does reads "General rule applies" rather than a gap (`generalRulesCovering` in `lib/rule-labels.ts`, which also holds the English display names of the shared rules — keys unchanged); a collapsible "How a rule is chosen" recap; conditions open on the situation's needs (`requirementNeeds` from `listSituations`, the needs its other rules name, this rule's own, plus prerequisites) with "show all" one click away. **The decisions come from the situation's OWN rules**; the set's situation-less rules keep a separate lane below, because they can never win where a situation-keyed rule matches. The canvas is a projection only: runtime still uses `answer-selection.mjs` (situation outranks condition depth, priority breaks ties), not first-match visual order. Reads and writes `support_answers`. The editor's every choice — which states a condition may name, where a rule may route, what it may ask for — is derived from `evidence-rules.mjs` and `case-file.mjs` at request time, so the dashboard can never offer a state the agent cannot score. The vocabulary also carries each need's `requires` list from `needRequires()`, so the UI can show prerequisites such as `order_identity` before dependent order states. Needs with no findings are excluded rather than shown empty. Validation is `normaliseConditions` + `auditAnswerSet`, the agent's own functions, run before the row exists. **A situation whose category is forwarded is tagged** in the rail (« To Cosmétovigilance after 1st reply », « Agent picks: … »), with the sentence under the canvas title: `listSituations` attaches `forwarding` from `situationForwarding` (`scripts/lib/forwarding-tag.mjs`), which runs the worker's own `planRoute` on the situation's category and kind, and only while the master switch is on.

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

`web/app/tickets/` → `web/components/tickets/`, over `tickets-service.ts` + `dropped-mail-service.ts`. `tickets-service.ts` does not touch `tickets` itself: every read and the one write go through `scripts/lib/ticket-record.mjs`, and the list reads the `ticket_queue` view. Queue priority is computed in `scripts/lib/ticket-priority.mjs`. In one request-cached bulk read, `ticket-priority-service.ts` adds the latest stored situation (`ticket_investigations` / `ticket_case_state`), the linked order's current synced fulfilment facts, and `dispatch_days` / France / abroad delivery parameters. The situation and action window choose the band; queue age, contacts, level and `awaiting_human` sort only within it. Four stacked collapsible sections, each scrolling inside a fixed height:

**One row per case** (61): the queue keeps `is_case_lead` rows and ranks them on the case's facts (`case_inbound_count`, `case_waiting_since`, `case_level`, `case_status`; situation and order borrowed from the most recently investigated thread, `withCaseFacts`). « Show every thread of a case » brings the others back, marked « Linked thread »; a lead of several threads shows « N threads ». The thread dialog lists the case's threads and which one the reply goes to; a manual reply is refused on any other (`replyElsewhere`).

| Section | Source | Row action |
| --- | --- | --- |
| **Queue** | `tickets`, status not resolved/closed, waiting less than 14 days | Close ticket |
| **Irrelevant** | `spam_audit`, `outcome = 'blocked'`, minus the promoted, minus the cleared | **Add as ticket** · **Select → Clear** |
| **Backlog** | `tickets`, status not resolved/closed, waiting 14+ days | Close ticket |
| **Closed** | `tickets`, status resolved/closed | Reopen ticket |

**Add as ticket** overturns one gate decision. `POST /api/dropped-mail/:id/promote` → `dropped-mail-service.ts` → `agent/src/ingestion/promote-dropped-mail.mjs`, which maps the `spam_audit` row into the shape `mapGraphMessage` produces and writes it through `writeIngestedMessages` — the ordinary ingestion path, so threading, idempotency, `needs_categorisation` and the reopen rule are ingestion's and not a second copy of them. The worker's next poll then categorises, resolves and investigates it like any other ticket. Disabled where the row has no stored body. **No schema change and no write to `spam_audit`**: promoted is derived — a blocked row whose `graph_message_id` now exists in `ticket_messages` — and drops out of the section on that basis.

**Select → Clear** hides dropped mail somebody has finished reading. `IrrelevantWorkspace` in `TicketsView.tsx` and nothing else: **no route, no service, no write** — the cleared ids live in `localStorage` under `tickets.clearedMail`, are subtracted from the list and from the tab count, and **Restore N** in the same header brings them all back. Select mode turns each row into a checkbox (row click ticks instead of previewing); Cancel leaves it untouched.

Layout: **three panes, selection-driven** (`TicketWorkspace`) — `TicketListPane` (the queue), `detailPane` (`TicketDetailWorkspace`: one header block — title row, the investigation's **Next action** on one line, and a **Conversation | Activity | Linked threads** tab strip as its bottom edge, where « Linked threads » shows only on a thread whose case has others — then `ConversationThread` (date-grouped, each message shows only its new text via `scripts/lib/email-display.mjs`; quoted history, forwards, signature and the original sit behind disclosures) or `LinkedThreads` (the case's other threads, newest first, each with its subject, status, dates, how it joined and « the reply goes here », and its mail read-only; the messages come with `getTicketThread().case.threads[].messages`) or `ActivityTimeline` (one oldest-first feed: every email in/out off the thread, the investigation's tool-call ledger from `summariseActivity` in `tickets-service.ts`, and draft generation — an icon per kind) — then `DraftResponsePanel`), and the right-hand `contextPane` (`TicketContextPane`: Customer · Ticket · Order · Investigation · **Case** · Required action · **Attachments** · **Situation & rule**). The context rail is also the mobile `contextSheet`. **`TicketTable` and `TicketDetailPanel` are NOT on this page** — they render `/conversations` only, and this line described them as the Tickets row expansion until 2026-09-09, which is a stale description that cost a feature being built into the wrong component. **Situation & rule** is last, off `ticket_investigations.exemplar_match` (`summarisePolicy` in `tickets-service.ts`, read field by field so the case file's diagnostics cannot leak onto a support screen): which situation the run settled on and how (`matched` / `near miss, chosen by the agent` / `nothing close enough`, with the score and the closest loser), which rule its findings selected, whether that rule **changed the verdict** or only shaped the reply, and what it asked for (route, asks, offer code). Shown even when nothing matched — a ticket no rule answered is a gap in the rulebook and is otherwise invisible until read in a transcript. The Attachments block is above it and renders only on the 114 of 383 tickets that carry a file or claim to: the customer's photos inline — proxied per view from the mailbox through `/api/tickets/[id]/attachments/[index]`, never stored — plus a warning where a photo was mentioned and none arrived, and the names of any non-image files. **« Edit case »** (top of the rail) turns Category, Level, State, Team, Priority band and the Situation into pickers in place; one Save → `PUT /api/tickets/[id]/overrides` → `saveTicketOverrides` (`tickets-service.ts`), which builds the write with `overrideChange` (`scripts/lib/ticket-overrides.mjs`), writes through `ticket-record.applyOverrides` (conditional on the status and overrides the page read), appends `ticket_overrides` and re-folds via `refoldTicket` (`case-state-service.ts`). An overridden field shows « Human override » (the automatic value on hover) and, while editing, « Reset to automatic ». Situation & rule leads with the situation's name (`support_exemplars.canonical_question`, via `listSituations`), and while the match is unsettled offers the nearest three (`exemplar_match.top`) with « Apply ». The **Order** block lets a person link the order themselves, through `OrderLinkDialog` and `/api/tickets/[id]/order`. A confirmed order carries a pencil beside its number. No order shows **Add order number**. A candidate last order shows **Confirm this order** (plus **Add order number**). The popup has two steps: look the number up and see a preview (order, date, channel, name, masked contact, and how it relates to the sender's email), then confirm that it re-runs the investigation. Open to every role. The service is `previewTicketOrder` / `changeTicketOrder` in `tickets-service.ts`; the write is `ticket-record.linkOrderManually`, conditional on the order the popup was opened on. Four header cards, plus level tabs, category filter (matches the primary **or** the secondary category), sender filter and sort, all client-side over the open-ticket set. Search is per view. In the Irrelevant view the subject opens the dropped email (`DroppedMailDialog`). The **Case** block (`CaseSection`) reads `case_current` through `case-state-service.ts` (`getCaseState`, via `getTicketDetail().caseState`): next actor, open checks with owner, working-day age and overdue flag (`colleague_check_overdue_days` / `partner_check_overdue_days`), pending questions, a rule step's place (« step 1 of 2 ») and its queued steps (« Then: … »); needs in English via `web/lib/need-labels.ts`. « Mark done » / « No longer needed » → `POST /api/tickets/[id]/obligations` → `actOnObligation` inserts into `ticket_case_actions` and re-folds the ticket (which may move its status); the route returns the case and the refreshed queue row (`TicketCaseChange`). **Snoozed** is a tab between Backlog and Irrelevant, soonest back first; Queue, Backlog, the header cards and the sidebar badge leave snoozed tickets out. Each list row carries `snooze` and `lastWake` (the last 24 h) from `readSnoozeFacts` (`snooze-service.ts`, two reads of `ticket_snoozes` per request), shown as a chip. Each row also carries `forwarding` from `readForwardingFacts` (`forwarding-service.ts`, four small reads per request; the tag is `scripts/lib/forwarding-tag.mjs`): « To <destination> after first reply », « Forwarding to … », « Forward to … failed » or « Forwarded to … », a chip on the row (`ForwardingChip`) and a line under the header (`ForwardingBanner`). It reports only what the forwarding pass decided (`ticket_routing`) or sent (`ticket_forwards`), so a ticket appears once the pass has seen mail received since the switch. The header's **Snooze** menu (`SnoozeControl`): later today, tomorrow 09:00, a date, or until the customer / an operations partner / a colleague replies, each with « or <date> at the latest » from the shop's delays (`readSnoozeDelays`); a snoozed ticket shows **Unsnooze** and a banner (waiting for, back by, agent or person, note).

### `/conversations` — threads we opened

`web/app/conversations/` → `web/components/tickets/ConversationsView.tsx`, over `listConversations` in `tickets-service.ts`. The other half of the `/tickets` partition: threads whose opening sender is one of ours (`sender_label` = `internal` | `contractor`), stamped at ingestion from `sender_directory`. The agent investigates these but never drafts on them (`draftDecision` → `internal_sender`).

Two sections over the same `TicketTable` the queue uses — **Open** (expanded, leads the page) and **Closed** (collapsed). No level tabs, category filter or stat cards: 14 rows where the only useful questions are what is still open and where a forward went.

`countOpenThreads` (one `queue()` read, both halves of the partition — shared per request with the page's own list through React `cache`, and started beside the page's reads rather than before them) feeds the sidebar's open-count badges — Tickets in the warning colour, Conversations grey, both hidden on the collapsed rail — rendered from **every** page in the shell via `navBadgeCounts` in `lib/server/conversation-badge.ts`. The same call also returns `unfulfilledOrders` (`countOrdersAwaitingFulfilment` in `orders-service.ts`, a `count=exact` HEAD using `open_orders()`'s rule) for a grey badge on Orders; each count fails on its own. That is the mitigation for routing these off the queue at all — the arrangement failed once by being silent. See DECISIONS.md § Tickets dashboard.

### `/insights` — the eight analytics panels

`web/app/insights/{overview,sales,customers,marketing,fulfilment,support,social,agent}/page.tsx` → `InsightsPage` (tabs in that order, from `INSIGHTS_PANELS` in `web/lib/types.ts`)
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
| **Marketing & funnel** | yes | yes (newsletter always Shopify) | orders summary, `insights_sales_overview`, `insights_promotions`, the newsletter rows (churn, movement, capture — moved here from Customers), and **ShopifyQL** (`analytics.ts`, each card streamed in on its own): the four-step funnel, acquisition channels, landing-page types and the busiest product pages (named from `products.handle`); **Klaviyo** from `insights_klaviyo_messages` (open rate first: tiles over every flow and campaign in the range, table of those with ≥ 1 click and ≥ 50 recipients sorted by open rate; blocked when not connected, not yet synced, or on a marketplace). Product VIEWS stay blocked — no metric; **Paid / Social** from `getMarketingSocial` (social-service.ts), blocked while not connected |
| **Sales** | yes | yes | orders summary + series + by channel + by country, customer mix (marketplaces excluded), product sales, country product sales (re-read over VIP customers' orders with `?bestVip=1`), product pairs, and the "Who buys this product" card (`insights_product_customer_mix` + `insights_product_orders_per_customer` for `?product=`, both on the same arguments, optionally `?mixCountry=` and `?mixVip=1`, marketplaces excluded; `ProductCustomerMixCard` with a searchable product picker and its buyers-by-order-count chart) |
| **Fulfilment** | yes (the open-orders list and the stock card are "now") | yes | orders summary + series, fulfilment buckets + carriers, `open_orders()` (orders waiting to ship, VIP-marked, with name + email, the name ringed by open ticket as on Orders — `open-orders.ts`), `insights_inventory_exceptions` (`inventory.ts`) |
| **Support** | yes | no — tickets have none | support summary + series + categories, orders summary (contact-rate denominator), the latest `cluster_runs` for the topic map (all-time, with a Rebuild button) |
| **Customers** | the activity rows only (the base is a snapshot) | no — people, so always Shopify | `customer_segment_totals` + `customer_ticket_facts` + `customer-segments.mjs`; orders per customer (`customer-activity-service.ts`; the newsletter and capture rows moved to Marketing & funnel on 2026-09-23 — the order-count columns are folded by `order-frequency.ts`, shared with the Sales product card so both charts cut the tail at 10+ the same way); the Segment Finder under the base cards, on demand through `POST /api/insights/segment-finder` -> `segment-finder-service.ts` -> `customer_segment_find()` |
| **Social media** | yes (audience is "now") | no — not sales channels | `?mode=organic` (default): `insights_social_series` / `_followers` / `_post_totals` / `_posts` / `_audience` folded by `social-figures.mjs`, Instagram reach live (≤ 30 days); `?mode=paid`: `insights_paid_series`, per currency. `?network=` one kind, `?view=profile|content|posts` for one organic account. Connections dialog on `?connections=1`. Closed to contact |
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

**List** (`OrdersView`): Order · Date · Name (+ crown when VIP) · Total · Fulfilment status (amber dot until fulfilled) · Delay (whole days waiting to ship, red at 3+, blank once not waiting) · Articles · Carrier · Destination. A search box (order name, buyer name or email, tracking number; debounced) plus filters for fulfilment status, Global / By country, and All customers / VIP only; with the page number they live in the query string (`?q= ?status= ?country= ?vip= ?page=`, parsed by `order-list-query.mjs`) and the server re-renders. 50 rows per page, paged and counted by `orders_list()`. **The customer name is ringed** red / orange / green when an open ticket is confirmed against that order (`tickets.shopify_order_number`), in the most urgent ticket's queue band — read off `listTicketsWithOrders`, folded by `ticketMarksByOrder` (both in `lib/server/order-ticket-marks.ts`, which the Fulfilment panel's waiting orders share), never re-scored. A row opens `/orders/[id]`.

**Detail** (`OrderDetailView`): Articles, **Promotions**, Fulfilment (shipments, tracking links, returns), Payment (totals, refunds) on the left; Tickets, Customer (name, email unless marketplace, lifetime orders/spend, VIP), Destination (coarse — no street is stored), Tags on the right; "Open in Shopify" in the header. Both pages write a `data_access_events` row (`resourceType: orders`). **Promotions** lists what was applied by name (from `orders.discount_applications`), the gifts with their value and the promotion that gave them, plain reductions, the codes used and — listed apart, never as gifts — the samples; "no promotion was applied" is rendered rather than hidden. Opened as `/orders/[id]?ticket=<uuid>` (the link on a ticket's order number), the page leads with **← Back to the ticket** to `/tickets?ticket=<uuid>`, with Orders beside it.

### `/settings` — My info · Agent settings · Integrations · Dev info

`web/app/settings/page.tsx` → `components/settings/SettingsView` (the Insights page frame, tab bar, cards and tables). Tab in the URL: `/settings`, `?tab=agents`, `?tab=integrations` or `?tab=dev`; only the open tab's data is read.

- **Dev info** — developer and management only (same gate as Integrations). `components/settings/DevInfo`: architecture diagram (People → App → Data → Services, with links and live/partial/planned status) and a subscriptions table, both from the hand-kept `web/lib/dev-stack.ts` (edit it when a service, host or plan changes; `plan`/`monthly` stay null until recorded). OpenAI models and 30-day spend are live, from `getAgentRoster()`.

- **Integrations** — developer and management only (`canManageIntegrations`; the tab is not drawn for contact and `/api/settings/integrations` is denied in `dashboard-auth.mjs`). `KlaviyoKeyCard` over `lib/server/integrations-service.ts` and `PUT|DELETE /api/settings/integrations/klaviyo`: the key is checked with Klaviyo (`connectKlaviyo`), then stored in Vault; the card shows `pk_…` + last 4 and the last sync. Below it, the Meta / Google Ads cards (`SocialProviderCards`, the same as the Social panel's Connections dialog; `?connected=` / `?connect_error=` on return).

- **My info** — the signed-in user from `getSession()`, and which areas the role may open (`canAccessPath` in `dashboard-auth.mjs`).
- **Agent settings** — `lib/server/agent-settings-service.ts`: one row per agent (spam, categorise, situation chooser, decompose, investigate, draft, embed from `insights_llm_usage`; the management chat from `chat_turns`), last 30 days: model (the one chosen in `agent_models`, else the most-called in the window, else the configured one from `loadAgentConfig` / `chatModel()`), calls, failed, cost via `llm-rates.mjs`. **A model can be chosen per agent** (developer and management; `canChooseAgentModels`, `/api/settings/agents` denied to contact): `AgentModelPicker` → `PUT /api/settings/agents/models` `{agent, model|null}` → `setAgentModel` → `agent_models`. The list is the OpenAI key's own `/v1/models`, filtered to chat models (`lib/server/openai-models.ts`, 10-min cache); a model not on it is refused. Not embeddings, not a stage whose env var is empty (off).

## Agent Worker

Run `npm run ingest:once` or `npm start` from `agent/`. One poll runs every pass below, **in this order** — the order is load-bearing (see `DECISIONS.md`), and `agent/src/poll-order.test.mjs` asserts it rather than trusting this table.

| # | Pass | Module |
| --- | --- | --- |
| 1 | load config, assert Graph creds, resolve `shops.id` | `index.mjs` |
| 1a | **Subscriptions** — create/renew the Graph change-notification subscription per folder; no-op without `MAIL_WEBHOOK_URL`; a failure logs `mail.subscription_renew_failed` and the poll goes on. Claimed `sync_mailbox` jobs close once both folders are read | `mail/subscription-manager.mjs`, `index.mjs` |
| 2 | read through the **MailProvider** (`mail/outlook-graph-adapter.mjs`), follow Graph delta pages; save the nextLink after each written page and the deltaLink at the end; a saved link Graph rejects (400/410) is dropped and the read starts over once; immutable ids asked for when `mail_id_type = immutable`. **Twice per poll: Inbox, then Sent Items** (`folder: 'sentitems'`: everything outbound, attach-only (`skippedNoTicket`), an outbound copy already stored under another Graph id skipped (`skippedCopies`)) | `ingestion/delta-poller.mjs` |
| 3 | map messages; derive direction + normalise contact-form identity (inside the adapter) | `ingestion/graph-message-mapper.mjs` |
| 3b | **Confirm sends** — an outbound action whose draft id (or Internet-Message-Id) now has a stored Sent Items copy → `sent_confirmed`, its draft `sent`. Before the fold, so the fold never marks that draft superseded by our own reply | `outbound/outbound-runner.mjs` (`confirmSentActions`) |
| 3a | **Known-sender exemption** — an address in `sender_directory` bypasses BOTH gates; the LLM call is skipped, not overruled. Can only keep mail, never block it | `ingestion/known-senders.mjs` |
| 4 | **Gate 1** (no LLM): blocklist match → dropped before any write | `ingestion/spam-gate.mjs` |
| 5 | thread survivors by conversation; embed inline (best-effort). On an existing ticket the opener (`sender_label`) and a requester that is one of our own addresses are first re-read from the whole thread (`threadIdentity`, `requesterFor`), with the thread's staff messages re-filed if either changes (`directionFor`). Then an `internal` sender with the ticket's customer in To/Cc is re-filed `outbound` (`isStaffReplyToCustomer`: staff replying from a personal inbox). A **new** inbound message wakes the ticket's snooze (`customer_message` / `colleague_message` / `partner_message`); a re-delivered one does not | `ingestion/ticket-writer.mjs` |
| 5a | **Case + duplicate** — a new conversation opens its own case (`case_link_state = pending`). **Duplicate** (deterministic, pre-embedding): reply chain, or identical body inside an hour → the thread **joins its original's case** (decided, a `case_links` row); without the case record the old link is written. A new inbound message wakes the snoozes of **every thread of its case**. Fires only on the message that *creates* a ticket | `ingestion/duplicate-rules.mjs` |
| 5a2 | **Sender label** — the opening address is looked up in `sender_directory`; `internal`/`contractor` stamped onto the ticket | `ingestion/sender-directory.mjs` |
| 5b | ~~Related link~~ — **no longer run** (migration 61): a similar message is a candidate for the `link` pass (10a) instead | `ingestion/related-rules.mjs` |
| 6 | **Gate 2** (LLM, new conversations only): drops `spam` **and** `irrelevant`; fails open | `ingestion/spam-classifier.mjs` |
| 7 | flush gate decisions (with body on a block) to `spam_audit` | `ingestion/spam-audit.mjs` |
| 8 | **Customer resolution** — needs no category, order number or LLM key; the sender's address, else the address the customer gave after we asked for one (`record.addressAnswersByTicket`) | `resolution/customer-resolution-runner.mjs` |
| 8a | **Casework** (LLM) — two paths. (1) Customer follow-ups on tickets with a case file, as before, now also reading `effect` and the checks opened/cleared. (2) **Our messages and colleagues'/partners' received after the mailbox cutover** (`runOtherMessageCasework`), oldest first per ticket, adding what we `asked` and the checks opened/cleared; owners limited by `obligationOwners`. Original path: what the newest message changed. Claims only a ticket that ALREADY has a case file and whose newest inbound message has no reading, so a genuinely new case matches nothing. Writes `ticket_case_state` | `casework/case-runner.mjs` |
| 9 | **Categorisation** (LLM) — 25/poll, oldest first, selects on the pending flag. **Skips the call on a `continuation`** and re-completes the existing labels, so the pass still clears the flag and raises `needs_investigation` | `pipeline/categorise-runner.mjs` |
| 10 | **Order resolution** then **order context** — no LLM, no category needed. **Before the investigation, and that is load-bearing**: `getOrderContext` READS `tickets.resolved_context` rather than querying, so an investigation that ran first could not see an order however clearly the customer quoted it. Context builds missing bundles **and rebuilds any whose order now carries a different `shopify_updated_at`** than the one it was built from (`sourceUpdatedAt`) | `resolution/order-*-runner.mjs` |
| 10a | **Case linking** (`link`; deterministic, no LLM unless `CASE_LINKER_ENABLED=true`): each `pending` thread, once, after categorisation and the order passes. Listed sender / own thread → new case; no other case of this customer in 60 days → new case; ≤ 5 plausible candidates (same parcel, same order, compatible family, embedding ≥ 0.90 for retrieval only); `tracking` / `order_family` / `unique_match` link; still ambiguous → the Case Linker (`LINK:<id>` \| `NEW_CASE`), else a new case logged `model_off`. A link recomputes the case's reply target, wakes its snoozes and re-queues an already investigated thread | `cases/case-linker-runner.mjs`, `cases/case-link-rules.mjs`, `cases/case-linker-model.mjs` |
| 10b | **Route** (no LLM). First the **refund notice**: a refund recorded in Shopify after our last message, within `refund_notice_window_days`, on a ticket in the answer set of the rule marked `notify_on` → `fact_drift.notice`, and a `closed` / `resolved` ticket reopened to `awaiting_human`. Then the states: `open` and `awaiting_human` tickets we owe a reply on (`next_actor = support`), with a bundle and no pass pending. The order states at `now` against the latest case file's; on a change, the stored rule selection is replayed (`selectAnswer`): rule moved → `needs_investigation` + `metadata.change_router` (its `at` becomes the run's clock); rule holds but the case file states an order fact or a rule reads the state → `fact_drift` only (the fold raises the version → redraft); else nothing. `awaiting_human` is never re-investigated: a moved rule is redrafted (`…:held_for_person`). Waiting on anyone else → nothing | `casework/change-router.mjs`, `casework/change-router-runner.mjs` |
| 11 | **Investigation** (LLM + tools; `getPolicy` offered wherever `searchKnowledge` is and a policy is active, the matched situation's linked policies read as opening moves) — decompose (every investigated ticket — the structural gate was removed 2026-08-09), then 6 tool calls +2 per extra task, 4 turns, `ENABLED_SUBJECTS` only. Reads the **whole case** (every thread, in email-time order, other threads marked « AUTRE FIL DU DOSSIER ») and skips a thread that is not its case's reply thread (61). Reads the thread **both directions** since 2026-09-21 and renders it as a labelled transcript; a one-message ticket still renders bare. A follow-up the Case Manager read gets its situation from `planSituation` and a « Dossier connu » section from `case-delta.mjs` (2026-09-25); stored `tool_calls` carry `source` (opening_move / planner / model) | `investigation/investigation-runner.mjs` |
| 11a | **Fold** (no LLM): tickets whose fold is older than their latest message, case file, reading or `fact_drift`, 200 a poll → `case_current` (a drift is part of the version hash), then the ticket's status from `next_actor` (`AGENT_CASE_STATUS_BY_NEXT_ACTOR`; `off` skips it), then **snooze** (off unless `AGENT_AUTO_SNOOZE=true`): a message of ours new in the thread that leaves the next step to the customer, a colleague or a partner, with no check of ours open, snoozes the ticket until the shop's delay; a snoozed case that comes back to us wakes; an automatic snooze whose case now waits on a different party is retargeted in place (that party, its deadline), or woken if the case became work. Then each touched case's **reply target** is recomputed (`onFolded` → `refreshTargetsForTickets`) | `casework/case-current-store.mjs`, `casework/case-status.mjs`, `casework/snooze-rule.mjs` |
| 11b | **Draft** (LLM). **Refund notices always** (`gates: 'notice'`: the template rule's skeleton, never auto-sent). Replies **off unless `DRAFT_IN_POLL=true`**; with a `fact_drift` on the case file it drafts from, the case file's claims resting on the order bundle alone are left out): our turn on a customer message since the mailbox cutover, with a current case file and no pass pending (`pollGate`), at most `DRAFT_POLL_LIMIT` a poll; a case file whose trigger is not its case's reply target is skipped (`not_reply_target`), and the conversation read is the whole case → `ticket_drafts` at the case version. The fold before it stales drafts of a case that moved. Nothing is sent | `drafting/draft-runner.mjs`, `drafting/draft-context.mjs` |
| 11c | **Send** (no LLM; **off unless `OUTBOUND_SEND_ENABLED=true`**): auto-send actions from eligible pending drafts (only with `DRAFT_ONLY=false`), then claim `send_outbound` jobs: `preSendCheck` (draft still approved, case version unchanged, order not materially moved since its bundle (`facts_pending`), no newer customer message, nobody answered — read across every thread of the case) → reply draft via the provider → `send_requested` → send (with `OUTBOUND_STOP_BEFORE_SEND=true` it stops at the reply draft, `draft_created`). A `send_requested` action is never retried blind: the mailbox is asked whether the draft went | `outbound/outbound-runner.mjs` |
| 12 | **Forwarding** — off until `forward_since` is set; inbound mail received since then on tickets in a category some destination takes. `planRoute` (stays / fixed / the chooser for a choice), stored in `ticket_routing`; `after_first_reply` waits for an outbound message; then Graph `/forward` per message and, once per ticket, the fixed acknowledgement through the provider's reply draft + send. Needs `Mail.Send` + `Mail.ReadWrite` | `routing/forward-runner.mjs` |
| 13 | **Auto-close** — 28d idle **across the case's threads**, level 4, awaiting-human and snoozed exempt **anywhere in the case**; last so it sees this poll's timestamps | `lifecycle/auto-close.mjs` |
| 13a | **Snooze deadlines** (no LLM) — every open snooze past its `wake_at` wakes (`deadline`). Nothing else moves. Runs whatever `--stop-after` says. New mail from anyone but us wakes a ticket earlier, at ingestion (step 5) | `lifecycle/snooze-wake.mjs` |
| 14 | **Retention purge** — nulls expired `spam_audit` bodies; best-effort | `ingestion/spam-audit.mjs` |
| 14b | **Monthly sales report** (no LLM; **off unless `SALES_REPORT_URL` + `SALES_REPORT_SECRET`**): from `SALES_REPORT_SEND_HOUR` (8) on the 1st, shop clock, catching up to the 7th: fetch last month's report from the dashboard, mail it as an attachment to active `SALES_REPORT_ROLES` accounts (management) + `SALES_REPORT_EXTRA_RECIPIENTS`, not saved to Sent Items. Once per month via `integration_events` (`sales_report_mail`); a failure retries every 30 min, 5 attempts. Runs whatever `--stop-after` says | `reports/sales-report-mail.mjs` |
| 15 | **Cost flush** — one insert of this poll's `llm_usage` rows. Like 14, runs whatever `--stop-after` says: the calls were already billed | `llm/usage-store.mjs` |

Built through Phase 4 (retrieval tools + the agent that uses them). **Drafting is built as a standalone pass (`npm run draft`) and is deliberately NOT in the poll yet** — it is the first pass whose output a customer would read, and it stays operator-triggered until the drafts have been reviewed.

### Agent CLIs

From `agent/`. Every pass has a standalone runner, most with `:dry-run`.

| Command | Does |
| --- | --- |
| `start -- --stop-after=ingest --also=send` | the deployed sync-only worker: mailbox sync plus the send stage (approved replies → Outlook drafts or sends), no model stage. `--also` accepts only `send` |
| `ingest:once` / `start` | one poll / the loop. Supports `--limit=N` (the newest N messages, written oldest first; the cursor is not saved); with `--stop-after=categorise`, that limit applies to both Graph ingestion and the categorisation batch |
| `ingest:reset` | clear the delta and resume links (keeps the cutover and id type) |
| `mail:status` | read only: the send/webhook switches, `mail_jobs` by state (dead ones with their error), outbound actions by state, subscriptions and their expiry. No Graph call |
| `actors:backfill[:dry-run] [-- --recompute]` | fill `ticket_messages.actor` on rows stored before migration 41 (empty rows only unless `--recompute`) |
| `fold:once [-- --limit N] [--all] [--no-status]` | the fold pass alone: no mailbox read, no model call; moves statuses unless `--no-status` |
| `route:once [-- --dry-run]` | the change router alone: no mailbox read, no model call; prints each refund notice due and each open ticket's outcome. Run `context:build` first so it compares rebuilt bundles |
| `cases:link` / `cases:link:dry-run` | the `link` pass alone, on `pending` threads (`--limit=N`); the dry run decides and writes nothing |
| `cases:link -- --open [--dry-run] [--with-model]` | a one-off backfill: re-decides the Queue and Backlog threads, plus their customers' earlier threads in the link window, oldest first and each against earlier threads only. A thread already sharing a case is skipped. `--with-model` asks the Case Linker even while `CASE_LINKER_ENABLED` is off |
| `cases:targets` | recompute every case's reply target — run once after migration 61 |
| `cases:replay [-- --with-model] [--limit=N]` | **read-only**: every stored thread decided as if it had just arrived (only earlier threads are candidates); counts by method and lists every link and every ambiguous thread with its candidates. `--with-model` asks the Case Linker on the ambiguous ones (costs calls). The check before `CASE_LINKER_ENABLED=true` |
| `case-status [-- --apply]` | the status moves stage 5c would make from the stored folds; a dry run unless `--apply` |
| `snooze -- --dry-run [--try=key=value]` | what `AGENT_AUTO_SNOOZE` would have done on each ticket's last reply of ours; `--try` judges with a delay not saved yet. Writes nothing |
| `tickets:unqueue-pre-cutover[:dry-run] -- [--keep-after=ISO]` | clear `needs_categorisation` (labels kept) on tickets whose every message predates `mail_ingest_cutover_at` |
| `cases:label -- [--prefill] [--limit N] [--groups …]` | build the timeline-labelling page (gitignored `*-review.html`); labelled threads first, then groups in turn |
| `cases:import -- <export.json \| --upgrade>` | fold an export into `eval/casework-cases.mjs`; `--upgrade` re-validates the set after a vocabulary change |
| `staff-replies:backfill[:dry-run]` | reconcile the direction of stored staff messages with the ingestion rule, both ways (outbound when addressed to the customer on a customer thread, inbound otherwise) |
| `ids:translate[:dry-run]` | one-off: rewrite stored `graph_message_id`s (ticket_messages, spam_audit, categorisation_review) to immutable ids, verified against delta, then set `mail_id_type` and drop the links (`ingestion/immutable-ids.mjs`) |
| `blocklist:add` | add a blocklist rule |
| `spam:backfill[:dry-run] -- --limit=N` | re-read dropped mail from Graph to fill `spam_audit` bodies |
| `attachments:backfill[:dry-run] -- --limit=N` | fetch attachment metadata from Graph for messages ingested before the column existed |
| `customers:resolve[:dry-run]` | link `tickets.customer_id` from the requester hash |
| `customer:lookup -- <email> [--json] [--with-email]` | the CRM tool, no ticket needed |
| `orders:resolve[:dry-run]` | confirm order numbers |
| `context:build[:dry-run] [--refresh]` | fill `tickets.resolved_context` |
| `investigate[:dry-run] [--show/--brief] [--backfill] [--include-closed] [--ticket <id>]` | run + render case files. `--backfill` re-queues **open** categorised tickets; `--include-closed` widens the claim to threads the queue has moved past, leaving their status untouched. Both print what the run cost. `--ticket` narrows the queue to one ticket without bypassing its flag |
| `draft -- --dry-run --gates=poll` | what drafting in the poll would do now: every gate, **no model call**, the cases waiting on us since the cutover, the drafts, median tokens from `llm_usage` and the cost (`llm-rates.mjs`) |
| `draft[:dry-run] [--show] [--ticket <id>] [--limit N] [--redraft]` | the drafting pass. Reads case files, writes `ticket_drafts`; **no Graph call**. Refuses unless the Brand voice article is `approved`. `--redraft` overwrites an existing draft — the queue is derived, so a ticket leaves it once one exists |
| `cases:reconstruct [--ticket <id>] [--limit N] [--min-inbound N] [--json <path>]` | reads finished threads and reports where each case stands. **Writes no ticket, no case file and no draft** — it is built with a reader and no record module. Defaults to threads with 2+ customer messages, because a one-message thread has no trajectory to reconstruct. The output is a review artefact nothing downstream reads: correct it by hand and it becomes the labelled set a regression suite can rest on |
| `cases:review -- --in <json> --out <name>-review.html` | the reconstruction JSON plus each thread, as a page to disagree with. No model call, no write. `*-review.html` is a gitignored name because these quote real customer mail in full |
| `cases:label [-- --count] [--prefill] [--groups a,b,c] [--out <name>-review.html]` | the page the multi-turn labelled set is written on: every thread with a customer follow-up or another sender (`--groups` adds `replied_once`), cut after each message in both directions, one form per cut. `--count` reads and counts, no model call. `--prefill` runs `readCase` on inbound cuts as a suggestion, with no usage sink. Labels autosave in the browser and export as ids and choices only. Vocabulary in `eval/casework-vocabulary.mjs`, cutting in `eval/casework-cuts.mjs`. Read only |
| `cases:import -- <casework-labels.json>` | folds a page export into `eval/casework-cases.mjs`, keyed on message id so batches accumulate. Drops suggestions nobody touched, values outside the vocabulary, and `answered` / `nextAction` on outbound cuts, and prints each. Ids, choices and the labeller's notes; no bodies |
| `tickets:requeue[:dry-run] -- --ticket <id> [--unlink-customer] [--reopen]` | put named tickets back in the investigation queue after a repair; optionally clear `customer_id` (then run `customers:resolve`) and reopen an agent-set status |
| `forward:once` / `forward:dry-run` | the forwarding pass; the dry run calls the router but sends and records nothing. `--since=<date>` rehearses as if switched on then (dry run only) |
| `route:preview` | read-only: where the router would send each ticket in a routed category (`--category=b2b`, `--open`). One `AGENT_ROUTER_MODEL` call per ticket with a choice; sends and records nothing |
| `tickets:autoclose[:dry-run]` | the lifecycle pass |
| `eval:closure [-- --repeat N] [--show]` | closure detection over every thread where a customer wrote after our reply — the whole population, 16 threads. The one eval whose corpus is real mail: ids and labels are checked in, bodies are read live. A false closure fails the command; a missed one does not |
| `eval:casework [-- --repeat N] [--show]` | today's pipeline against the multi-turn labelled set, per inbound cut: the Case Manager's `effect` and `answered`, and the next action (`draftDecision` skips, closure through the real case file's gate where one existed at that message, else taken as open). Each cut starts from the labels, not the model's previous answer. Outcomes are agree / disagree / **inexpressible** (a label the pipeline has no value for) / unlabelled. Outbound cuts, case state and internal checks are counted, not scored. Writes nothing; no gate yet |
| `eval:delta [-- --show]` | what follow-up investigations did with the « Dossier connu » section: calls per run with and without it, runs where the model re-fetched a fact the section said was established, runs where a fact to refresh was not looked at. Rebuilds each delta with the runner's own `caseDeltaFrom`. No model call, no write |
| `eval:categorise` · `eval:retrieval` · `eval:diagnose` · `eval:exemplars` (`-- --authored-only` drops the translations, for a same-corpus A/B) · `review:sample` · `review:compare` | every measurement — indexed in **`agent/eval/README.md`**, which says what each is judged against (three labelled sets, two proxies) |

## Read Order

`AGENTS.md` (rules) → **this map** → `DECISIONS.md` (why, per section, on demand) → `PRODUCT.md` (design direction) → `README.md` (status + setup).

Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
