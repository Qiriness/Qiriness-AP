# sale-prices: « Prix soldés » (App Home UI extension)

The app's home page in Shopify Admin (Apps > Qiriness Email Agent). Pick a collection and a percentage, preview, apply: each variant's price drops and its old price becomes the compare-at, so the sale shows on the site, at checkout and in Google Ads. « Promotions en cours » lists every variant still on sale (read from the `qiriness_sale.original` markers) and restores the original prices.

- Target `admin.app.home.render` (API 2026-07), Preact + Polaris web components, no backend: Shopify GraphQL through direct API access (`src/shopify-graphql.js`), as the staff member using the page.
- Rules, reads, writes and the runner are shared with the CLI (`npm run sale:*`): `scripts/lib/sale-prices/`. Why it works this way: `docs/decisions/sale-prices.md`.
- Needs `write_products` in `shopify.app.toml`; without it the page shows the sales and previews but cannot apply or restore.
- Preview locally with `shopify app dev`; ships with `shopify app deploy`.
