<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Storefront advisor

### The lexicon has a model backup, not a model replacement (2026-10-12)

The lexicon stays first because it is instant, free and testable. It reads a customer's words into the profile before the one reply call, so the engine (not the model) decides the advice. Its weakness is coverage, and a partial reading is worse than none: « tight and dull » read as « dull » produced a firming serum, and the reply model, handed finished advice, did not correct it.

- **The lexicon reports its own gaps.** Content words that no pattern, marker or filler explains are its `residue`. An empty residue means the lexicon read the whole message.
- **The model reads only what the lexicon could not**, and only for the consultation. A chip, a product question, a policy or cart question, or a message with nothing about the skin never pays for the call. On the stored dev-store messages, 4 % do.
- **It writes the same values, at a lower rank.** Its updates are `model_inferred`, so a phrase the lexicon read is never overridden. It only fills gaps.
- **It never holds the turn.** A 2.5 s cap, with reasoning off. Readings at the default effort took up to 4 s for no better result.
- **The `advise` tool stays.** The reply model can still correct the profile. The reader only makes sure the advice it is handed was computed from the whole message.

### French and English are the minimum, for every layer (2026-10-12)

French and English together are about 99 % of customers, and the owner made both the bar for anything built in the chatbot. A feature counts as done only once both work. Most of the chatbot decides before the model (lexicon, routing, resolution, chips), so a French-only rule fails silently in English: no error, just a vaguer reply. Measured on 2026-10-12, English resolved 34 of 52 product mentions and extracted no skin type from « very dry and dehydrated skin ».

