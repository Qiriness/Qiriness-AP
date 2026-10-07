# How Shopify applies discounts — reference for the storefront advisor

**Qiriness's plan, checked 2026-10-07 through the Admin API:** `qiriness.myshopify.com` is on the « Shopify » plan, `plan.shopifyPlus: false`. So every non-Plus rule below applies: **a product takes at most one product discount**, and both items of a Buy X Get Y take no other. The advisor receives these rules as `stacking_rules` with every offer result (`stackingRules(source)`; `source.shopifyPlus` is the one switch, default false).

Researched 2026-10-06 from Shopify's Help Center and Admin API reference (sources at the end). This file describes **Shopify's** behaviour on a non-Plus store, which is Qiriness's case. Where our evaluator (`scripts/lib/storefront-chat/shopping-evaluator.mjs`) already follows a rule, or doesn't yet, that is said under each section.

## 1. Three classes, and what can stack

| Class | Applies to | Examples |
|---|---|---|
| **Product** | specific items / collections | September Rose (−30 % on a collection), Buy X Get Y, TEST01 |
| **Order** | the cart subtotal | QIRINESS20, BIENVENUE20 |
| **Shipping** | the delivery price | Livraison gratuite |

| Combination | Allowed? |
|---|---|
| Product + Product on **different** lines | yes, if both allow it |
| Product + Product on the **same** line | **no** (Shopify Plus only, with tags) |
| Product + Order | yes, if both allow it |
| Order + Order | yes, if both allow it |
| Product or Order + Shipping | yes, if both allow it |
| Shipping + Shipping | **never** |

- **Combining is mutual.** Each discount's « combines with » box must allow the other's class, in both directions.
- **Limits:** at most **5 product or order codes + 1 shipping code** per order, and **25 active automatic discounts** (app discounts included).

*Advisor:* mutual combination flags ✓ (`combinable`). One product discount per line ✓ (`line_already_discounted`).

## 2. Buy X Get Y is exclusive on its items

- **On non-Plus plans, every product taking part in a Buy X Get Y, the « buy » product (X) as well as the « get » product (Y), is excluded from any other product discount.** On Plus, only the Y item may stack.
- **The « get » item is never added automatically.** The customer must put X *and* Y in the cart; then the automatic discount applies (or they enter the code).
- **The X threshold** (« minimum quantity » or « minimum purchase amount »):
  - only X products count, never Y;
  - they count **at full price, before any other discount**;
  - an item that already carries another (combinable) product discount **doesn't count at all**.
- **« Maximum number of uses per order »** caps how many times it repeats in one cart.
- The reward is « Free », a percentage or an « amount off each ».

*Advisor:*
- Y-not-in-cart ✓ (`reward_not_in_basket`).
- Y unpublished or draft ✓ (`reward_unavailable`).
- **Gap 1 — closed (2026-10-06):** the X line of an applied Buy X Get Y carries no discount allocation in `cart.js` (the discount is allocated to Y). The per-line check now also locks every line in the « buys » or « gets » scope of an **applied** Buy X Get Y (`productDiscountsOn`), so September Rose is `line_already_discounted` on the cream under TEST02. With `shopifyPlus: true`, only the « buys » lines stay locked.

## 3. When offers conflict, Shopify picks the best total for the customer

« If two or more discounts are applied, but can't be combined due to the discount combination setting or the content of the cart, then **the best discount for the customer's cart is always applied**. »

So:
- Shopify doesn't use a priority, a creation date or a name. It compares the **allowed combinations** and keeps the one with the **largest total saving**.
- **A Buy X Get Y only wins if its saving beats what the other product discounts would give on the same items.** Otherwise its items take the other discounts and the Buy X Get Y doesn't apply.
- Shopify's documentation doesn't describe the tie-break, or the exact search.

*Worked example (dev store, cart = Caresse Temps Sublime night cream 68,95 € + Eau Qi 37,80 €):*

| Option | Saving |
|---|---|
| TEST02: Eau Qi free; neither item may also take September Rose | 37,80 € |
| September Rose −30 % on both items (both are in its collection) | 20,69 + 11,34 = 32,03 € |

→ Shopify applies **TEST02**: the cream stays at 68,95 € and Eau Qi is free. With **only the cream** in the cart, TEST02 can't apply (no Y), so September Rose applies: 68,95 → 48,26 €.

TEST02 as synced (2026-10-06): **spend 65 € on 7 listed products** (the night cream among them) → Eau Qi free; not « buy 1 cream ». The cream alone (68,95 €) meets it.

**Free delivery can be lost to the better saving.** Its 70 € minimum is measured on the discounted total. TEST02 leaves 68,95 €, which is 1,05 € short; September Rose would have left 74,72 €. Shopify still applies TEST02. The solver reports it as `free_delivery_missed`.

*Advisor:* `evaluate_promotions_for_cart` judges each offer on its own. **Gap 2 — closed (2026-10-06):** `scripts/lib/storefront-chat/offer-solver.mjs` enumerates every allowed set of offers (≤ 10 offers → ≤ 1,024 sets), prices each in Shopify's order and keeps the largest saving. The model reaches it as `simulate_offers({ add })`, for the cart or the cart plus resolved products. It reaches public automatic offers and codes already entered; a private entered code keeps the amount the cart shows. On a real cart, what the cart shows stays the authority (`matches_current_cart`, and a caveat when they differ). Not modelled: Shopify's tie-break, a Buy X Get Y repeating within one order (counted once, said in `caveats`), app discounts.

