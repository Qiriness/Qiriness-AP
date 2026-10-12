# Map: web/

The Next.js dashboard: every route, API handler, component and server module. Part of the schema map; the index is `APP_SCHEMA.md`. Why things are this way: `DECISIONS.md`.

```text
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
|   |       |-- insights/social/report/route.ts # GET ?month=&months=1|6|12&platforms=
|   |       |                                  # authenticated editable HTML report download;
|   |       |                                  # same roles as the Social panel
|   |       |-- insights/social/manual-metrics  # PUT {accountId, postId, metric, value|null}: typed-in value for any of 9 missing post metrics (social-post-manual-service)
|   |       |-- insights/social/manual-audience # PUT {kind, dimension, capturedOn, entries|null}: dated manual gender/age/country/city distribution (social-audience-manual-service)
|   |       |-- insights/social/non-followers  # PUT {accountId, postId, percent}: the typed-in
|   |       |                                  # share of non-followers (social-post-manual-service)
|   |       |-- insights/social/bands        # PUT {kind, rules} or {kind, reset}: colour bands
|   |       |                                  # (social-bands-service; rules in social-bands.mjs)
|   |       |-- insights/social/engagement-basis  # PUT {kind, basis}: followers · reach · views
|   |       |-- insights/social/tags/        # post tags (81): GET all + links · POST
|   |       |                                  # {name} · [id] DELETE · [id]/posts PUT
|   |       |                                  # {accountId, postId, tagged}.
|   |       |                                  # social-tags-service
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
|   |       |-- storefront/chat/route.ts     # PUBLIC (app proxy signature + shop
|   |       |                                  # allow-list; 404 while the advisor secret
|   |       |                                  # is unset). POST -> storefront-chat-service.
|   |       |                                  # docs/storefront-chatbot.md
|   |       |-- storefront/event/route.ts    # PUBLIC (same guards as chat). POST a
|   |       |                                  # card click -> advisory_events
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
|   |   |                            # SocialReportDownload (organic All platforms footer:
|   |   |                            # calendar end month, 1/6/12 months, platform inclusion) +
|   |   |                            # SocialView (organic / paid) + SocialHeader (network,
|   |   |                            # mode, view, status pills) + SocialTrend + PaidTrend +
|   |   |                            # SocialPostsTable (# = rank in the sort; by # =
|   |   |                            # newest first · tag column, filter, TagEditor) +
|   |   |                            # PlatformIcon + MetricIcon (platform glyphs in `--social-*` colours) +
|   |   |                            # BandsEditor (per-platform colour bands) +
|   |   |                            # EngagementBasisSelect (per platform) + TopPosts (All platforms:
|   |   |                            # the 9 best posts as cards, by each platform's own rate) +
|   |   |                            # ContentActivity (per-platform Profile: posts by type / tag,
|   |   |                            # best hours and days, from `postActivity`) +
|   |   |                            # PaidCampaignsTable (links to Ads
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
|   |       |                    # storefront-chat-service (the storefront
|   |       |                    # advisor: session, caps, history, log; picks
|   |       |                    # mock or llm by STOREFRONT_CHAT_AGENT) ·
|   |       |                    # dropped-mail-service · knowledge-errors ·
|   |       |                    # cache-tags (the shared-cache tags `tickets`
|   |       |                    # and `insights`; ticketsChanged after a
|   |       |                    # dashboard write) ·
|   |       |                    # integrations-service (Klaviyo status/save/remove) ·
|   |       |                    # social-connections-service (Meta / Google OAuth:
|   |       |                    # start, callback, queue a sync, track, disconnect)
|   |       |                    # + social-return (the fixed return paths) ·
|   |       |                    # social-tags-service (post tags, read live,
|   |       |                    # never through the Insights cache) ·
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
|   |                             # social-report-service (shop-scoped dated snapshot + HTML)
|   |                             # (the Social panel + Marketing's Paid / Social
|   |                             # tabs; Instagram reach read live, <= 30 days)
|   |-- middleware.ts            # THE GATE: every page + API needs a Supabase
|   |                            # session; refreshes the hour-old token; role
|   |                            # rules from dashboard-auth.mjs
|   |-- next.config.mjs          # loadEnv() from root .env.local; staleTimes 0
|   `-- tsconfig.json            # allowJs, so services can import scripts/lib/*.mjs
```