- **Language words live in tables, one per language, with the same keys.** `advisory/lexicon-fr.mjs` and `lexicon-en.mjs` share one engine (`lexicon.mjs`). A test fails when one table has a key the other lacks. A new language is a new table, not new code.
- **Every table runs on every message.** Customers mix languages (« j'ai des dark spots »), and a one-word answer carries no language.
- **Deterministic text follows the customer, not the store.** Chips use the message's language, then the conversation's, then the page's. Labels exist for every value in both languages, and a test checks it.
- **Words map to the catalogue's language, never the reverse.** Care words (`toCatalogueWords`) and ingredients (`ingredients.mjs`) are groups of equivalents. The customer's word becomes the form the catalogue uses, so an English-titled shop needs no change. Brand and product names are never translated.
- **Lexical matching against French-only content is told so.** FAQ entries are French, so an English question cannot match them word for word. The model is told the FAQ language (from the data) and searches in it. A product FAQ with no shared word returns all its entries.
- **Every test set covers both languages.** The advice, resolution, policy-routing and shopping-opening cases each have an English version, and a feature without one is not finished.

### Neutral replies retain the conversation language (2026-10-06)

The owner reported an English cart/shipping conversation switching to French
after “France”. The prompt explicitly defaulted short/unclear messages to French,
and the destination continuation only recognized prepositions such as “en France”.
Regression tests reproduced both gaps. The model now returns a bounded BCP 47
reply language, stored in existing assistant context JSON; neutral country/ISO,
yes/no, number, emoji and clarification answers reuse that language. For old rows
without metadata the prompt uses conversation history. Explicit language requests
or substantive language changes still win. No new table or language-detection call.

Bare country answers continue only the immediate assistant's delivery topic,
not an older delivery discussion after a topic change. Internal cart verification
and missing variant metadata should not appear in simple cart listings; a limitation
is explained only when it affects the question. The dev shop still lacks synced
promotion rules. For dev testing, public brand offers now have a separate read-only
preview path for an allow-listed unsynced shop. It reads only the catalogue shop's
public promotion rows and explicitly leaves store/cart eligibility unconfirmed.
Only `get_active_promotions` may use that path; stock, cart identities and eligibility
never borrow production data. A source outage does not trigger preview. This lets
the dev advisor describe the brand's public offers without creating false eligibility.

The reported free-shipping question also exposed a lookup gap: current offer listing
excluded shipping offers entirely. An explicit `free_shipping` topic now reads only
published public promotion terms (dates, threshold, destinations), never rates or
estimated costs. It remains separate from shipping eligibility, which is not implemented.

### Shopping uses the signed shop and existing public promotion gates (2026-10-06)

**Cart labels must survive without a synced shop (2026-10-06 fix).** The owner
reported counts arriving but names missing for cart suitability questions. The
browser whitelist discarded `product_title`/`variant_title`, and the tool sourced
names exclusively from synced products. An integration regression using both
reported messages reproduced this before the fix. Keep bounded, plain cart labels
through browser/backend validation and mark their source as `cart_observation`.
Same-shop synced names take precedence. Observed labels are sufficient to name
cart contents, not to establish catalogue identity, ingredients, suitability or
stock. Cart-page pronoun/suitability follow-ups also retrieve fresh cart context;
payment FAQs still avoid cart reads. No cross-shop mapping or new API is needed.

The current dev widget uses the production advice catalogue. That is acceptable
for product discovery links, but a dev cart's Shopify IDs cannot safely be checked
against production stock or promotion rules. A read-only source check found the
dev shop has no synced shopping data. The new shopping reader therefore keys on
the signed proxy shop domain and returns unavailable for that shop; no title/handle
cross-store mapping or production fallback. Existing promotions, variant JSON and
collection membership are sufficient; no schema redesign or customer-history read.

Public code rows are filtered by the existing merchant `offerable_in_replies` flag
before retrieval. Automatic offers use `describable_in_replies`. Raw cart labels
can contain a private code, so unknown discounts become unnamed amounts rather
than being echoed. Only public codes returned by tools can survive the reply code
backstop; absence from public records is not evidence a code is invalid.

The proxy proves the shop, not the browser's posted cart. Shopify Ajax snapshots
are whitelisted on both sides, transient, and explicitly unverified; no token,
properties or personal data. Failed checkout-only entered codes are unavailable
unless the shopper supplies them. Synced variant quantities and timestamps are
the existing stock source; a 36-hour freshness guard covers the daily sync cadence
without claiming live availability. Missing selected variants, stale inventory,
restricted customer eligibility, unsupported app/bundle rules and currency or
discount-allocation ambiguity are unknown. Shopify checkout remains final authority.

The existing support classifier, combination flags and common basket checks are
reused without changing support behavior. Buy/reward quantities need a separate
storefront guard: support's multi-buy path assumes overlapping scopes, while a
current cart can contain distinct purchase and reward products. Shipping and any
checkout mutations remain outside this layer.

### A separate Shopify app, in its own directory (2026-10-05)

The support app (`shopify.app.toml`, client_id `1d69…`) is installed on the production store, `qiriness.myshopify.com`. A theme app extension shipped through it would appear in the production theme editor. The app proxy is app-wide config, so adding one would add it to production too. The advisor is therefore **its own app** (`storefront-app/shopify.app.toml`), installed on the dev store only. It sits in **its own CLI project directory** because the Shopify CLI deploys every extension under the project it runs in: with the extension under the repo root, a routine `shopify app deploy` of the support app would carry it to production. The directory boundary makes that impossible rather than merely discouraged.

The route's **shop allow-list** (`STOREFRONT_CHAT_ALLOWED_SHOPS`, where empty serves no shop) is the second guard. A production request would be refused with 403 even if the advisor app were installed there by mistake.

### The app proxy, not a direct call to the backend

The browser posts to `/apps/storefront-advisor/chat` on its own storefront domain. That needs no CORS, and no backend URL appears in theme code (the URL lives in the advisor app's toml). Shopify signs every proxied query with the app secret, which proves the request came through a store and names which one. A direct fetch to Vercel would have needed an open CORS origin and something else to prove the shop. The proxy strips cookies, so the session travels in the body. The token is **minted server-side**: one the browser sends is honoured only if it names an active session of the same shop.

### No SQL tool, ever, for the customer-facing agent

The management chat lets its model write SQL, as a read-only role over curated views (§ Management chat). That works because its users are signed-in staff. The storefront agent talks to the public internet, so it gets **narrow, typed, read-only functions** (Phase 3: `search_products`, `get_product` through a product repository returning whitelisted fields) and never a query language or a database handle. It never reads customers or orders. « Where is my order? » is answered by pointing to customer service until a handoff tool exists.

### Caps before the model

The per-session turn cap and the per-shop daily cap on customer messages ship in Phase 1, while replies are still mocked. Attaching an LLM in Phase 2 then attaches it behind a door that is already limited, rather than leaving the limit as an afterthought on a public, paid endpoint.

### The loader is small because Theme Check says so

App-embed JavaScript is capped at 10 KB by Theme Check (`AssetSizeAppBlockJavaScript`), and the full widget was 16 KB. Only the launcher loads on every page (`advisor.js`, about 4 KB). The panel (`advisor-panel.js`) is fetched on first open, or straight away on desktop when the previous page left it open. A visitor who never opens the advisor pays only for the launcher.

### Nothing brand-specific in the code

The header reads « Conseiller Beauté {shop} », filled from `shop.name`. The proxy subpath is `storefront-advisor`, and the strings live in the extension's locale files. Another shop installs the same extension unchanged.

### Phase 2: one model call, opt-in, bounded (2026-10-05)

- **Opt-in by `STOREFRONT_CHAT_AGENT=llm`.** The production dashboard carries `/api/storefront/chat` too. A key being set must never be what starts storefront spend.
- **`gpt-6-luna` by default** (the owner's choice, same day). The first model was `gpt-4o-mini`: 2–5 s, about 570 input and 40 output tokens, $0.0001 a reply. `gpt-6-luna` on the same eight questions: 1.6–3.5 s, about 560 input and 60–190 output tokens (its reasoning counts as output), and about the same $0.0001 at $0.10 / $0.50 per million. That is under 6 cents a day at the 500-message cap, with the same rule-following and more natural French. The shared client treats it as a reasoning model (no `temperature`, a 4,000-token output ceiling), which costs only the tokens actually produced.
- **A shopper does not wait out a rate limit.** The worker's client waits up to two minutes on a 429. Here a request is cut at 12 s, the retry wait is refused, and a wall-clock deadline sits on top: one live request ran 51 s behind Next's patched `fetch`. A failure answers 503, and the widget shows « Réessayer ».
- **The prompt is in English.** A French prompt saying « réponds dans la langue du client » answered English and Spanish questions in French on gpt-4o-mini (3 of 3). In English it answered in the customer's language, though declines still came back in French until the rule said it covers declines too. French stays the default for a message that gives no clue (« Bonjour », a French button label).
- **The prompt forbids, per phase, what the agent cannot know.** Products, prices, stock, offers, delivery and returns are all forbidden now. Each later phase relaxes exactly the rule its tool makes answerable, and nothing is left for the model to know from training.
- **Spend is on the message row, not in `llm_usage`.** `llm_usage` is the support pipeline's ledger, constrained to its passes. Each assistant row carries its model and tokens, which is enough to price the advisor separately.

### Phase 3: read-only product tools, built for reply speed (2026-10-05)

- **The catalogue is held in memory, whole.** It's about 100 live products and 28 active collections, read once every 5 minutes by `product-repository.mjs` (about 1 s) and refreshed stale-while-revalidate. A tool call therefore costs no database round trip, and the reply time is the model's alone.
- **The repository is the only reader**, column by column. The raw Shopify payload is never read: the review badge HTML lives in `structured_facts`. Stock reaches the model only as in stock or not.
- **`collection` is an enum of the team's active advice collections.** The model filters on curated lists (« Peaux Sensibles », « Sérums Visage ») rather than guessing words, and in the live check it chose a collection on every product question.
- **The page's product goes into the prompt.** « Est-ce que ça convient aux peaux sensibles ? » on a product page is one call (1.7 s), not a lookup and then an answer.
- **At most 2 tool rounds, then a forced answer with a note.** Without the note, after two good searches the model answered « je ne peux pas vérifier » with no card (measured). Asked to request several searches in one step, it ran two collections in parallel: one round, not two.
- **No search before a need is known.** « Construire ma routine » used to spend two searches and then ask a question anyway (3 calls). Now it is one call and the question.
- **A card is only ever a product a tool returned.** The model writes a handle and a reason, and the catalogue writes the name, price and link. A handle the model invents is dropped.
- **In stock first.** The only matching anti-taches sérum was out of stock. Before the in-stock rule, it was suggested alone. Now it's named as unavailable, and an in-stock alternative is shown as a card.
- **No images yet.** The product sync stores none (`raw_shopify_payload` has no `featuredImage`), so cards use the placeholder until the sync reads one.
- **Measured through the route:** 2–4 s for a search plus an answer, about 2 s with no tool call, and an occasional 6 s on a slow OpenAI call. About 1,800 input tokens per call: the tool definitions and the collection list are a stable prefix, eligible for prompt caching.

### Product resolution: which products, before the model (2026-10-06)

- **Resolution is not discovery.** « la crème Source d'Eau Riche » and « les deux » are references to settle; « quels sérums anti-âge ? » is a search. `resolve_products` and `search_products` are separate tools, and later tools (compare, ingredients, routine) take the resolved `id`s.
- **It runs before the model, deterministically** (median 0.5 ms). A named product, a clarification answer or « ça » on a product page costs one model call and no tool (measured 1.7–2.4 s).
- **No hand-written vocabulary.** On this catalogue the title's last segment is the commercial name customers use (« … – Caresse Source d'Eau Riche »), and the head noun is the care type. Brand synonyms are learned as the head noun most of a commercial prefix's products share (Élixir → Sérum, Caresse → Crème, Wrap → Masque, Rituel → Coffret). The unit tests run on an invented brand to keep it that way. The owner asked for this (« don't hardcode any of this into the prompt »).
- **Identity words versus attribute words.** A word is identity when at least half its title occurrences are in commercial names. Even so, « temps » and « parfum » are ordinary French, so **a lone name word needs a care word just before it**: « combien de temps », « sans parfum » and « la lune est belle » never resolve, while « le masque Hyal-Aqua » and « la Lip Beauty » (two words) do. Description frequency was measured as an alternative and rejected: it would demote « riche » (25 other descriptions, 2 titles) and miss « temps » (3:12).
- **Typo correction follows how people mistype:** a dropped, swapped or doubled letter, never a stray extra one. « matin » corrected to « main » broke a page question. Grammar words (« trois », « premier ») are never corrected: « trois » once became « trio ».
- **Never a silent pick; the clarification is data.** Three or fewer candidates, or candidates that share one care type, give `choose_product` with the top 3. More, across several types, gives `choose_care_type` (« Crème / Coffret / Sérum »). Labels are the commercial name when unique and still containing the customer's words, else care type plus last segment (« Crème Source d'Eau 50 ml »). Chips send a `choice`, so the answer resolves by id with no re-parsing. The prompt carries only the generic rule « ask it with exactly its options ».
- **A plural the memory can't satisfy is reported, not filled.** After one card, « les deux premiers » made the model search and describe a second product the customer had never seen. The resolver now returns the one product plus the cue as unresolved, and the model asked which two.
- **SKUs can sit on two listings** (the 50 ml multi-size listing reuses E046N). The listing where the SKU stands alone wins; otherwise the result is ambiguous.
- **Memory lives on the assistant row** (`context.refs`, `context.resolution`), so the question can still be logged in parallel with the model call. No table. Curated aliases wait for a measured miss that only an alias can fix.
- **Samples left the advisor's catalogue.** They're excluded through the support matcher's own `isCustomerFacing`. Phase 3 had included the 9 `SAMPLE PRODUCT` rows.