## 4. The order of calculation, and which price each minimum sees

1. **Product discounts** apply first, line by line.
2. **Order discounts** apply to the **subtotal after product discounts**. Several percentage order discounts are **each computed on that same subtotal**; they don't compound.
3. **Shipping discounts** apply last.

| Minimum on… | Measured on |
|---|---|
| a product discount | prices **after earlier product discounts** (order discounts excluded) |
| an order discount | must be met **both before and after** product discounts; other order discounts don't reduce it |
| a Buy X Get Y | X items at **full price**; items with another combinable product discount excluded |
| free shipping | products **at their discounted price** (when the discounts combine) |

*Advisor:* free shipping compares the threshold with the cart total after discounts ✓, and leaves the case where order discounts decide it as `unknown` ✓. **Gap 3 — closed (2026-10-06):** `classThreshold` measures each money minimum as in the table (order: the lower of the subtotal before and after product discounts; product: the qualifying lines after other product discounts; Buy X Get Y: « buys » lines at full price, without lines holding another product discount and without the « gets » units). The result carries `measured_on`. A cart straddling an order minimum is now `not_eligible` instead of `unknown`. Quantity minimums are unchanged.

## 5. Sale prices: compare-at, and apps like Alpha

- **Shopify discounts are calculated on the product's current price.** The compare-at price is display only (the crossed-out price). So with a compare-at of 98,50 € and a price of 68,95 €, September Rose's 30 % is taken off **68,95 €** (→ 48,27 €), not off 98,50 €.
- **Alpha: Sale & Discount Manager** (Alphalogic) bulk-edits prices, shows the old price crossed out as compare-at, schedules sales and reverts them. Its listing describes « discount prices… compare-at price crossed out » and « prices revert when it ends », which points to it **rewriting the variant's price**.
  - **If so:** every Shopify promotion is then computed on the Alpha price. That's your assumption, and it's correct for that mechanism: an Alpha −30 % on 69,90 € gives **48,93 €**, then September Rose −30 % gives 34,25 €.
  - **Check your example:** 38,58 € is 44.8 % off 69,90 €, not 30 %. It's worth checking which reductions produced it.
- **Alpha's « in-cart discounts »** are a separate mechanism, run as discounts at checkout (most likely Shopify discount functions). Those are **automatic discounts** subject to the same classes, combinations and 25-discount limit. We sync them as `app` discounts, and the evaluator returns `unknown` (`unsupported_rules`) for them, because their logic lives in the app.
- **« Block coupon codes on sale products »** (Alpha) changes which items a code can reach. That is invisible to us until it shows in the discount's synced conditions.

*Advisor:*
- The cart (`cart.js`) always carries the **current** price, so evaluating a real cart is correct during an Alpha sale.
- **Gap 4 — closed (2026-10-06):** the product sync stores `compare_at_price` per variant. Product search and detail carry `on_sale` and the « was » price; the cart context carries `on_sale`, `price_before_sale` and `sale_percentage`. Between syncs, the synced compare-at can still lag a sale that started or ended; the cart's own price is always current.

## 6. Other rules worth knowing

- **Combinations only on Online Store, Storefront API and POS orders.** Draft orders don't support Buy X Get Y codes.
- **Amount-off « once per order »** versus applied to every eligible item: a per-discount setting.
- **Customer eligibility:** all customers, specific customers, segments or markets. The cart doesn't tell us who the customer is, so such offers stay `unknown` (`customer_eligibility_requires_checkout`).
- **Subscriptions:** a discount may target one-time purchases, subscriptions or both.

## 7. What this means for the advisor — 1 to 4 built (2026-10-06), 5 already so

| # | Change | Why |
|---|---|---|
| 1 | Lock **every** item of an applied Buy X Get Y (X and Y) for other product discounts | Gap 1 |
| 2 | A small **best-combination solver** for « what would apply if… » | Gap 2. Carts are small and offers few: enumerate the compatible sets (mutual flags, one product discount per line, Buy X Get Y exclusivity, ≤ 1 shipping), price each in Shopify's order, keep the largest saving |
| 3 | Model each minimum by class (§ 4 table) | Gap 3 |
| 4 | Sync `compareAtPrice`; report « on sale » and the original price | Gap 4, and Alpha sales |
| 5 | Treat app discounts (Alpha's in-cart ones) as « the app decides »: name them when applied, never predict them | § 5 |

## Sources

- [Discount combinations](https://help.shopify.com/en/manual/discounts/discount-combinations)
- [Buy X get Y discounts](https://help.shopify.com/en/manual/discounts/discount-types/buy-x-get-y)
- [Amount off discounts](https://help.shopify.com/en/manual/discounts/discount-types/percentage-fixed-amount)
- [Free shipping discounts](https://help.shopify.com/en/manual/discounts/discount-types/free-shipping)
- [Automatic discounts](https://help.shopify.com/en/manual/discounts/automatic-discounts)
- [DiscountCombinesWith (Admin GraphQL)](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/DiscountCombinesWith): one product discount per line by default; tags on Plus only
- [Alpha: Sale & Discount Manager](https://apps.shopify.com/al-bulk-discount-manager)
