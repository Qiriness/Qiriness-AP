# Map: scripts/

Root package: Shopify syncs, shared `scripts/lib/` modules (used by web and agent), reports and probes. Part of the schema map; the index is `APP_SCHEMA.md`. Why things are this way: `DECISIONS.md`.

```text
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
|       |-- storefront-chat/             # the storefront advisor: app-proxy-signature
|       |                                # (verify + allow-list) · request-schema (what
|       |                                # the widget may send) · agent (the contract +
|       |                                # the mock) · llm-agent (storefront_sales_agent
|       |                                # on OpenAI: tool loop <= 2 rounds, bounded wait,
|       |                                # cards only for tool-returned handles) ·
|       |                                # system-prompt (brand from shop data) ·
|       |                                # product-repository (THE reader of products +
|       |                                # advice_collections: named columns, live only) ·
|       |                                # product-tools (resolve_products, search_products,
|       |                                # get_product by id; pure, over the catalogue) ·
|       |                                # product-resolver (WHICH products: SKU →
|       |                                # commercial name → type → description →
|       |                                # conversation → page; vocabulary derived from
|       |                                # titles; clarification, never a pick) ·
|       |                                # conversation-refs (« les deux », « ça »; the
|       |                                # memory folded from context.refs/resolution) ·
|       |                                # conversation-language (neutral replies retain session
|       |                                # context.replyLanguage; explicit language switches win) ·
|       |                                # resolution-cases (the French test set) ·
|       |                                # knowledge-repository (active policies + parameters,
|       |                                # approved general FAQs; lazy product-id-scoped guidance) ·
|       |                                # shopping-repository (signed-shop-scoped public promotions,
|       |                                # variants and synced collection membership; separate public
|       |                                # brand-offer preview for allowed unsynced shops; 30s cache) ·
|       |                                # shopping-evaluator (cart whitelist, quantity stock,
|       |                                # deterministic eligibility/stacking; Shopify's per-line,
|       |                                # Buy X Get Y and per-class minimum rules; no mutations) ·
|       |                                # offer-solver (which offers apply together: best-saving
|       |                                # combination, « what if I add »; docs/shopify-discount-rules.md) ·
|       |                                # shopping-tools (lazy opening + five read-only tools,
|       |                                # simulate_offers included) ·
|       |                                # shopping-cases (French deterministic expectations) ·
|       |                                # knowledge-topics (topic/key bindings, country context) ·
|       |                                # faq-matcher (runtime section records; exact → alias →
|       |                                # keywords/topic → fuzzy, no vectors) · knowledge-tools
|       |                                # (get_policy, search_faqs, get_product_policy) ·
|       |                                # knowledge-router (opening retrieval before the model;
|       |                                # product data first, guidance only on a later tool call) ·
|       |                                # knowledge-cases (French + English routing/result expectations) ·
|       |                                # advisor-tools (one consultation turn: profile pre-pass,
|       |                                # advice in the prompt, the advise tool, chips, cards, events) ·
|       |                                # advisor-state (context.advisor folded from the log)
|       |-- advisory/                    # the beauty consultation core, CHANNEL-FREE (imports
|       |                                # nothing outside itself; isolation.test.mjs): profile ·
|       |                                # lexicon (engine) over lexicon-fr + lexicon-en (same keys) ·
|       |                                # ingredients (exclusions across languages) · config (validate, compile, check against a
|       |                                # catalogue; no product ids) · select-playbook · ranking
|       |                                # (eligibility → suitability → routine fit → merchandising) ·
|       |                                # recommend (createAdvisor: advise + next question) ·
|       |                                # reason-codes · events (advisory_events schema) ·
|       |                                # advisory-repository (config <-> advisor_* tables) ·
|       |                                # advisory-cases (eval:advisory)
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
|       |                                # (compliance-audit: createSyncAccessLog, one
|       |                                # data_access_events row per sync run)
|       |-- shopify-order-webhooks.mjs   # one order webhook -> re-read that order
|       |                                # through the nightly's own query and
|       |                                # mapper, with a replay guard and an
|       |                                # out-of-order guard; then the snooze wake
|       |-- shop-links.mjs               # SHOP_LINKS (`Name|https://host`, comma separated)
|       |                                # -> the other shops' dashboards; /api/auth/me
|       |                                # returns them, UserMenu draws « Switch shop »
|       |                                # as plain links (separate deployments, accounts)
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
|       |-- tiktok-client.mjs            # Clara-derived Login Kit + Display API client;
|       |                                # consent, token exchange/rotation, public video counters
|       |-- tiktok-sync.mjs              # shop-scoped connect, identity guard, Vault rotation;
|       |                                # follower snapshots + year of lifetime video counts;
|       |                                # social-sync dispatches worker/nightly/CLI to this module
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
|       |-- social-report-data.mjs      # dated, complete-month snapshot adapter; full paged
|       |                               # source inventory, no historical metrics substitution
|       |-- social-report-availability.mjs # pure period totals, dated follower endpoints,
|       |                               # measured net changes and per-metric missing reasons;
|       |                               # shared with the offline HTML renderer
|       |-- social-report.mjs           # company-scoped snapshot + saved platform bands ->
|       |                               # supplied revision 6 editor (social-report-template.mjs)
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
```

## storefront-app/, docs/, data/

```text
|-- storefront-app/              # SEPARATE Shopify app, DEV STORE ONLY (own toml,
|   |                            # own client_id, no scopes, [app_proxy]). Run its
|   |                            # `shopify app ...` commands from here, never root
|   |-- backend/shopify.web.toml # lets `shopify app dev` start web/ behind its tunnel
|   `-- extensions/storefront-advisor/  # theme app extension: blocks/advisor-embed.liquid
|                                # (app embed, target body; settings + JSON config)
|                                # · assets/advisor.js (loader: launcher only) ·
|                                # advisor-panel.js (panel, fetched on first open;
|                                # chips up to 8; card-click beacon to /event)
|                                # advisor-cart.js (shared cart whitelist incl. observed product/
|                                # variant labels; fresh locale-aware GET cart.js for shopping
|                                # and cart-page suitability turns; ephemeral request payload)
|                                # · advisor.css · locales/fr.default + en
|-- docs/storefront-chatbot.md   # the advisor: architecture, phase, how to run
|-- data/advisor/qiriness.json  # the brand's advisory playbooks + mappings +
|                                # merchandising, as authored; npm run advisor:load
|                                # (scripts/advisor/load-advisor-config.mjs) loads it;
|                                # npm run eval:advisory checks it on the live catalogue
```
