# Storefront advisor (« Conseiller Beauté »)

A chat widget on the storefront, answered by one agent, `storefront_sales_agent`. **Dev store only.** It is not part of the production app and must not be activated on the production store.

## Architecture

```
Dev store theme ── App embed "Beauty advisor"       storefront-app/extensions/storefront-advisor
   │  POST /apps/storefront-advisor/chat            same origin: no CORS, no backend URL in the theme
   ▼
Shopify app proxy  ── signs the query (HMAC, advisor app's secret), adds ?shop=
   ▼
web/app/api/storefront/chat/route.ts                signature → shop allow-list → body validation
   ▼
web/lib/server/storefront-chat-service.ts           session · caps · history · log
   ▼
scripts/lib/storefront-chat/llm-agent.mjs           storefront_sales_agent: model + tool loop (≤ 2 rounds)
   │                                                (agent.mjs = the mock; STOREFRONT_CHAT_AGENT picks)
   ├── product-resolver.mjs                         WHICH products: resolve before the model (~0.5 ms)
   ├── conversation-refs.mjs                        « les deux », « l'autre », « ça » + the memory
   ├── product-tools.mjs                            resolve_products · search_products · get_product
   ▼
   product-repository.mjs                           product advice catalogue reader
   ▼
Supabase: storefront_chat_sessions / _messages      migration 76
```

- **A separate Shopify app, in `storefront-app/`.** The root `shopify.app.toml` is the support app, installed on the production store, and anything deployed through it reaches production. The advisor has its own CLI project, its own `client_id` and no Admin scopes, and is installed on the dev store only. **Run every advisor `shopify app …` command from `storefront-app/`.**
- **The loader is small.** `advisor.js` (about 4 KB) draws the launcher. `advisor-panel.js` is fetched on first open (Theme Check caps app-embed JS at 10 KB).
- **Plain HTTP request/response.** There are no WebSockets and no streaming.

## Product resolution (2026-10-06)

`resolve_products` identifies **which** products the customer means. `search_products` stays discovery.

- **Runs before the model** on every message, deterministically and in memory (median about 0.5 ms). The resolved products and their facts go into the prompt, so a named product costs **one model call and no tool**. The model can still call `resolve_products` for a mention the pre-pass missed.
- **Stages:** SKU, then an exclusive commercial name, then the shared line narrowed by care type and brand synonym, then a descriptive match (the support matcher's IDF), then the conversation (« les deux », « l'autre », « le premier »), then the page (« ça », « ce soin »), with typo correction. Semantic matching is not built. An explicit mention beats the conversation, which beats the page.
- **The vocabulary is derived from the catalogue,** with no hand-written product, range or type words:
  - commercial names come from the last title segment;
  - care types come from the title's head noun;
  - brand synonyms come from the first word of commercial names (Élixir → Sérum, Caresse → Crème, Wrap → Masque);
  - identity words are those found mainly in commercial names.
  - Only French and English grammar is hand-kept, in `conversation-refs.mjs`.
- **Never a silent pick.** An ambiguous reference returns a `clarification`: the 3 best products, or the care types they span. The widget shows it as **chips**; a click sends the value as `choice`, which resolves deterministically.
- **Contract:** `{ status: resolved|partial|ambiguous|unresolved, products: [{ id, handle, name, match_strength, match_reason, mention }], candidates, clarification, unresolved_mentions, range }`. `id` is `products.id`, which later tools take.
- **Memory:** each assistant row stores `context.refs` `{ recommended, mentioned }` and `context.resolution` `{ status, ids, pending }`, folded by `refsFromHistory`. No new table. Curated aliases are deferred; the resolver already accepts an alias map.
- **Measured:** `npm run eval:resolution` gives 71/71 on the live catalogue with 0 silent wrong picks. The unit tests run on an invented brand, to show nothing is hardcoded.

## Advice: the beauty consultation (2026-10-07)

The customer talks naturally. Behind the conversation, an engine keeps a profile, applies the brand's routine playbooks and decides what to recommend. The model converses and explains. The rationale is in `DECISIONS.md` § Storefront advisor.

