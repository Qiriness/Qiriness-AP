<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Storefront advisor

### Purchase history: identity from the signature only (2026-10-13)

Purchase history (plan § 5) needs to know who is asking. Phase 0 settles who, and what may be read; nothing is read yet. Approved by the owner on 2026-10-13 when Phase 0 was started.

- **Identity is Shopify's signed `logged_in_customer_id`, and nothing else.** The app proxy adds it to the query it signs, and the route already verifies that signature. An email, an order number or the widget's `loggedIn` flag proves nothing: anyone can type someone else's. Not signed in means the anonymous advisor.
- **Off by default.** Unless `STOREFRONT_CHAT_PURCHASE_HISTORY=on`, every request is anonymous and the id goes no further than `customer-identity.mjs`. The same reason as `STOREFRONT_CHAT_AGENT`: the production dashboard carries this route, and a deploy must never start reading purchases on its own.
- **The id is never stored.** A conversation is bound to its customer by an HMAC of shop + id keyed with the app secret (`context.identity` on the assistant row, where the profile already lives, so no migration). A plain hash would not do: Shopify ids are sequential, so trying every id reverses it.
- **One conversation, one person.** A customer's session is continued only by that customer. Another account, or the same tab after signing out, gets a new session, so one person's purchases never reach the next person on a shared device. An anonymous conversation may be continued after signing in, because it holds nobody's purchases. The widget applies the same rule to the bubbles it keeps in `sessionStorage` (the theme's `customer.id`, on that customer's own page).
- **The rule « the agent never reads customers or orders » becomes « it reads only the signed-in customer's own purchase summary, through one narrow typed function ».** Still no SQL, and no other customer. `data-access.test.mjs` fails if any storefront file but the future `purchase-summary-repository.mjs` names the customer or order tables.
- **What the model may see is a shape, not a query.** `toPurchaseSummary` keeps product id, title, first and last purchase day, how many orders held it, returned and free-gift flags, and drops everything else. Addresses, emails, names, order numbers and amounts paid can never leave, even if a reader returns them. A €0 line is a promotional gift (about half of Wrap lines), never a preference.
- **Before anything was read** (done with Phase 1): each read is logged in `data_access_events`, the use is stated in `MERCHANT_DATA_USE_DISCLOSURE.md`, and marketplace orders are excluded. The shop's own privacy notice is the owner's to review.

### A slow reply says something, worded from the question (2026-10-14)

Measured on the customer batch (43 turns, live model): median 3.7 s, 90 % within 5.1 s; a turn where the model calls a tool takes about 1–1.5 s more. Streaming the reply was considered and set aside for now: the widget calls through the Shopify app proxy (which proves the signed-in customer) and it is not yet tested whether the proxy passes a streamed response through; the reply is also one JSON object, checked once complete.

- **What the widget does instead:** after 1.5 s without a reply the dots get « Je regarde ça pour vous… » / "Looking into it for you…" (« Je vérifie votre commande… » / "Checking your order…" when the message names an order, a parcel or an order number), and after 6 s « Encore un instant… » / "Just a moment more…". Code-written turns (under 0.1 s) never show it.
- **Worded from the customer's message, never from the server's work:** the widget only hears back once the whole answer is ready, so it cannot know whether a tool runs; a line that claimed one could be untrue. The texts are theme locale strings (FR, EN).
- **Next, if the proxy streams** (to test on the dev store): stream the reply's text, then the cards and buttons at the end.

### Adding to the cart: the customer's click, never the model's (2026-10-13)

The owner's design: « Ajouter la routine au panier » under a routine, and « Souhaitez-vous que je l'ajoute à votre panier ? » with « Oui, ajouter » / « Je cherche encore ».

