# Marketing & funnel redesign: audit, metric map, what remains (2026-11-25)

The brief: turn Insights → Marketing & funnel into a decision tool — *where the next euro of marketing spend goes, and where the next hour of website work goes*. This file is the audit and the map from each requested metric to its source. The rules the build follows are in `docs/decisions/insights.md` § « Marketing & funnel, redesigned ». What shipped is in `CHANGELOG.md`; what is unproven, in `VALIDATION_LOG.md` item 69.

## 1. What the sources answer (measured on the live shop, 2026-11-25)

| Source | Already connected | What it answers | Measured limits |
| --- | --- | --- | --- |
| **ShopifyQL `sessions`** (`read_reports`, granted) | yes | sessions, visitors, bounce, cart / checkout / completed sessions, by device, country, landing page type and path, `referring_channel`, `traffic_type`, `utm_source/medium/campaign`, all combinable | no product or collection **views**, no checkout sub-step, no journeys. 30 days: 8,380 human sessions |
| **ShopifyQL `sales` with an attribution model** | yes | net / total sales, orders, **new customers** by channel and UTM campaign, `WITH LAST_NON_DIRECT_CLICK_ATTRIBUTION` (also last click, first click, linear, any click) | no landing page, device or country on `sales`. 191 of 451 own-store orders (30 days) have **no channel** (42%) |
| **ShopifyQL `sales` by `new_or_returning_customer`** | yes | new vs returning net sales | — |
| **ShopifyQL `sales` `cost_of_goods_sold`** | yes | gross profit | **almost no product costs are entered**: €796 of cost against €31.8k net sales in 30 days. Not usable for margins |
| **Meta Ads / Google Ads sync** (`ad_days`, `ad_campaign_days`, `ad_campaigns`) | yes (both connected; Google since 2026-11-19) | spend, impressions, clicks, purchase conversions and value per day, per placement, per campaign, campaign objective / channel type | no reach (so no frequency), no new-customer split, no attribution window stored; Google conversion tracking only meaningful from **2026-11-19** |
| **Klaviyo sync** (`klaviyo_campaigns`, `klaviyo_flow_days`) | yes | per campaign / per flow: recipients, delivered, unique opens, clicks, conversions, value | not synced: bounces, unsubscribes, spam, audience, flow **messages**, flow status / entrants, **sign-up forms**, list size |
| **`customers`** | yes | newsletter movement and capture (existing rows) | a snapshot of current consent, not an event log (`DECISIONS.md` § Insights) |
| **`orders`** | yes | every order, discounts, refunds, first order per customer | no acquisition source stored; `customerJourneySummary` exists in the Admin API (used read-only by `reports/qiriness-360-2026-11/acquisition.mjs`) but is not synced |
| **Web pixel / customer events** | **no** | would give `page_viewed`, `product_viewed`, `collection_viewed`, `product_added_to_cart`, the checkout steps, custom events | not built |

## 2. Metric map

Status: **Live** = built and reading real data · **Partial** = built with a stated gap · **Estimate** = needs an assumption the owner enters · **API** = needs a new call to a connected source · **Pixel** = needs new tracking · **Build** = data exists, analysis not built · **No** = no source can answer it.

### Marketing Performance