```
message (+ chip value, + quick action)
  → lexicon-fr (~ms): « peau sèche », « premières rides », « j'utilise déjà un nettoyant » → profile updates
  → mergeProfile: value · source (quick_choice | natural_language | model_inferred) · confidence
  → advise (~0.1 ms):
       hard eligibility: stock, area, men only on explicit request, bundles, exclusions
       playbook: area → primary concern; two plausible playbooks → ONE question
       steps for the scope (targeted · essential · complete · complete_existing) minus the current routine
       each step: suitability (concern > sensitivity > secondary; skin type → texture; age ≤ 0.05)
                  → preferred family → merchandising tier, only within the tie window
       routine builder: the next field whose answer would change the routine (never sex or age)
  → prompt: ADVICE (profile, playbook notes, steps with product facts + reason codes, next_question)
  → reply; cards = the steps; chips = next_question options (profile:<field>:<value>)
  → context.advisor on the assistant row; advisory_events
```

| Piece | Where | Channel |
|---|---|---|
| profile schema, merge rules | `scripts/lib/advisory/profile.mjs` | shared later |
| French phrasing → profile | `scripts/lib/advisory/lexicon-fr.mjs` | shared later |
| config validate / compile / check against the catalogue | `scripts/lib/advisory/config.mjs` | shared later |
| playbook selection, ambiguity | `scripts/lib/advisory/select-playbook.mjs` | shared later |
| eligibility, suitability, texture, merchandising | `scripts/lib/advisory/ranking.mjs` | shared later |
| the engine, next question | `scripts/lib/advisory/recommend.mjs` | shared later |
| reason codes, event schema | `scripts/lib/advisory/reason-codes.mjs`, `events.mjs` | shared later |
| config ↔ tables | `scripts/lib/advisory/advisory-repository.mjs` | shared later |
| one chat turn: chips, cards, prompt block, `advise` tool | `scripts/lib/storefront-chat/advisor-tools.mjs` | storefront only |
| profile memory from the message log | `scripts/lib/storefront-chat/advisor-state.mjs` | storefront only |
| card click beacon | widget → `/apps/storefront-advisor/event` → `web/app/api/storefront/event/route.ts` | storefront only |

**Already channel-independent, and unchanged:** product resolution, product facts, policies and FAQs, product-specific policies.

### The playbooks

- **Content:** `data/advisor/qiriness.json` holds the 11 Qiriness playbooks as authored. Each has `area`, `primary_concerns` (or `routes` for the eyes and men), `preferred_family`, `targeted` / `essential` / `complete` slots, a `texture` rule for the cream step, and `notes`.
- **Mappings:** `families`, `slots`, `concerns`, `skin_types`, `textures`, `areas`, `targets` and `labels` map everything to collections, tags, care types and name words. No product id appears anywhere.
- **Load:** `npm run advisor:load -- --dry-run` validates the file and checks every reference against the live catalogue. `npm run advisor:load` then replaces the shop's config in `advisor_playbooks` / `advisor_mappings` / `advisor_merchandising`. The advisor reads them at its next five-minute refresh. When no playbook is loaded, the advisor advises from search, as before.
- **Merchandising:** `merchandising.entries` takes `{ target_kind: product | collection | family, target, tier: neutral | preferred | hero | strategic_launch, concern?, slot?, starts_at?, ends_at? }`. The boosts per tier are config, at most 0.2, and apply only within `tie_window` of the best fit.
- **Dev catalogue:** the dev products sit in no curated collection, so the engine reads each dev product with the collections of the dashboard product that has the same handle. Ids, stock and cards stay the dev store's.

### Evaluation

- `npm run eval:advisory` runs on the live catalogue and costs nothing (no model).
- It covers 21 French conversations, including chips and the routine builder.
- It checks the brand's rules as invariants over 3,936 profile combinations.
- Bar: every case passes and there are 0 violations. Measured 2026-10-07: 21/21 cases, 0 violations, 0.1 ms per profile.