### A range is a collection the team marks « Gamme » (2026-10-06)

- **Ranges used to be guessed from titles.** « toute la gamme Source d'Eau » meant every live title containing « source » and « eau ». That works while every line repeats its name in every title. It drifts when one doesn't, and when a word is shared by accident.
- **The shop already curates them in Shopify:** « Temps Sublime » (11 products), « Source d'Eau » (6), « Active Énergie » (5), « Exception » (4). They were inactive in `advice_collections`, because the only axes were concern and category.
- **So `axis` gained `range`** (migration 77, chosen in Agent setup → « What we can advise on »). An active range collection is **the** membership of « la gamme X »: the resolver checks the curated ranges first, taking the most specific one the customer's words cover. The title-derived range is the fallback for a line nobody curated. The resolution's `range.source` says which was used.
- **The support agent ignores ranges** (`supportCollections` in `advice-collections.mjs`). Its intersection treats every non-category collection as a concern, so a range there would silently become a ranking requirement. Whether support should read ranges is its own decision.
- **Membership needs the collection active.** `product_ids` is refreshed for active collections only (§ Advice comes from collections), so a range is read only after it is switched on and synced.

### Storefront knowledge adapts existing storage (2026-10-06)

The owner explicitly asked to preserve policy/FAQ storage because support already
depends on it. The storefront therefore has its own read-only adapter, topic/key
bindings and runtime FAQ records. No shared writer, editor, support retrieval or
schema changes. The live inventory found 15 active policies and existing parameter
references; structured delivery/return/refund facts use those references and the
existing typed parsers rather than extracting numbers from prose.

