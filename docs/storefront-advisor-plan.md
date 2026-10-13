# Storefront advisor — plan (from 2026-10-12)

What is still to do on the storefront Beauty Consultant (« Conseiller Beauté »), gathered from the design review of 2026-10-12. This is a plan to review and act on, not a record of what exists: what is built is in `docs/storefront-chatbot.md`, why it is that way is in `docs/decisions/storefront-advisor.md`, and what still needs proving is in `VALIDATION_LOG.md`.

Tick items as they land; move each one's rationale into `docs/decisions/` when it is built.

---

## 0. Where things stand

**Built and committed** (branch `fix-compliance-customer-match`, commits `2830330` and `164ffc9`, not pushed):

- French and English parity in every deterministic layer: the consultation lexicon, chips in the customer's language, policy and FAQ routing, the shopping opening and product-name resolution (VALIDATION_LOG 50).
- The lexicon's model backup: when the lexicon leaves words unexplained on a consultation turn, one structured model call (reasoning off, 2.5 s cap) reads the profile before the engine decides (VALIDATION_LOG 51).
- Evals on the live catalogue: `eval:resolution` 123/123 (FR 71, EN 52); `eval:advisory` 47/49 (the 2 failures are catalogue data, see § 7).

**Built, not committed:** `data/advisor/qiriness-knowledge-template.xlsx`, the Products / Routines / Rules spreadsheet for Qiriness (§ 2). From now on Qiriness's filled-in copy is the master; it is never regenerated over.

**Blocked until 2026-10-15:** the Supabase REST API is restricted for exceeding the egress quota. The widget, the evals and every sync depend on it. The evals of 2026-10-12 ran over a direct database connection through a scratch shim.

---

## 1. Blockers and housekeeping