### Events (`advisory_events`)

**Event types:**

| Group | Events |
|---|---|
| Conversation | `conversation_started`, `advisory_started` |
| Routine builder | `routine_builder_started` / `_completed` |
| Profile | `profile_field_collected` (field + source) |
| Questions | `clarification_asked` (field + why) |
| Recommendation | `products_considered` (counts per exclusion code), `products_recommended` (ids, step reason codes, merchandised ids, skipped steps) |
| Clicks | `product_clicked` |
| In the schema, not written yet | `added_to_cart`, `recommendation_abandoned`, `unresolved_question`, `support_handoff`, `purchase` |

**Each row:**
- channel: `storefront_chat` now; `email` is reserved;
- `conversation_ref`: the chat session id, or a ticket id later;
- `shop_domain`.

Events never hold the customer's words.

**Future dashboard mapping (not built; a separate task):**
- **Advice funnel:** per channel and per day, conversations → advisory started → question asked → recommended → clicked → added to cart → purchase. These are counts by `event_type`; rates are rebuilt from counts, as in § Storefront analytics.
- **Playbook mix and question load:** `products_recommended.playbook_key` and `clarification_asked.payload.field`.
- **Product advice performance:** `products_recommended.product_ids` joined to `products` alongside the existing product-performance table, with `merchandised_ids` kept separate so pushed and earned recommendations can be compared.
- **Email later:** the same table, with `channel = 'email'` and `conversation_ref = tickets.id`, so the support dashboard can join its tickets.

## Policies and FAQs (2026-10-06)

The storefront uses the existing policy, parameter and FAQ storage. No migration,
new table, shared editor change or support retrieval change is required.

**Opening retrieval:** `knowledge-router.mjs` identifies clear general policy
topics before the first model call, then attaches `get_policy` results. Other
general questions try the approved FAQ index. Specific product questions keep the
existing product-resolution pass and receive product facts first. Mixed questions
can receive both product facts and general policies. Uncertain intent can use the
narrow tools in the existing two-round model loop.

| Tool | Input | Output |
| --- | --- | --- |
| `get_policy` | `topic`, optional `country`, optional `context: {query}` | status, topic/country, whitelisted parameter facts, source passages with key/version/date, missing fields |
| `search_faqs` | `query`, optional `topic`, optional `limit` (1–5) | winning FAQ with source id/date and match stage, or ambiguity questions; policy questions carry references instead of copied answers |
| `get_product_policy` | resolved `product_id`, optional `topic`/`query` | relevant approved guidance for that product only, or a missing/unavailable/data-required result |

- **Policy sources:** explicit storefront bindings to `company_policies` keys;
  referenced values come from `support_parameters` through the existing parsers.
  Delivery timing is scoped to France/international and starts at dispatch;
  dispatch timing is distinct. Policy facts retain their source conditions:
  the free-shipping threshold does not establish that an offer is active.
- **Bounded prose:** policy passages preserve paragraph/list boundaries, opening
  applicability and explicit restrictions/exceptions. No paragraph over 1,800
  characters is clipped into a rule; total policy passage output is capped at
  6,000 characters. Missing/invalid placeholders withhold the affected policy.
- **General FAQs:** small records are derived in memory from approved, undeleted
  non-brand sections with no product IDs. Canonical headings, unmistakable leading
  question aliases and keywords drive exact → alias/keywords → topic-narrowed
  lexical → fuzzy matching. Weak matches fail and ties return questions only.
  Non-question rewordings remain source prose; they are not guessed into aliases.
  An answer over 1,800 characters is withheld rather than cut mid-instruction.
- **Product facts first:** the catalogue now reads published `products.product_faqs`
  and returns a matching FAQ answer alongside ordinary facts when relevant.
  Product guidance is read lazily from approved `knowledge_documents` whose
  `product_ids` contain the resolved ID. The server requires the ID to be resolved
  and its facts to have been supplied in this turn. Explicit usage or Shopify FAQ
  evidence short-circuits a redundant guidance request. General FAQ search cannot
  reach product-scoped guidance or unlinked product articles.