**A number alone is not the policy.** `shipping_cost_policy` says free delivery
may be offered periodically above `{free_shipping_threshold}` in France. Returning
that number as unconditional free shipping would change the rule. Facts therefore
travel with bounded source passages, applicability, restrictions and source versions.
Missing/invalid parameters withhold the policy. The existing historical returns
contradiction is not copied: the current company return policy is the source.

**FAQ is intent; policy is authority.** A policy-related heading redirects to the
bound company policy and drops its embedded answer. General FAQ retrieval excludes
product-linked documents. Product guidance requires a resolved product ID and
catalogue facts already supplied in the turn; the reader filters by that ID, lazily.
Published Shopify product FAQs are part of catalogue facts, before curated guidance.

**Conservative lexical retrieval first.** Exact questions and explicit leading
question aliases precede keyword/topic and single-edit fuzzy matching. A broad topic
never selects an answer alone. Ties return clarification questions, oversized units
are withheld whole, and no embeddings are added. 15/15 live retrieval checks passed
with a warm median of 0.59 ms; generated replies and widget latency remain to review.

**Freshness is bounded.** General knowledge and per-product guidance expire after
five minutes. An agent may retain a catalogue while its background refresh fails,
but it cannot keep answering policies from an expired knowledge snapshot. Source
failure returns unavailable and transport details never reach the model.