- [ ] **Supabase egress** restored (2026-10-15). Then re-measure the worker's idle poll (memory: egress investigation, branch `egress-idle-poll`).
- [ ] `npm run advisor:load`: the English chip labels in `data/advisor/qiriness.json` are not in the advisor tables yet, so chips stay French in English conversations.
- [ ] Restart `cd storefront-app && shopify app dev` (the widget's cart rule changed in `advisor-cart.js`).
- [ ] Move the chatbot commits (`2830330`, `164ffc9`) to their own branch off `main` before pushing; the current branch also holds compliance and migration work.
- [ ] Commit the spreadsheet template and this plan.

---

## 2. Product knowledge (Qiriness fills, we import)

**Decided:** Shopify keeps the catalogue (products, prices, stock, published information); Supabase holds the consultant's knowledge (foundations, steps, rules, product metadata, versioned); the model interprets, asks and explains. Product suitability does **not** come from Shopify tags: on 2026-10-12, 56 % of products were tagged for sensitive skin, most for every skin type, and 28 carried contradictions (« matifiant » and « peaux sèches »).

**The spreadsheet** (`data/advisor/qiriness-knowledge-template.xlsx`), three tabs:

| Tab | Content |
|---|---|
| Products | 94 published products (samples excluded). Functional type (8 + set/tool), Qiriness ritual stage (Préparer / Activer / Optimiser / Régénérer), frequency, morning/evening, area, main concern + other concerns (the 20 standard concerns), skin-type suitability (Idéal / Adapté / Non adapté), usage duration, kit contents, texture, sensitive skin, contains (from INCI), precautions, compatibility, men's range, premium, treat, gift, status. Green = verified (INCI, usage), yellow = proposed, orange = to fill. |
| Routines | The 7 foundations, one row per step in priority order, daily/occasional, required/optional, preferred range, premium variant; then the Eyes, SPF and occasional-care modules. |
| Rules | The 20 standard concerns in 7 families, each with its foundation and its effect when secondary; routine sizes; skin type → cream texture; preferences; treat conditions; open questions. |

- [x] **Two columns for purchase history** (2026-10-13), inserted into the filled copy in place (backup taken first, every other cell verified unchanged). Orange, for Qiriness to fill:
  - « Durée d'utilisation (semaines) » (`usage_weeks`, a whole number 1–104) after « Fréquence »: how long the size sold lasts in normal use. Phase 3 replenishment.
  - « Contenu du coffret (handles) » (`kit_contents`) after « Cadeau »: for kits only, the handles of the products inside. Phase 2: a bought kit covers the steps of what it contains, not one « Coffret / kit » step. Kits and sets are in 52.8 % of orders (§ 8).
- [x] **Skin-type suitability has three levels** (owner, 2026-10-13): « Idéal / Adapté / Non adapté » on the four skin columns. The 235 « Oui » proposed from tags became « Adapté », never « Idéal »: tags cannot say what is ideal. Blanks stay blank; the importer must treat a blank as « not stated », not as « Non adapté ».
- [ ] **Qiriness fills and validates** every product row (status « Validé » / « Corrigé » / « Ne pas conseiller »).
- [ ] **43 of 94 products have no INCI in Shopify**: their exclusions (« sans parfum ») cannot be verified until it is added in Shopify.
- [ ] **Importer.** Decision pending: convert the approved spreadsheet to a JSON file in git (proposed: every correction is a reviewable diff; no new dependency), or add an Excel library to the project. The importer refuses unknown concern labels, enum values outside the dropdowns, and rows not « Validé »/« Corrigé ».
- [ ] **Supabase tables** for foundations, steps, rules and product knowledge, with a version per import. Written as a migration, **applied only on the owner's go-ahead**.

**Standard concerns (20, in 7 families):**

| Family | Concerns | Foundation |
|---|---|---|
| Hydratation | dehydration, dryness | A Hydratation |
| Âge | fine_lines, wrinkles, loss_of_firmness, loss_of_elasticity | E Anti-âge (Exception = premium variant) |
| Éclat | dullness, signs_of_fatigue | D Éclat |
| Imperfections | blemishes, enlarged_pores, excess_sebum, uneven_texture | B Imperfections |
| Sensibilité | redness, discomfort, reactivity | C Peaux sensibles |
| Pigmentation | dark_spots, uneven_tone | F Taches |
| Yeux | dark_circles, puffiness, eye_wrinkles | Eyes module |

---

## 3. The routine engine

**The four separate decisions** (the key design principle): which foundation, which products, what size, and whether to make a commercial offer.

### 3.1 Foundations and layers

| Layer | Role |
|---|---|
| **7 foundations** | A Hydratation, B Imperfections, C Peaux sensibles, D Éclat, E Anti-âge (Exception as premium option), F Taches, G Routine de base. The main concern picks the foundation. |
| **Secondary objectives** | Other concerns change which products fill the steps (e.g. Hydratation + anti-age → Source d'Eau cream with an anti-age serum). They never switch the foundation. |
| **Modules** | Eyes, SPF, occasional care. Added when relevant, or asked for alone (« just an eye cream »). |
| **Preferences** | Men's range (a preference, not a routine: ranked first, others still possible), budget, exclusions, scope, products already owned. |

- [ ] Replace the 11 playbooks with the 7 foundations (stand-in data from the current playbooks until the spreadsheet is imported).
- [ ] Secondary objectives fill steps (the new piece). Today « dry, dull, wrinkles » gives one Active Énergie Lift serum; dryness is only a skin type and drops hydration.
- [ ] Skin type chooses the cream (texture, hydrating) but **never forces** a hydration foundation when another concern is the main one.
- [ ] Men as a preference; « I'm a man with dry skin » → Hydratation with men's products first.
- [ ] Modules work standalone (eye-only, hands) and inside any foundation.
- [ ] Routine de base **only** on an explicit request (« just a basic routine »); « I don't know what I need » → one useful question. Today the first gets an 8-option concern question and the second starts no consultation.
- [ ] Lexicon and model reader emit the 20 standard concerns; the 41 current keys map onto them in code (tightness → dehydration, shine → excess_sebum, deep wrinkles → wrinkles + premium, …). Customers can still say anything.

### 3.2 Routine sizes

| Size | Rule |
|---|---|
| Essential | the first 2–3 daily required steps (default when the customer says nothing) |
| Complete | 4–5 daily steps, plus relevant modules |
| Spa ritual | Complete + occasional steps (exfoliant, Wrap, patches); chosen by the customer, never added automatically |
| One product | the first useful uncovered step, only on request |

- [ ] One ordered step list per foundation; sizes are rules over it.
- [ ] **Never pad**: a step is filled only when a suitable product exists.
- [ ] **Owned products count** toward the size and are never replaced unless asked.
- [ ] Today's « essential » is always 2 products with no cleanser, and « complete » mixes weekly masks and eye care: both change.

### 3.3 Questions and chips

- [ ] **The most useful question first**: score each unanswered field by how much its answer changes the result; prefer skin traits (« Usually dry or oily in the T-zone? », « Does your skin react easily? ») over asking the customer to name a concern (today: « Déshydratation / Sensibilité / Sécheresse / Rougeurs ? »). Never age first.
- [ ] Allow **one** such question outside the builder when the engine is not confident, instead of recommending blind.
- [ ] Conversational chips in FR and EN: sizes « Essentielle (2–3 produits) / Complète (4–5) / Rituel spa / J'ai déjà des produits »; skin type « Plutôt sèche / Grasse sur la zone T / … ».
- [ ] Optional: the total price of each size on its chip, computed from the catalogue.

### 3.4 Treats (commercial offers, separate from advice)

Wraps, patches and kits are the entry door (Wraps in 48 % of first orders), but about half of Wrap lines were free promotional gifts, so order counts overstate demand.

| Customer situation | Treat strategy |
|---|---|
| Asks about masks or spa | Recommend directly |
| Has bought or likes Wraps | Suggest a relevant daily-care complement |
| Builds a full routine | One relevant treat at most, if appropriate |
| Small budget | No upsell |
| Buying a gift | Gift sets and spa experiences first |
| End of consultation | Optional, never automatic |

- [ ] Treat policy as rules, at most one offer per conversation, paired with live promotions on kits and masks (`get_active_promotions`).
- [ ] Treat routines (2–3): « Soirée spa » (Wrap + sauna + patches), « À partager », optionally hands & feet.

---

## 4. Evaluation (must pass before deployment)

Every case in **French and English**, offline on the live catalogue (`eval:advisory`), no model needed:

- [ ] Combined concerns: « My skin is dry, dull and I'm starting to get wrinkles » → Hydratation or Anti-âge foundation with the other as secondary; never a single Lift serum.
- [ ] Budget limitation: Essential size, no treat.
- [ ] Pre-existing products: « I already use a cleanser and a cream » → only the missing steps.
- [ ] One product only.
- [ ] « I just want a basic routine » → Routine de base; « I don't know what I need » → one question.
- [ ] « I'm a man with dry skin » → Hydratation, men's products first.
- [ ] Eye-only request; gift request; spa request.
- [ ] Sizes never padded when no suitable product exists.
- [ ] The existing cases keep passing (47/49 today) and the rule invariants keep 0 violations.

---

## 5. Purchase history (separate layer)

Purchase history feeds the profile, the advisor's policy and the engine. It **never** sets skin type or overrides what the customer says. A purchase does not prove the customer likes, uses, still owns, or bought it for themselves.

- [x] **Phase 0 — identity and permission.** Approved and built 2026-10-13 (`customer-identity.mjs`, `purchase-summary.mjs`, `data-access.test.mjs`; decision « Purchase history: identity from the signature only »). Nothing is read yet. Not yet tried on the dev store with a signed-in customer (needs Supabase back).
  - Identity **only** from Shopify's signed `logged_in_customer_id` (already verified by our app-proxy signature check, deliberately unused today). Never from an email or order number typed in the chat. Not logged in → anonymous advisor.
  - The decision « the storefront agent never reads customers or orders » becomes « it reads only the signed-in customer's own purchase summary, through one narrow typed function ». Still no SQL, no other customer's data. Update `docs/decisions/storefront-advisor.md` and consider the privacy notice.
  - The model sees products, dates, counts, returned / free-gift flags; never addresses, emails, order numbers or amounts paid.
  - Behind a setting, off by default.
- [x] **Before Phase 1 reads anything:** each read logged in `data_access_events` (checklist item 15); the use stated in `MERCHANT_DATA_USE_DISCLOSURE.md` (items 2–3).
- [ ] **The shop's privacy notice:** the owner to review whether it should mention the advisor's use of purchase history.
- [x] **Phase 1 — purchase awareness.** Built 2026-10-13 (`purchase-summary-repository.mjs`, `purchase-turn.mjs`; decision « Purchase history, Phase 1: asked about, never assumed »). Read on demand with a 10-minute cache rather than a stored summary table: no duplicate order data, no migration. « Still using it » marks the step's product; it does not yet change the routine (Phase 2). Unit- and agent-tested only (VALIDATION_LOG 52). Original scope: A small derived summary from the existing `orders` table (online store only; Amazon/Mirakl orders mint synthetic customers), refreshed when orders change; no duplicate catalogue or order records. €0 lines flagged as promotional gifts and never read as preference. The consultant **asks**: « I can see you bought the Source d'Eau serum — still using it? » with chips « Je l'utilise encore / Je l'ai terminé / C'était un cadeau »; a confirmed product enters « products already owned ».
- [ ] **Phase 2 — routine gaps.** A purchased product's functional type (spreadsheet) says which step it covers.
- [ ] **Phase 3 — purchase intelligence.** Range affinity, repeat purchases, replenishment windows (the usage-duration column), commercial adjustments; measured on cart additions, conversion and later purchases.
- [ ] Test setup: a test customer with test orders on the dev store (it has no real customers or orders), and `dev-store:sync` extended to copy that customer's orders under the dev shop (today it copies products only).

---

## 6. Validation on the dev store and measurement

- [ ] Run the open checks: VALIDATION_LOG 46–47 (promotions, cart), 48 (consultation), 50 (English), 51 (model reader).
- [ ] After the engine change: the § 4 cases by hand in the widget, in both languages.
- [ ] **Measure, don't assume, retention.** Customers whose first order is ≥ 180 days old came back within 180 days at 22.4 % overall, 26.7 % after Temps Sublime, 25.5 % Active Énergie, 23.7 % Source d'Eau, 22.7 % paid Wrap (2026-10-12). Not proof of cause: test it once live, by joining `advisory_events` (recommended, clicked) to later orders.

---

## 7. Questions for Qiriness

- [ ] **Voile Source d'Eau** left all four moisturiser collections (`cremes-de-jour`, `cremes-hydratantes`, `creme-de-nuit`, `soins-hydratants`): deliberate? It is why combination skin now gets the standard Source d'Eau cream, and the 2 failing `eval:advisory` cases.
- [ ] **Glow step** (CC, BB, Bonne Mine — « sublimateur glow immédiat »): which functional type?
- [ ] **Fine lines / first wrinkles**: Anti-âge (standard list) or Éclat (the playbooks of 2026-10-07)?
- [ ] **Lips, hands, feet**: their own advice (module) or treats only? No routine covers them today, so Lip Beauty and Mains Velours are never advised.
- [ ] **Words outside the 20**: « tiraillements », « peau mature », « rides marquées » are folded into Déshydratation, Rides and the premium variant — enough?
- [ ] The inferred mappings of VALIDATION_LOG 48.3 (men's routes, which concern is asked first, step → collection, eye-range preference) — superseded by the spreadsheet once it is validated.

---

## 8. Reference data (2026-10-12, online store, last 12 months)

3,823 orders, about €300k of line items.

| Need | Revenue | Orders with it | Avg price |
|---|---|---|---|
| Spa, wraps, kits & sets | 28.6 % | 52.8 % | €18 |
| Eyes (mostly patches) | 11.5 % | 23.5 % | €24 |
| Anti-age (Temps Sublime) | 9.0 % | 8.2 % | €66 |
| Hydration (Source d'Eau) | 8.2 % | 12.3 % | €35 |
| Men | 7.3 % | 12.0 % | €22 |
| Complexion (CC, BB, Bonne Mine) | 7.1 % | 21.1 % | €19 |
| Radiance (Active Énergie) | 4.4 % | 6.0 % | €46 |
| Advanced anti-age (Exception) | 4.3 % | 3.1 % | €85 |
| Dark spots (Éclat Parfait) | 2.8 % | 5.1 % | €29 |
| Sensitive skin | 2.0 % | 4.2 % | €27 |

Bucketed from product titles and range collections; free promotional lines included (about half of Wrap lines).