- **Context:** optional validated `context.country`, page product/collection,
  resolved IDs and bounded history. Explicit customer destinations override
  passive context and model arguments. Locale supplies no destination. Elliptical
  delivery follow-ups can reuse the prior retrieval topic/country; prior reply
  text is never authoritative evidence. Cart value remains deferred.
- **Cache:** general sources load alongside the catalogue; knowledge expires
  after five minutes and fails closed if the agent's background rebuild fails.
  Product guidance has a separate per-product five-minute cache with coalesced
  reads; failed refreshes do not serve expired guidance.
- **Trace:** opening route, topics, country, retrieval status/stage/source IDs,
  policy versions and duration; model tool lookups add status and duration.
  Knowledge traces omit raw queries and source prose.
- **No embeddings:** lexical retrieval has no semantic network fallback. The
  existing model handles uncertain tool selection; embeddings require measured
  misses that justify them.

**Current source gaps:** no company privacy policy; no fixed shipping-price
parameter (the shipping policy describes variable charges); some FAQ answers are
too long for the small-record boundary. Unavailable facts require clarification
or customer service. The storefront does not execute cancellations, determine an
individual return eligibility, verify an offer or read any customer/order record.

**Checks:** `knowledge-cases.mjs` holds French routing and result expectations.
`npm run eval:storefront-knowledge` checks current sources without models or writes;
15/15 passed on 2026-10-06, with warm medians 0.59 ms initially and 3.03 ms during
parallel checks. This measures
retrieval, not generated reply correctness or widget latency. The live widget
review is tracked in `VALIDATION_LOG.md` item 45.

## Phase 3 (still in place): read-only product tools