| Requested | Status | Source / reason |
| --- | --- | --- |
| Ad spend, website net sales, provider revenue, Shopify paid revenue | Live | ads sync; ShopifyQL ladder (own store); ShopifyQL attributed sales |
| Provider ROAS, Shopify ROAS, MER, new-customer MER (blended), new customers, blended CAC, CPA, new / returning revenue, revenue after ad spend | Live | `marketing-metrics.mjs` |
| Total measurable marketing costs, eMER | Estimate | equals ad spend until non-ad costs are configured; eMER shown « not configured » |
| Estimated contribution, break-even ROAS | Estimate | needs margin / cost assumptions (§ 3.3) |
| LTV:CAC, LTGP:CAC, cohorts, payback | Build | orders hold the history; first-order channel needs `customerJourneySummary` synced (§ 3.5) |
| YoY comparison on the KPIs | Build | the period picker's comparison is used; a YoY toggle is not built |
| Provider vs Shopify per provider: revenue, orders, ROAS, CPA, difference | Live | Google Ads, Meta Ads, Klaviyo; registry in `marketing-channels.mjs` |
| New customers / CAC per provider | Partial | Shopify side live; providers do not report new customers in our sync |
| Sessions, CVR, AOV, revenue / session, new share, revenue share, spend share per channel | Live | channel table |
| Paid / organic separation | Live | `classifyTraffic` (rules in the file header) |
| Attribution model switch | Live | `?attr=lndc|last|first|linear` |
| Attribution window, view-through, date basis, model, coverage, last sync | Partial | stated as text and per-provider sync age; the windows actually configured in each ad account are not read |
| Time series (metric / channel selection, granularity, annotations) | Build | ad_days are daily; ShopifyQL attributed sales take `TIMESERIES`. Annotations need a table (§ 3.4) |
| Google: brand vs non-brand | Estimate | needs a campaign classification (config); Search / PMax / Shopping split is live from the channel type |
| Meta: prospecting vs retargeting | Estimate | same; Facebook vs Instagram placements are on the Social panel |
| Meta frequency | API | reach is not stored per campaign |
| Klaviyo overview: Klaviyo vs Shopify email revenue, campaign / flow revenue, RPR, orders, Shopify email new customers | Live | |
| Klaviyo subscription cost | Estimate | to be entered |
| Campaign table: delivered, bounce, unsubscribe, spam, audience, Shopify revenue per campaign | API | Klaviyo `campaign-values-report` statistics `bounced`, `unsubscribes`, `spam_complaints`, `delivered`; Klaviyo links carry no `utm_campaign`, so per-campaign Shopify revenue needs Klaviyo's UTM settings changed |
| Apple MPP-adjusted open rate | API | the statistic synced (`opens_unique`) includes Apple privacy opens; whether Klaviyo's reporting API exposes an adjusted figure is unchecked. Until then the open rate carries the warning and tables sort by revenue |
| Flows per message, status, entrants, skipped | API | `flow-values-report` grouped by `flow_message_id`; flow status from `/flows` |
| Sign-up forms | API | `form-values-report` / `form-series-report` (views, submits, by device); « genuine new subscribers » and their later orders need profile source data |
| Newsletter health (existing rows) | Live | kept unchanged; engaged 30/60/90, inactive, bounce / spam rates need Klaviyo segment or profile reads (API) |

### Funnel & Website

| Requested | Status | Source / reason |
| --- | --- | --- |
| Four-step session funnel, rates, drop-off, previous period | Live | |
| Filters: channel, device, landing type, country | Live | country re-queries (`?country=`); the others fold in the browser |
| Filter: landing page, new vs returning visitor | API / Pixel | landing page is a column of the traffic cut but not offered as a filter yet; new vs returning visitor is not a `sessions` dimension |
| Landing type overview, per page table, search / sort / expand, channel and device breakdown, link | Live | |
| Revenue, orders, AOV, new-customer share **per landing page** | Pixel / API | `sales` has no landing page; needs per-order journeys (§ 3.5) or the pixel |
| Per page: subsequent navigation, products bought after landing | Pixel | |
| Collection landing performance by category | Live | categories from the advice layer's `axis` + the sales ranges + promo words |
| Collection browsing, product click-through, click position, filters / sorting, assisted revenue | Pixel | custom events (§ 3.1) |
| Product landing performance | Live | product pages in the landing table, with price band |
| All product views, specific-product add to cart, product view-to-purchase | Pixel | `product_viewed`, `product_added_to_cart` |
| Landing page × channel matrix (heatmap) | Live | page-level ROAS not shown (spend is not allocated across pages) |
| Mobile vs desktop throughout | Live | overall, per channel, per landing type, per page, checkout |
| Customer journeys | Pixel | |
| Checkout: cart → checkout → completed, by device / channel / landing | Live | |
| Contact, address, shipping, payment steps; shipping / payment methods; declines; express checkout; time to complete | Pixel (partly API) | checkout events; shipping lines and payment gateways of completed orders are in the order payload (API / sync change) |
| Free-delivery threshold analysis | Build | orders DB (`reports/qiriness-360-2026-11` q08_threshold_effect did it once) |
| Optimisation opportunities with segment benchmarks, sample sizes, confidence | Live | `website-opportunities.mjs` |
| Opportunity: campaign with high CAC and low customer value | Build | needs cohorts |
| Anomaly detection and alerts | Build | |