### Free delivery is evaluated against the cart; codes stay private (2026-10-06)

- **Measured on the synced dev store.** Its only public offer is automatic free delivery (FR, from €70). « Quelles sont les offres du moment ? » answered « aucune offre », because the listing excluded shipping offers by default. « Mon panier a-t-il droit à la livraison gratuite ? » on an €80.78 cart answered « je ne peux pas confirmer », because shipping eligibility had been recorded as « not implemented ».
- **The listing now includes free delivery by default** (`topic: all`), with its published terms and `delivery_cost: not_calculated`.
- **Free delivery is evaluated on its minimum only.** The cart total after discounts is compared with the threshold:
  - met → `eligible` with the destination as a condition (« si livraison en France »);
  - short → `not_eligible` with the exact amount missing (€58.17 on €11.83);
  - an order discount between total and subtotal → `unknown`, not guessed;
  - another currency, or an offer limited to some customers → `unknown`.
  - It never gives a delivery cost.
- **Codes are not volunteered** (owner, 2026-10-06: « codes are not usually publicly disclosed »). The advisor talks about the offers the website shows, i.e. the automatic ones. The 5 dev codes stay `offerable_in_replies = false`, and a code the shopper types is still evaluated under the existing rule.

### Codes the shopper entered are named back; one product discount per line (2026-10-06)