- **Tools:** `search_products({ query, collection, limit })` (up to 8, best first) and `get_product({ handle })`. `collection` is an enum of the team's **active advice collections** (28 today), so the model filters on curated lists instead of guessing words.
- **Data:** `product-repository.mjs` reads named columns of **active, published, non-deleted** products (about 100), published product FAQ snapshots and active collections, whole, every 5 minutes. It never reads the raw payload, unrestricted metafields or stock counts. Stock is a yes/no, and prices are formatted in `STOREFRONT_CHAT_CURRENCY` (EUR).
- **Cards:** the model names a handle and a one-phrase reason. The name, price and link come from the catalogue, and only for products a tool returned (or the page's own product). At most 3. **Images are not shown yet: the product sync stores none.**
- **Speed, by design:**
  - On a product page, that product is in the prompt, so one call answers questions about it (1.7 s).
  - Tools answer from memory, so no database round trip.
  - Several searches run in one round.
  - A forced answer comes after 2 rounds, with a note that the results are verified.
  - « Trouver mon soin » asks straight away and doesn't search.
  - The catalogue refresh is stale-while-revalidate.
  - The service's database calls run in parallel, and the question is logged while the model thinks.
  - Each reply row logs `context.trace`: ms per model call, plus each tool call and how many products it found.
  - Measured: 2–4 s for a search and an answer, occasionally 6 s.
- `STOREFRONT_CHAT_TOOLS=off` withholds the catalogue, which is Phase 2 again.

## Phase 2 (still in place)

- **`STOREFRONT_CHAT_AGENT=llm`** turns the model on (the default `mock` keeps the Phase 1 replies). Opt-in, because the production dashboard carries the same route.
- **Model:** `STOREFRONT_CHAT_MODEL`, default `gpt-6-luna` (owner's choice, 2026-10-05), on the existing `OPENAI_API_KEY`. Measured: about 560 input and 60–190 output tokens, about $0.0001 a reply, 1.6–3.5 s.
- **Prompt** (`system-prompt.mjs`): brand name and description from the shop's data, the reply in the language of the customer's latest message (French by default, with *vous*), and plain text. It never states a product, price, stock, offer, delivery time or return condition. Health questions go to a professional, orders and product reactions to customer service, and it never asks for personal data.
- **Bounded wait:** each request is cut at `STOREFRONT_CHAT_TIMEOUT_MS` (12 s) under a wall-clock deadline 1 s longer, and a rate limit is not waited out. A failure answers 503 and the widget offers « Réessayer ».
- **Logged:** model and tokens on each assistant row of `storefront_chat_messages`. Nothing goes to `llm_usage`, which is the support pipeline's ledger.

## Phase 1 (still in place)

- **Widget:** launcher, panel, customer and advisor bubbles, typing state, error with retry, 5 quick actions, product card component (demo card on « Trouver mon soin »), phone full-screen sheet, history kept per browser tab (`sessionStorage`).
- **Embed setting « Replies »:** `Demo` answers in the browser with no backend. `Server` goes through the app proxy to the mock agent.
- **Sent with each message:** message, quick action, page type, product handle, collection handle, locale, country/market/currency, selected variant, logged-in boolean and path (query string dropped). Shopping turns additionally send a whitelisted cart snapshot; no token, notes, properties, customer identity or order data. Cart payloads are ephemeral and are not stored in session/message context.

## Agent tools

Conversation language is persisted as `context.replyLanguage` on assistant messages
in the existing log. Neutral destinations, yes/no, numbers and chip answers retain
it; substantive messages and explicit language requests can change it. Older sessions
without metadata use their conversation history. “France” also continues an immediate
delivery question deterministically. Customer-facing cart listings omit internal
snapshot verification and irrelevant missing variant metadata.

### Current cart, stock and public promotions (2026-10-06)

No new schema or sync changes. `advisor-cart.js` is the shared browser/server
whitelist; `advisor-panel.js` reads Shopify's locale-aware `GET cart.js` for shopping
messages, with a 1.5-second timeout. Failure leaves normal chat usable. The backend
validates the snapshot again; malformed carts and carts over 40 lines are withheld
whole, never partially evaluated. The request body cap is 32 KiB.

| Tool | Input | Structured result |
| --- | --- | --- |
| `get_cart_context` | none; current turn only | stable internal product IDs when mapped, Shopify product/variant IDs, bounded observed product/variant labels with name provenance, quantities, unit/line prices, subtotals, total, currency, country/market, observed public discounts/codes |
| `get_stock_context` | optional resolved `product_ids`, `variant_id`, `quantity` | per-variant requested/available quantity, status, sync timestamp; cart variants by default |
| `get_active_promotions` | optional bounded `limit`, `topic=non_shipping/free_shipping` | current public offers, method, code, reward, minimum, dates; shipping topic additionally returns published destination terms, never a delivery cost estimate or cart eligibility |
| `evaluate_promotions_for_cart` | optional shopper-supplied `code` or public `promotion_ids` | applied/eligible/not_eligible/unknown, reason, remaining requirements, product scope and pairwise stacking results |

The opening route uses lexical intent, the existing product resolver, and one lazy
shopping reader shared with subsequent tool calls. Payment methods stay with
policies/FAQs. Explicit product references override passive cart/page context;
whole-cart stock checks aggregate duplicate variants. Money is converted from
Shopify Ajax's monetary integers to major units exactly once.

Cart labels remain visible even when the signed shop is unsynced. The browser
keeps only bounded plain `product_title` and `variant_title`, not descriptions or
custom properties. Same-shop synced titles take precedence; otherwise labels are
marked `cart_observation`. The assistant may name these items without asking the
shopper to retype them, but suitability still needs product facts and skin context.
On a cart page, follow-ups such as “Are they adapted?” retrieve current cart data.

`shopping-repository.mjs` selects the shop by the **signed app-proxy domain**, not
the dashboard's catalogue shop. It reads existing variant JSON inventory quantities,
promotion classifications/rule snapshots and collection product-ID sets. Successful
snapshots are cached for 30 seconds; failures/missing shops are not cached, and no
expired snapshot is served during refresh. The cart itself is freshly observed for
each relevant message. No Shopify Admin calls, customer queries or order queries.

For an allow-listed unsynced shop different from the advice catalogue's shop,
`get_active_promotions` can use a separate public brand-offer reader. It queries only
the catalogue shop's approved public promotion rows and marks `offer_preview=true`,
`store_eligibility=not_confirmed`. This supports dev offer/term questions, including
free-shipping terms. It never supplies stock, cart mapping, applied discounts or cart
eligibility. An actual source outage does not trigger this preview. A synced shop
continues to use its own offers. Preview reads use the same 30-second freshness bound.

Code rows require `offerable_in_replies=true` in the database filter; automatic rows
require `describable_in_replies=true`. Raw cart discount labels and codes are never
passed through: only public database matches are named. Unknown/private reductions
are unnamed amounts. A reply backstop removes observed, previously mentioned and
recognizable invented codes unless a public tool result supplied them. An unlisted
code returns `no_public_promotion_match`, never a false claim that it is invalid.

The evaluator reuses `promotionMechanic`, `combinable`, and the common basket
threshold/outcome checks, with storefront guards and separate buy/reward quantity
accounting. It checks dates, usage limits when known, product/collection inclusion,
minimum quantities/spend, rewards in cart, current discounts and two-way stacking.
Unknown collection membership, customer/once-per-customer eligibility, app rules,
bundle/subscription pricing, ambiguous discount allocation or unmatched currencies
remain unknown. Restricted product scopes establish exclusions by non-membership;
unrecognized additional exclusion/variant conditions are withheld.

**Limits:** a browser cart snapshot is observed, not server-verified checkout state.
Failed codes entered only at checkout are not exposed by this cart read; the shopper
must supply them. Logged-in state is an observation, not proof of customer eligibility.
Synced inventory is not live availability/reservation; stock snapshots over 36 hours
old are withheld, and the answer identifies its sync date. Multi-variant products need
a selected/cart variant. Gift spend currency uses the existing configured catalogue
currency only when that catalogue and the signed shop match; no currency conversion.
Shipping promotion eligibility/calculations, cart writes, automatic code application
and history personalization are outside this layer. Published active free-shipping
offer terms can be read separately by topic; a country follow-up retains that topic.
This lookup does not estimate delivery costs or establish eligibility for a dev cart.

**Checks:** `shopping-cases.mjs` defines French expectations before any model call.
`shopping.test.mjs` covers these plus privacy, ID scoping, cache failures, output code
redaction, tool orchestration and stock quantities. `npm run inspect:storefront-shopping`
prints only source counts/timestamps. Dev-store end-to-end checks: validation item 46.

`resolve_products`, `search_products`, `get_product`, `get_policy`, `search_faqs`, `get_product_policy`, plus the four shopping tools above. The agent also receives the message, bounded page context and its own session's last 20 messages, each shortened to 1,500 characters.

## Database access permitted

| Who | What |
| --- | --- |
| Route/service (service role) | read/write `storefront_chat_sessions`, `storefront_chat_messages`; three RPCs (`_user_messages_since`, `_record_turn`, `_purge`) |
| Agent | **nothing directly**, and never SQL. Product tools read the catalogue. Knowledge tools read approved snapshots/product-scoped guidance. Shopping tools invoke `shopping-repository.mjs`, which reads named columns of `shops`, `products`, public `promotions`, and synced `advice_collections` membership for the signed shop only |
| Never | `customers`, `orders`, tickets, any SQL tool |

Sessions idle for longer than `STOREFRONT_CHAT_RETENTION_DAYS` (30) are purged, along with their messages.

## Remaining phases

| Phase | Adds |
| --- | --- |
| 2 | **built**: LLM reply, concise system prompt, no tools |
| 3 | **built**: `search_products`, `get_product` over a product repository (whitelisted columns, live products only) |
| 4 | **built (advice, 2026-10-07):** profile → brand playbooks → eligibility → suitability → routine fit → merchandising, routine builder, advisory events (§ Advice). `compare_products` still to build |
| 5 | **built:** general policies/FAQs, product guidance, read-only cart context, synced stock and deterministic public-promotion evaluation. Dev-store shopping reply validation remains open; routine builder deferred |
| 6 | `support_handoff` (email, order number, summary, transcript to the support system) |
| Later | carefully controlled order/customer access |

## Run and test on the dev store

1. **Link the app (once):** `cd storefront-app && shopify app config link`, choose *Create new app*, and pick the dev store's organisation. Keep the `[app_proxy]` block if the CLI rewrites the toml.
2. **Env** (repo-root `.env.local`; on Vercel only for a preview deploy): `STOREFRONT_APP_CLIENT_SECRET` (the advisor app's client secret) and `STOREFRONT_CHAT_ALLOWED_SHOPS=<dev-store>.myshopify.com`.
3. **Migration 76:** applied 2026-10-05.
4. **Run:** add `STOREFRONT_CHAT_AGENT=llm` to `.env.local` for AI replies, plus `STOREFRONT_CHAT_PRODUCT_BASE_URL=https://qiriness.com` (the dev store holds only a few of the catalogue's products, so cards link to the real product page in a new tab; leave it unset in production), then `cd storefront-app && shopify app dev`. That one command starts the dashboard's dev server (`backend/shopify.web.toml`), opens an HTTPS tunnel to it, points the app proxy at the tunnel, and serves the extension to the dev store.
5. **Turn it on:** Online Store → Themes → Customize → App embeds → *Beauty advisor*. Replies = Demo needs no backend; Replies = Server goes through the proxy.
6. **Without a store:** `npm run storefront:chat -- --message "Bonjour"` signs a request exactly as the proxy does. `--unsigned` expects 401, and `--shop other.myshopify.com` expects 403.

## Dev store: setup and removal

The dev store has its own products and discounts, so cart eligibility, stock and promotions can only be evaluated once they are copied into Supabase. **Everything here is dev-only and is listed below for removal.**

**Setup**
1. `storefront-app/shopify.app.toml` has read-only scopes (`read_products, read_inventory, read_discounts, read_metaobjects, read_metaobject_definitions`). Run `shopify app deploy` from `storefront-app/`, then approve the new permissions in the dev store admin.
2. Run `npm run dev-store:sync -- --dry-run`, then `npm run dev-store:sync`. This runs the production sync scripts against the dev store, with the advisor app's credentials, as a `development` shop row: products, stock, collections (all switched on, so collection-scoped discounts have a membership) and discounts. It never touches orders, customers or the production rows. Re-run it after changing the dev store, since nothing refreshes it automatically.
3. Set `STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN=<dev store>` in `.env.local` and unset `STOREFRONT_CHAT_PRODUCT_BASE_URL` (the products now exist on the dev store). Then restart `shopify app dev`.
   - Product FAQs stay the dashboard shop's. A dev product's FAQ lookup goes to the dashboard product **with the same handle** (`productPolicyReader` in `storefront-chat-service.ts`, dev only). A dev product whose handle exists only on the dev store has no FAQ.
4. The cart, stock and promotion tools read the widget's own shop, so they now find the dev shop. Brand, policies and FAQ stay the production shop's.

**Removal (when the advisor goes to production)**
1. `npm run dev-store:remove` (counts only), then `npm run dev-store:remove -- --yes`. This deletes the dev `shops` row; its products, collections and promotions cascade, and the dev chat sessions go too.
2. Delete `scripts/dev-store/` and the `dev-store:*` npm scripts.
3. In `.env.local`, unset `STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN`, `STOREFRONT_CHAT_PRODUCT_BASE_URL`, `STOREFRONT_DEV_STORE_DOMAIN` and `STOREFRONT_APP_CLIENT_ID`.
4. In the service, `devCatalogueShopId` (`web/lib/server/storefront-chat-service.ts`) returns null when its env is unset. It can stay, or be deleted along with its two call sites.
5. Set `storefront-app/shopify.app.toml` scopes back to `""`, or retire the dev app entirely.
