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
   product-repository.mjs                           the ONLY reader of products / advice_collections
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

## Phase 3 (still in place): read-only product tools

- **Tools:** `search_products({ query, collection, limit })` (up to 8, best first) and `get_product({ handle })`. `collection` is an enum of the team's **active advice collections** (28 today), so the model filters on curated lists instead of guessing words.
- **Data:** `product-repository.mjs` reads named columns of **active, published, non-deleted** products (about 100) and active collections, whole, every 5 minutes. It never reads the raw payload, metafields or stock counts. Stock is a yes/no, and prices are formatted in `STOREFRONT_CHAT_CURRENCY` (EUR).
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
- **Sent with each message:** message, quick action, page type, product handle, collection handle, locale, path (query string dropped). Never sent: cart, customer, order.

## Agent tools

`search_products`, `get_product` (above). The agent also receives the message, the page context (page type, handles, locale, plus the page's product from the catalogue) and its own session's last 20 messages, each shortened to 1,500 characters.

## Database access permitted

| Who | What |
| --- | --- |
| Route/service (service role) | read/write `storefront_chat_sessions`, `storefront_chat_messages`; three RPCs (`_user_messages_since`, `_record_turn`, `_purge`) |
| Agent | **nothing directly**, and never SQL. Its two tools read an in-memory catalogue that `product-repository.mjs` loaded from named columns of `products` and `advice_collections` |
| Never | `customers`, `orders`, tickets, any SQL tool |

Sessions idle for longer than `STOREFRONT_CHAT_RETENTION_DAYS` (30) are purged, along with their messages.

## Remaining phases

| Phase | Adds |
| --- | --- |
| 2 | **built**: LLM reply, concise system prompt, no tools |
| 3 | **built**: `search_products`, `get_product` over a product repository (whitelisted columns, live products only) |
| 4 | recommendation service (structured needs → ranked products → LLM explains); `compare_products` |
| 5 | promotions, delivery and returns policies, cart context, routine builder |
| 6 | `support_handoff` (email, order number, summary, transcript to the support system) |
| Later | carefully controlled order/customer access |

## Run and test on the dev store

1. **Link the app (once):** `cd storefront-app && shopify app config link`, choose *Create new app*, and pick the dev store's organisation. Keep the `[app_proxy]` block if the CLI rewrites the toml.
2. **Env** (repo-root `.env.local`; on Vercel only for a preview deploy): `STOREFRONT_APP_CLIENT_SECRET` (the advisor app's client secret) and `STOREFRONT_CHAT_ALLOWED_SHOPS=<dev-store>.myshopify.com`.
3. **Migration 76:** applied 2026-10-05.
4. **Run:** add `STOREFRONT_CHAT_AGENT=llm` to `.env.local` for AI replies, plus `STOREFRONT_CHAT_PRODUCT_BASE_URL=https://qiriness.com` (the dev store holds only a few of the catalogue's products, so cards link to the real product page in a new tab; leave it unset in production), then `cd storefront-app && shopify app dev`. That one command starts the dashboard's dev server (`backend/shopify.web.toml`), opens an HTTPS tunnel to it, points the app proxy at the tunnel, and serves the extension to the dev store.
5. **Turn it on:** Online Store → Themes → Customize → App embeds → *Beauty advisor*. Replies = Demo needs no backend; Replies = Server goes through the proxy.
6. **Without a store:** `npm run storefront:chat -- --message "Bonjour"` signs a request exactly as the proxy does. `--unsigned` expects 401, and `--shop other.myshopify.com` expects 403.