## 3. What the remaining work needs

### 3.1 Web pixel (behavioural tracking)

- **Shopify:** an app web pixel extension (`extensions/<name>`, type `web_pixel_extension`), scopes **`write_pixels`** and **`read_customer_events`** added to `shopify.app.toml`, `shopify app deploy`, the owner approves the new scopes. Consent: declare `customer_privacy` in the extension (`analytics: true`, `marketing: false`, `preferences: false`, `sale_of_data: "disabled"`) so Shopify only runs it for visitors who accepted analytics.
- **Events subscribed:** `page_viewed`, `collection_viewed`, `product_viewed`, `product_added_to_cart`, `checkout_started`, `checkout_contact_info_submitted`, `checkout_address_info_submitted`, `checkout_shipping_info_submitted`, `payment_info_submitted`, `checkout_completed`; plus custom events published by the theme (`collection_product_clicked` with position, `collection_filtered`, `collection_sorted`).
- **Kept per event:** event id (dedup key), name, timestamp, Shopify's `clientId` as the session key, page URL without query string, referrer host, landing path, UTM parameters (first page of the session), product / variant / collection ids, device class, country (from the checkout only), order id on `checkout_completed`. **Never:** email, address, payment data, names.
- **Ingest:** an app-proxy or public endpoint that validates the shop, rate-limits, deduplicates on event id and writes to a new `storefront_events` table (migration), with a retention rule. Aggregates per day are what the dashboard reads.
- **History:** none can be recovered. Every pixel figure starts on its activation date, which the dashboard must print.

### 3.2 Klaviyo sync additions

Campaign statistics `delivered`, `bounced`, `unsubscribes`, `spam_complaints` (columns on `klaviyo_campaigns`); flow messages (a `klaviyo_flow_message_days` table from `flow-values-report` grouped by `flow_message_id`); flow status; sign-up forms (`form-values-report`). Klaviyo's reporting limit (2 requests / minute, 225 / day) is already the constraint the nightly is shaped around (`DECISIONS.md` § Klaviyo).

### 3.3 Profitability inputs (migration + Settings screen)

A per-shop table of assumptions: default gross margin or product cost %, overrides per product range, payment fee % + fixed, shipping and fulfilment cost per order, packaging, gift / sample cost, other variable costs, monthly marketing software and agency costs. Contribution is then computed on **net sales**, which are already after discounts (discounts are not deducted twice), with COGS estimated at **list price × cost %**, not at net price × the margin, so a 30% promotion does not keep a 65% margin. Shopify's own `cost_of_goods_sold` replaces the estimate per product as costs are entered.

### 3.4 Annotations

A per-shop `marketing_annotations` table (date, end date, kind: campaign / budget / promotion / site / tracking / product, text). First row: **2026-11-19, Google Ads purchase conversion tracking activated** — any range or comparison spanning it carries a warning on Google figures.

### 3.5 Per-order acquisition and cohorts

Sync each online order's `customerJourneySummary` (first / last visit source, UTM, landing page; read-only Admin API, already used by the 360 report) into columns on `orders`. That unlocks revenue per landing page, first-order channel for cohorts (LTV:CAC by acquisition channel and month), and « products bought after landing ». About 40% of orders have no journey (consent), so every such figure needs its coverage printed.

### 3.6 Campaign classification

A per-shop rules table (provider, match on campaign name, class: brand / non-brand / prospecting / retargeting / other). Until it exists the dashboard shows the provider's own campaign type and says the split is not configured.

## 4. Deployment

What is built needs **no new permission, credential or pixel**: ShopifyQL runs on the granted `read_reports`, the ad and Klaviyo data come from the existing syncs. It needs a web deploy only. § 3.1 needs new Shopify scopes and owner approval; § 3.2–3.6 need migrations, which are applied to production (`docs/schema/database.md` → Migration files).