- **A code already applied in this cart is named back to the shopper,** even when it isn't shareable (QIRINESS20 and BIENVENUE20 on the dev store showed as « Réduction appliquée »). Naming back a code they typed discloses nothing to them, and without it stacking could not be judged.
  - The shop's active codes are read into a separate `cartCodeRows`, used **only** to recognise a code applied in the cart.
  - Those rows never enter the offer listing or an evaluation. The repository test asserts it.
  - Public codes keep the `offerable_in_replies` gate. « Does X work? » about such a code is answered `applied` when it is in the cart, and stays `not_found` otherwise.
- **Shopify applies one product discount per cart line by default** (`productDiscountsWithTagsOnSameCartLine` is Plus only, and the dev store doesn't use it). September Rose (30 %) was « eligible » by its combination flags while both its lines already held a product discount (the 2-for-1 and the gift).
  - The widget now sends each line's discount names (`discountTitles`).
  - A product discount whose every target line already carries another one is `not_eligible`, reason `line_already_discounted`, with `blocked_by` naming the blockers.
- **A follow-up carries the cart:** after a reply that used the cart, the widget sends it with the next message. The server treats a carted follow-up to a shopping reply as a shopping question.
- **An amount or a name points at the offer meant.** « 30 % » or an offer's title evaluates that offer on its own (`mentioned_by_customer`). Left to the model, the link was made on one run and missed on the next. After the change it was made 3 runs out of 3.
- **Product, offer and code names are never translated.** An English reply had invented « Revitalising Body Spa Ritual Kit ».

### A product's own FAQ is read whole when no question matches (2026-10-07)

Product FAQs are scoped to one product the customer has named, and small (the LED mask has 12 entries). The keyword matcher stays first, because a clean single match is the cheapest and most precise answer. But it reads the questions only, and customers ask in words the headings don't use. Failing that, the model gets the product's entries sharing words with the question, answers included, capped at 6,000 characters. Reading a few entries is what the model does well; « not found » with the answer in hand is not acceptable. General FAQs (not product-scoped) keep the strict matcher: across the whole knowledge base, a loose match would pick the wrong topic.

### A code the advisor cannot see is reasoned about from the cart (2026-10-07)

A private code stays private: its rules are never read for the customer, and the reply never says it exists, is valid or what it gives. But « je ne peux pas confirmer » alone is not an answer when the cart holds the likely reason. An applied offer whose `combines_with` refuses a class blocks any new discount of that class, whatever the code is. So a not-found code comes with `cart_reasoning`:
- the applied offers that refuse new order, product or shipping discounts;
- whether the 5-code limit is reached;
- otherwise, the usual hidden conditions.

The customer's own typed code may be repeated back; it discloses nothing to them.

### The advisor speaks as the shop, never as its platform (2026-10-07)

The owner's rule: customers never hear « Shopify » (nor Alpha, apps or tool names). Replies say « votre panier », « automatiquement », « la plus avantageuse pour votre panier a été retenue ». The platform's rules still drive every verdict; only the wording is the shop's. Internal prompt lines may name Shopify to explain the data to the model, never as customer wording.

### The agent is never served past its knowledge's lifetime (2026-10-07)

Stale-while-refresh was right for the catalogue but wrong for policies: `getPolicy` refuses knowledge older than `KNOWLEDGE_TTL_MS`, and the agent's lifetime was the same five minutes. So the first customer after any pause got « no reliable information » on every policy. The agent now refreshes one minute ahead, and one past its lifetime is awaited (about a second, only after five idle minutes) rather than served. The five-minute edit boundary is kept.

### A shopping question with a cart always evaluates it (2026-10-07)

The opening's word lists decide which tools run, and they missed an ordinary English question. When the shopping route is taken with a cart and the lists select nothing, the cart and a full evaluation are fetched anyway: a wasted read costs milliseconds, a missed one costs a « cannot confirm ». Every cart evaluation also carries `simulate_offers`, because « why this offer and not that one » is answered by the combination, not by any single verdict.

### The advisor follows Shopify's discount rules, not the shared outcome check (2026-10-06)

The rules are researched in `docs/shopify-discount-rules.md`; this is why the evaluator encodes them itself.

- **An applied Buy X Get Y locks its « buys » line too.** `cart.js` allocates the discount to the « gets » line only, so the per-line check saw the cream under TEST02 as free and called September Rose eligible on it. On non-Plus, Shopify excludes both items. The lock is read from the applied offer's scopes, not from the allocations. A `shopifyPlus` option exists (default false) and leaves only the « buys » line locked.
- **Each money minimum is measured the way Shopify measures it for that class** (order: before AND after product discounts; product: after other product discounts; Buy X Get Y: « buys » items at full price). The shared check in `agent/src/retrieval/promotion-outcome.mjs` (support replies) answers `undetermined` whenever a cart straddles a minimum before and after discounts. Here the cart's own allocations are known, so the straddle is decidable. The support side is left as it is: it judges orders, where those allocations are not always in hand.
- **Which offers apply together is solved, not guessed.** Shopify keeps the allowed combination with the largest saving, which no per-offer verdict can show. Carts are small and offers few, so an exhaustive search (≤ 10 offers) is cheaper and more predictable than any heuristic. It is exposed as a tool (`simulate_offers`), not run on every turn, because only « what would apply / what if I add » questions need it.
  - Only automatic offers and codes **already entered** are reached: Shopify applies no code nobody typed, and the advisor never offers a private one.
  - On a real cart, Shopify's result in the cart wins. The solver flags a disagreement rather than overriding it.
- **A sale price is the price.** Promotions are computed on the current variant price (an Alpha sale included); compare-at is display only. It is synced so the advisor can say « already on sale », never to recompute a discount from it.

### The engine decides the advice; the model converses (2026-10-07)

- **Why not the old way.** Advice used to be `search_products` on a collection: the products that came up most often won. Nothing remembered the customer. Nothing encoded how Qiriness trains its advisers. Nothing separated « suits this customer » from « the brand wants to sell it ».
- **What replaces it.** A deterministic engine in `scripts/lib/advisory/`, with no model and no I/O:
  - a profile, where each field carries a value, source, confidence and turn;
  - the brand's playbooks;
  - eligibility, then suitability, then routine fit, then merchandising, with each term returned as reason codes.
  - It runs before the model, in about 0.1 ms. The model gets the advice as data, asks the one question it carries, or explains the routine from reason codes and product facts. A turn is one model call unless the lexicon missed something, and then the model calls `advise` with `profile_updates`.
- **The playbooks are the brand's, as data.** Qiriness supplied 11 routine playbooks (2026-10-07). `data/advisor/qiriness.json` transcribes them faithfully, and `npm run advisor:load` loads them into `advisor_playbooks` / `advisor_mappings` / `advisor_merchandising` (migration 80).
  - The prose rules are kept as `notes`. The model reads them as guidance, never as claims.
  - Keys marked `_added` are interpretations needed to execute them, and Qiriness should confirm them:
    - the concern lists of the men's routes;
    - their targeted slot;
    - `distinguish_by`, how a concern is offered when two playbooks tie.
- **No product id anywhere in the config.** Families map to range collections (« Active Énergie Lift » = the Active Énergie range narrowed by the name word « lift »). Slots map to category collections, care types (the title's head noun) and name words. Concerns, skin types, textures and areas map to tags and collections. `checkCatalogue` reports every reference that resolves to nothing, at load and in `eval:advisory`.
- **The user's eleven rules are tests, not intentions.** `advisory.test.mjs` has one test per rule on an invented brand. `eval:advisory` checks the same rules as invariants over every concern × skin type × sensitivity × target × scope × age × routine combination of the live catalogue: 3,936 profiles, 0 violations.
  - **Stock, area and target** are hard filters.
  - **Eye steps** in a face routine take eye products, because the slot carries its own area.
  - **Men's products only on an explicit request.** An unknown target means the main catalogue, never men's products.
  - **Age** adds at most 0.05 and is never read by playbook selection.
  - **Skin type picks the texture before any behaviour.** « mixte et déshydratée » first went to the standard cream because the dehydration group came first; skin type now wins.
  - **The current routine removes its steps.** « Targeted » picks the first priority step not already covered.
- **A treatment step must address the need.** On the 12-product dev catalogue, « premières rides » got the only serum there, an anti-spot one, recommended as « the best available ». Steps marked `concern_required` (serums, treatments, eye care, masks, lotions, the booster) now take only a product matching one of the customer's concerns or in the preferred family. A cleanser or cream may be generic. A targeted reply then moves to the next priority step and never mentions the step it passed over.
- **Merchandising cannot rescue an unsuitable product.**
  - A tier boost (at most 0.2) applies only to eligible products within `tie_window` (0.15) of the best suitability in that step, and never below the suitability floor.
  - A tolerance-first playbook (sensitive skin) boosts only products made for sensitive skin.
  - No priorities are loaded yet: Qiriness has given the tiers, not the products.
- **One question, and only one that changes something.**
  - **Selection gates:**
    - **Area, then primary concern**, with two exceptions: two plausible playbooks give one question built from the concerns that tell them apart; a skin type implies the face (« peau mixte et déshydratée » is not a body question).
  - **Questions in the routine builder:**
    - **Which field:** the next field in the brand's `selection_priority` whose possible answers would change the playbook, steps or products. This is checked by running the engine with each answer.
    - **Never asked:** sex and age. « Je ne sais pas » counts as an answer, and a field is never asked twice.
  - **Conversation mode** recommends at once, as soon as a playbook is selected.
- **Chips come from the engine, never the model.** Their value is `profile:<field>:<value>`, recorded with source `quick_choice`, and it outranks an inference. The resolver's « which product? » clarification wins over an advice question.
- **The profile lives on the assistant row** (`context.advisor`), folded back like `refs`. There is no table: the consultation is per conversation, and the message log already has retention.

### Advice is built to be lifted out for email, later (2026-10-07)

- **The rule.** `scripts/lib/advisory/` imports nothing outside itself (it carries its own `norm` and care type). Nothing outside the storefront advisor may import it yet. `isolation.test.mjs` enforces both rules.
- **Stays the same for email:**
  - profile, lexicon, config, selection, ranking, reason codes;
  - the event schema;
  - the config repository.
- **Changes for email:**
  - **Where the profile comes from:** a thread or case file instead of a turn.
  - **What a `next_question` becomes:** at most two questions in a draft, or stated assumptions (replies are asynchronous).
  - **How the advice is delivered:** drafting instead of cards and chips.
  - **Events:** `channel: 'email'`, with `conversation_ref` set to the ticket id.
- **Kept chat-only:** the chat glue (`advisor-tools.mjs`, `advisor-state.mjs`, the prompt section, the widget).
- **Not touched:** nothing in `agent/`, the support prompts or the dashboard changed. The only shared-app change is the middleware's public path for `/api/storefront/event`, which carries the same signature and allow-list as `/api/storefront/chat`.

### Advisory events are channel-aware and hold no words (2026-10-07)

- **Storage.** `advisory_events`: channel, conversation_ref, event_type, playbook_key, product_ids, payload (codes, counts, ids).
- **Writing.** Events are derived per turn from the state before and after (`turnEvents`) and written after the reply without being waited for. Card clicks arrive by beacon through `/apps/storefront-advisor/event`.
- **Shape.** There is no foreign key to sessions or shops (an email's conversation is a ticket), the same as 76. There is no customer identity, and no free text: `profile_field_collected` records the field and its source, not what was said.
- **Not built yet:**
  - `added_to_cart` (from the next cart snapshot);
  - `recommendation_abandoned` (derived later);
  - `purchase` (order attribution);
  - `unresolved_question` / `support_handoff`.
  - All four types are in the schema already. Dashboard integration is a separate task (`docs/storefront-chatbot.md` § Advice).
