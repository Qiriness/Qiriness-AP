## Sale prices

`scripts/sale-prices.mjs` (`npm run sale:*`): a whole collection on sale by changing the real price, and back.

### A sale changes the real price, because Google only reads the price (2026-11-19)

Black Friday ran on the theme's `promo-10 … promo-60` collections plus Shopify automatic discounts. Neither touches the variant's price or compare-at price, so the Google & YouTube channel sends Merchant Center no sale price and Google Ads shows the full price. Merchant Center shows a sale only when price < compare-at. A sale therefore sets **price = discounted, compare-at = the price before**. Checkout needs no discount: the price itself is lower. The promo-X system is to be switched off and its theme code removed once this is proven (the owner's call, 2026-11-19), so the script does not check for it.

The rounding is the theme promo formula, `price − round(price × X / 100)` in cents, so a 20 % sale lands on the figure the site already displayed.

### The original price lives on the variant, not in a file (2026-11-19)

The owner's hard rule: ending a sale must never lose the old price. Every reduced variant carries the metafield `qiriness_sale.original` (JSON: original price, original compare-at, sale price, campaign, collection, percent, date). It is part of the **same** `productVariantsBulkUpdate` input as the new price, with `allowPartialUpdates: false`, so a variant is never reduced without its way back, and a product is never half on sale.

Restore reads the marker, not a file: it works from any machine, and `sale:status` / `sale:restore --all` find every sale by scanning for markers. The marker has no metafield definition, so it cannot be a search filter; the scan reads all variants (a few hundred). A local backup (`sale-backups/`, JSON + CSV, gitignored) is still written **before** the first write, as an offline copy.

### Re-running is safe; a hand-edited price is never overwritten (2026-11-19)

- **Apply** skips any variant that already carries a marker (`on_this_sale` / `on_other_sale`), so an interrupted run is finished by running it again, never reduced twice. It also skips variants whose compare-at is already above their price: they are already reduced, and a second cut would stack. A compare-at equal to the price (common on this shop) is not a reduction; it is kept as the original and put back on restore.
- **Restore** only resets variants still at the marker's sale price. A price changed by hand during the sale is a **conflict**: listed, left alone, restored only with `--force`. A variant already back at its original price and compare-at only has its marker removed (a previous restore stopped between "prices back" and "marker deleted"; that order is deliberate, so a failure leaves a variant restorable rather than reduced and unmarked).
- Every value written is absolute ("91.92"), so `shopifyGraphql`'s retry after a dropped connection cannot apply a reduction twice.

### Writes are isolated, and the scope is checked first (2026-11-19)

The app was read-only until this (`read_*` scopes only). Writing prices needs `write_products`. `scripts/lib/sale-prices/shopify-price-writer.mjs` is the only module that writes to Shopify. `apply` and `restore` read `currentAppInstallation.accessScopes` before anything else and stop with the steps to grant the scope, rather than failing mid-run.