- **The server never holds the customer's cart** (it lives in their browser session), so nothing is added server-side and the model has no cart tool. The widget adds, through the shop's `/cart/add.js`, on the customer's click only: the routine button, a card's button, or « Oui, ajouter » (then the reply carries `cart.add` and the widget adds it once, never on a re-render). Every add is recorded as `added_to_cart`.
- **Only products with one size to buy are added**; the others are named with « choisissez la taille sur sa page », since the size is the customer's choice.
- **The question is the code's** (routine-flow.mjs), like the routine offer: after a recommended routine (in place of the treat, which follows the answer) and after a single product once the routine offer has had its turn, never twice for the same product, never after top choices (« this » would be ambiguous). A typed « oui » or « je cherche encore » answers it. « Oui, ajouter » is a code-written turn with no model call. If the model builds the routine itself during its turn (through `advise`), the question is added after its reply.

### The routine engine follows the foundations (2026-10-13)

The owner's model (plan § 3.1–3.4): a routine is a foundation's ordered list of product TYPES, each step filled by the product of that type that best targets the customer's concern or combination of concerns. `scripts/lib/advisory/foundations.mjs`.

- **Everything is data**: the brand's routines (foundations, sizes, modules, the concern map, the question order, treats) and its product knowledge (type, concerns, skin types, texture, sensitivity, men, premium, treat, gift, kit). No Shopify tag decides a product's fit.
- **Side by side** (owner): `createAdvisor` uses the foundations when a shop has routines and product knowledge, the playbooks otherwise. The live shop keeps the playbooks until the spreadsheet is imported; the bench gets the foundations.
- **The foundation:** a concern chosen with a button decides. Otherwise each concern votes for its foundation and a tie goes to `foundation_priority` (proposed C, F, E, B, A, D; Qiriness to confirm). A dry skin is Hydration only when no other concern is there. Eye concerns alone are the eyes module; G only on « routine de base ».
- **Sizes are rules over the list:** essential = the daily required steps; complete = every daily step plus the relevant modules (eyes for an eye concern; SPF in Taches); spa adds the occasional steps; targeted is one (the type asked for, else the step that targets the concern). A small budget is essential, with no treat.
- **An owned type is not doubled** (owner): « j'utilise déjà un nettoyant » skips the cleanser step, unless that step is the one their concern needs (`targets: primary`): « j'ai un sérum hydratant mais des taches » still gets the anti-spot serum, with `concern_needs_specific_product` so the reply says why.
- **Hard rules before the score:** stock, « Ne pas conseiller », type and area, men's products only for a man, skin « Non adapté », « Déconseillé » for sensitive skin, the customer's exclusions, and a concern step needs a product that targets the concern (never pad). **The score:** the primary concern, the secondary ones, skin « Idéal », texture by skin type, the preferred range, premium only when a concern justifies it, men's first for a man, the customer's range.
- **§ 3.4:** « cadeau » gives gift sets first, « soirée spa » the spa treat routine, both new profile `request` values read by the lexicon (FR/EN).
- **Budget** (owner, 2026-10-13, replacing the plan's « small budget: no upsell »):
  - a small budget, said either way (« petit budget », « pas cher », or « c'est trop cher », « vous avez moins cher ? », "too expensive", "can't afford"), gets a « petit plaisir » for their concern INSTEAD of a routine, because treats are usually cheaper; no routine offer and no second treat after it;
  - a ceiling (« moins de 60 € », « 40 euros max », "under 60"; a number under 5 or followed by « ans », « produits », « étapes » is not a price) cuts the routine to fit: optional steps first, then the required ones that are not the concern's step, the concern's step last; what was left out is said (`over_budget`), and when even that step is over, a treat within the ceiling;
  - with a budget, the cheaper of two products within 0.15 of the best fit;
  - the routine's price (`total_price`) and each size's price on its button come from the engine; the model quotes them, never adds them up.
- **Outside the builder, a need gets our top choices** (owner, 2026-10-13): the best product of each type that targets that need (dehydration: a serum, a cream, a lotion), up to three, each presented with why; never a cleanser unless the foundation says it treats the need (Imperfections). A type they asked for (« juste un sérum ») keeps its own alternatives. The builder never shows top choices: it builds the routine.
- **« Trop cher » just after one product** (owner, 2026-10-13): the cheapest product of the same type that passes the same hard rules and targets the MAIN need, cheaper than it (`playbook cheaper`); only when there is none, the « petit plaisir ». A side concern of the first product does not count (in a test, a radiance serum « matched » a hydrating serum's « ridules »). In the builder the budget rules above stay.
- **From the customer batch (2026-10-13):** a man's range comes first among the suitable products (a sensitive-skin cleanser had outscored his); « vous avez autre chose ? » gives the next products for the same need, never those already shown (`no_other_option` when there are none); body care only when the customer says it, not when the model reader guesses it from « after showering ».
- **One product proposed comes with its offer** (owner, 2026-10-13; foundation engine): the public offers running on that product now (its own, a collection it is in, or every product; never free shipping or a private code; at most two), from the synced promotions the shopping tools read. The model mentions it once, as given, and never promises it applies to their cart. A routine of several products gets none here: its offers stay the shopping tools' (`simulate_offers`).
- **Measured:** `npm run advisor:score` 44/44 on the bench with the budget cases (the playbooks: 14/38 before them). The bench is invented: the real score waits for Qiriness's spreadsheet.

### The routine builder is a skill: its rules and tools only while it is open (2026-10-13)

The owner's rule. Building a routine is one bundle, `skills/routine-builder.mjs`, with its instructions, tools and guardrails; the base prompt keeps only targeted advice (the top choices for a need, a product's facts).

- **Open while `mode === 'routine_builder'`,** so the code and the model can both open it and it stays open across turns. The code opens it on « Oui » to the offer (button or typed), the `build_routine` action, the routine words, or a routine size in the customer's words (« tout organiser du matin au soir »). The model opens it with `use_skill`, offered only while no skill is open, when the customer asks for a routine in their own words.
- **Inside:** the skill's rules (one question per turn, steps only from ADVICE, owned products kept, purchases and treats the app's) and its tools: `advise` in routine mode (any routine size), and `get_past_purchases` for a signed-in customer.
- **Outside, `advise` gives one product.** Its scope is `targeted` only, and the runner ignores a routine size the model sends: in a live run the model built a whole routine through the targeted tool instead of opening the skill. A reply that already shows a routine is never followed by the routine offer.
- **The flow decisions stay in code** (`routine-flow.mjs`): the offer, the purchase turn, the product built around, the treat. The skill gives the model what it needs to converse while building.

### The storefront agent reads one order's status by its number (2026-10-13)

The owner's rule. « Où est ma commande #1234 ? » gets the status, not a referral.

- **By number, for anyone who has it** (owner): guest checkouts are most orders, so « signed-in only » would answer almost no one. The risk is that order numbers are sequential, so someone trying numbers learns other orders' status and day. Against it: only the status and the days come back (no name, email, phone, address, amount, product or tracking), 3 lookups a conversation, marketplace orders are « not found », and every lookup is logged in `data_access_events` (hashed shop and number). A lookup that cannot be logged is not used.
- **One reader** (`order-status-repository.mjs`), named columns; the destination country is read only to choose the home or abroad delivery time and never leaves it. `data-access.test.mjs` allows it and the purchase reader, nothing else.
- **The status is the shop's own timings** (`order-status.mjs`, working days): not shipped within `dispatch_days`, being prepared; past it, sorry for the delay; shipped within `france_delivery_days` / `abroad_delivery_days`, on its way; past them, late, sorry. Also delivered, cancelled, partly shipped (judged on what is left). An unset timing is never guessed (`timing_unknown`; JavaScript reads `null >= 0` as true, caught by a test).
- **The tool returns the dispatch and delivery passages** of the policy with the status, so the reply explains the timing in the shop's words.
- **The model may ask for the order number, and only that.** This replaces « never ask for an order number ». Never an email, a name or an address.
- **Off unless `STOREFRONT_CHAT_ORDER_STATUS=on`.**

### Every « contact us » carries the contact form (2026-10-13)

The owner's rule. Whenever the advisor sends someone to customer service, and after every order answer, the contact form's link is under the reply.

- **The model sets `contact_link`; the code makes it certain.** It is forced on whenever the order tool ran, or the reply names customer service or contacting us (FR/EN words).
- **The link is the shop's**: the parameter `contact_form_path`, default Shopify's `/pages/contact`, a path on the shop's own site only (anything else falls back). The widget builds it from `Shopify.routes.root`, so it opens in the visitor's language. The model never writes a link, an email or a phone number.

### The routine builder flow: offered after products, built around what they came for (2026-10-13)

The owner's design. A conversation leads to a personalised routine naturally: entered from a product question (its facts), a concern (our top choices) or « construisez-moi une routine » (straight in).

- **The flow is code, not prompt** (`routine-flow.mjs`). The app writes its own follow-up message, words and buttons together, so they always agree. The model is told only that a message follows and what it does, never its words: quoted, the model copied it (live run). This replaces Phase 1's model-asked purchase question, which had the text ask one thing and the buttons answer another.
- **The offer** follows a reply about products: cards shown, or the product the conversation is about (its page, or one they named). It is a second message, « Souhaitez-vous que je vous construise une routine personnalisée ? », with Oui / Non; typed words count while it is pending (FR and EN). Once per conversation; after « Non », only their own request starts the builder.
- **« Oui » is a routine, not one more product:** a care type or targeted scope from the first question is dropped, or « une crème pour mon visage déshydraté » then « oui » built one cream again. The engine's concern question still gets its buttons the turn after (the offer had taken its turn).
- **The anchor** is the one product they focused on (owner): the page product, else the one they named, else our top pick. In the builder it is put into its step (`pinned`), even when the chosen size lacks that step (the step is added from the full routine). It must still pass the hard checks and the suitability floor, else it is left out and the reason given. For « un soin ciblé » it is the product.
- **The purchase question:** builder only, signed in, once, once the concern is known. It is the whole turn, written by the code with no model call: told to ask nothing, the model still added its own question beside it in two live runs. The three answers: « Construire ma routine autour » (theirs: it fills its step, its range nudges), « Il m'en reste peu » (the always-offered option, owner; its card follows with « Voir le produit » and « Ajouter au panier », and it goes into its step), « Me concentrer sur ma préoccupation » (left aside). A consultant offers, never pushes a reorder.
- **One question per turn.** A follow-up that asks takes the engine's question's place; the engine asks it next turn, and the model sees `waiting_for_follow_up` with nothing to ask. A follow-up without buttons (a card) carries the engine's buttons, since only the last bubble's are live.
- **One treat at most** (« petit plaisir »): after the routine is recommended, or right after « Non ». The brand's « Petit plaisir » products once the knowledge is imported; until then the config's `treats` (masks and patches, `max_price` €25, owner). Never a product in the routine or one they own.
- **« Ajouter au panier » on cards** (owner): only when the product has one purchasable size in stock; with several sizes the choice is the customer's, on the product page. The widget adds one unit to the shop's own cart on the customer's click and records `added_to_cart`.

### Purchase history, Phases 2–3: what they use fills the routine; what runs out is asked about (2026-10-13)

- **A product they build around fills its step and counts toward the routine size.** Only what the customer confirmed (« Construire ma routine autour »; « Je l'utilise encore » before the flow), never a purchase alone. The step is skipped as `already_owned` with their product's name; the model says to keep it and recommends the other steps. It is never offered again, not even as an alternative. A step they asked for by type (« une crème ») is still filled: they asked.
- **Which step a product fills is the brand's knowledge**: the spreadsheet's « Type fonctionnel » (the main types; « Masque » is a cream mask and « Masque tissu » a sheet mask, 2026-10-14: the type alone says whether a mask is a treat, sheet yes, cream no, and only a cream mask fills a routine's mask step; « Démaquillant » also fills a « Nettoyant » step, never the reverse, 2026-10-14, `fillsStep`; « Coffret » and « Kit » are two, 2026-10-14, both standing for their contents and filling no step themselves, treated alike until the owner says how they differ; « Autre » for anything outside them, described in « Autre type », 2026-10-14: an « Autre » product fills no step) and « Zone », mapped to step kinds by the brand config's `functional_types` (data, validated against the slots). Without knowledge, the step's own catalogue rules decide. One product fills one step at most: one cream is not a day and a night cream.
- **A kit stands for what it contains** (« Contenu du coffret »); the kit itself fills nothing. Kits and sets are in 52.8 % of orders.
- **« Ne pas conseiller » is never recommended**, whatever its signals. The importer keeps those rows for that reason; « À valider » rows are not imported.
- **Running low is a question, never a claim.** For daily care only (knowledge `frequency: daily`; never a mask, kit, tool, treat or gift), when the expected interval has passed and less than three intervals have (past that they have most likely stopped or buy elsewhere). The interval is the shop's measured median when 10+ repurchases were seen, else the brand's « Durée d'utilisation ». Measured on own-store orders, 2026-10-13: repeat rates 4–36 %, daily creams and serums 10–20 weeks with a narrow spread, masks and patches all over the place (Wrap d'Or 3–23 weeks), hence never scheduled. The consultant may ask once (« il vous en reste ? »); no pushed reminder, no reorder pressure.
- **Measured is when they rebuy, not how long it lasts**, so it never replaces the brand's figure in the spreadsheet. Measured under half or over twice the stated duration is flagged for the brand (`durationsDisagree`).
- **A range they use is a nudge, not a reason**: ranges of products they still use or paid for more than once add 0.15 to routine fit (below the playbook's family, 0.5, and the slot name, 0.2), after suitability. It reorders suitable products; it never lifts an unsuitable one. Never from a gift or a free line.
- **Not built:** commercial adjustments (the treat policy, § 3.4 of the plan) and measuring the effect on cart additions and later purchases.

### Purchase history, Phase 1: asked about, never assumed (2026-10-13)

- **A purchase is a question, not a fact about the customer.** It does not prove they use it, still have it, liked it or bought it for themselves. So the consultant asks about one (« I can see you bought X — still using it? »), with chips from the code, never the model. Only the answer is recorded (`context.advisor.purchases`: product ids under using / finished / gift).
- **Read only when the turn needs it:** a consultation turn, a purchase chip, or a message about past purchases (« ma dernière commande », « reorder »). A policy, product or cart question never reads orders. The agent is handed a loader instead of data, so a turn that does not need purchases costs no query. A customer's summary is reused for 10 minutes: a consultation lasts a few minutes, and egress is what restricted the project in October 2026.
- **When and how to ask:** superseded the same day by « The routine builder flow » above (builder only, once, the code's own turn).
- **What is worth asking about:** a product probably running low first (Phase 3); then the latest purchase they paid for and kept, still sold. On the same day, the one bought most often, then the more expensive (the shop’s current price, cheapest variant; owner’s rule, 2026-10-13). The price ranks only and never reaches the prompt. Never a €0 line (a promotional gift or sample: about half of Wrap lines), never a return, never a product no longer sold.
- **An unlogged read is not used.** If the `data_access_events` write fails, the read fails and the turn carries no purchases. A slow or failed read (1.5 s cap) does the same: the advisor answers as if anonymous.
- **« Still using it » keeps their product.** Since Phase 2 their product fills its step (below); before, the step was only marked.
- **Marketplaces come from `sales_channels`, not a list in code**, as for every per-person metric (their customers are synthetic, one per order).

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

The management chat lets its model write SQL, as a read-only role over curated views (§ Management chat). That works because its users are signed-in staff. The storefront agent talks to the public internet, so it gets **narrow, typed, read-only functions** (Phase 3: `search_products`, `get_product` through a product repository returning whitelisted fields) and never a query language or a database handle. It never reads customers or orders, with two exceptions since 2026-10-13, each one typed function: the signed-in customer's own purchase summary (§ Purchase history: identity from the signature only) and one order's status by its number (§ The storefront agent reads one order's status by its number).

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
