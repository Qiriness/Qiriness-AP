# Qiriness — 360° e-commerce diagnosis and strategy foundations

*Prepared 2026-11-05 from the production database (read-only) and read-only Shopify Admin / ShopifyQL calls. Qiriness only — Barbara Gould data is stored in the same database and was excluded from every query (each SQL statement is pinned to the Qiriness `shop_id`; the runner refuses any statement without it).*

**Scope used everywhere unless stated:** Qiriness own-site DTC (Online Store + Shop app), qualifying orders processed **1 Mar 2025 – 31 Oct 2026** (20 completed months, Europe/Paris). Amazon and Yves Rocher/Mirakl (1,041 orders) are excluded; marketplace orders create one synthetic customer per order. **Money is net product revenue ex-VAT** (merchandise after discounts and refunds, ÷1.20, no shipping) unless marked TTC. Reproduce with `node reports/qiriness-360-2026-11/run.mjs` (SQL in `sql/`, outputs in `data/`).

---

## Deliverable 1 — Executive commercial diagnosis

**Health in one line:** a young (20-month) Shopify business at **€237k net ex-VAT over the last 12 months** (3,791 orders, 2,760 buyers, AOV €62.5). It grew +36% year on year for March–October, but has been **flat over the last three months** (Aug–Oct 2026 +3.6% vs 2025, with new customers −9%). Growth has come from repeat orders as the base matured, not from acquisition.

**Strengths**
- **A sticky core once the second order happens.** 52% of second-time buyers go on to a third order and 71% of third-time buyers to a fourth. The 891 repeat customers (26% of buyers) produce **54% of revenue**.
- **Some products build loyalty.** New customers who start on **Temps Sublime** buy again at **30.4% within 180 days**, against an 18.8% baseline, and are worth €119 at 180 days against €76. **Exception** (24.7%, €157) and **Éclat Parfait** (24.6%) also outperform.
- **Free and owned channels acquire well.** Organic search, Google Shopping free listings (`sag_organic`) and email account for most tracked acquisition at no media cost. Google Shopping free-listing customers repurchase at 20.4%.
- **The €70 free-shipping threshold works.** Orders bunch visibly just above it: 364 orders at €70–75 TTC against 188 at €65–70.

**Weaknesses**
- **Three in four first-time buyers never return.** New-customer repurchase is 4.9% at 30 days, 11.4% at 90 days, 18.8% at 180 days and about 25% at 365 days (Kaplan–Meier).
- **Cohort quality is falling.** Orders per new customer within 180 days dropped from 1.47 (Q2 2025 cohorts) to 1.21 (Q4 2025 and Q1 2026). The holiday cohorts (Nov–Jan, 980 customers) repurchase at only 13–18% in 180 days.
- **Qiriness sells almost nothing at list price.** About 95% of orders carry a markdown (crossed-out price) and/or a discount. Net revenue is **36.7% below list value**; for example, the Temps Sublime Duo is listed at €179 and was sold at €89.50 in most months. Price is no longer a lever for creating events; it is the baseline.
- **CRM runs on blasts, not lifecycle.** There are 403 campaigns since September 2025, about 31 per month and roughly one a day per subscriber. There are no post-purchase, second-purchase, replenishment or win-back flows; the welcome series only started on 22 Oct 2026. Flows earn €6.8 per delivered email (abandoned cart) against **€0.05** for campaigns.

**Largest retention problem:** converting the first purchase into a second. 2,104 new customers have bought only once. The median gap to the second order is 105 days (interquartile range 43–180), so the window to intervene runs from about day 30 to day 180.

**Largest acquisition problem:** new-customer volume has stalled (Aug–Oct 2026: 242 vs 265 a year earlier). The one paid test was uneconomic: €9.7k of Meta spend between Nov 2025 and Feb 2026 brought **99 tracked new customers** (about €98 per customer, or roughly €59 if the untracked share is scaled in). Those customers had a €36 first AOV and 7% repurchase. Meanwhile most new customers enter on low-retention products: masks, patches, CC/BB creams and devices.

**Largest basket-value opportunity:** 51% of orders contain a single paid product (AOV €46.9, against €63.7 for two products). Routine completion is very low: only **7.2%** of Temps Sublime buyers have ever bought the Regard Sublime eye cream.

**Top five recommendations**
1. **Build a 0–180-day second-purchase programme** (Klaviyo post-purchase series branched by entry range, plus on-site routine completion), with a 10–20% holdout. Base case: +€13k ex-VAT a year.
2. **Make replenishment and routine completion always-on.** Trigger reminders at each product's measured reorder window, starting with Temps Sublime Duo, CC Crème, Soin Bonne Mine Homme, Source d'Eau, Vitamin C serum and Niacinamide cream. About 380 customers are due now.
3. **Lead acquisition moments with retention-quality entry products** (Temps Sublime Duo/serum, Regard Sublime, Exception, Éclat Parfait) rather than wraps, patches and LED devices. Apply this first to Black Friday 2026, the biggest acquisition week of the year.
4. **Cut campaign volume and move effort into flows.** Target 8–12 segmented campaigns a month instead of 20–65. The proposed "one theme per month" newsletter is not the gap; lifecycle automation is.
5. **Put promotions under test, not habit.** Run holdouts on the welcome code (it shows no retention benefit over full price within the same quarter) and on existing-customer codes (SUMMER30, VIP40, QIRINESS30; only 12–13% of their orders are from new customers). Use thresholds and gifts with purchase (gift-led baskets average €92) instead of extra percentage discounts on already marked-down prices.

---

## Deliverable 2 — Quantitative analysis

### 2.0 Data discovery and validation

| Source | Available? | Coverage | Reliability |
|---|---|---|---|
| Orders, order lines (incl. discounts, refunds, tags, codes) | Yes | 6,332 Qiriness orders; real volume from 2025-03 | High. Reconciles with ShopifyQL to −0.4% over 20 months (worst month −2.6%) |
| Customers (consent, tags, Shopify RFM group) | Yes | 61,647 profiles, of which **51,770 were imported on 2025-04-14** from the previous platform with no order history | High for consent; lifetime counters cover Shopify only |
| Products, variants, collections | Yes | 123 products; only 5 "range" collections mapped → range and need **derived from titles** (99.5% of revenue classified) | Medium |
| Promotions / discount applications | Yes | 366 discounts; per-order applications and codes | High. **Markdowns are not discounts** (see 2.6) |
| Sessions / conversion | Yes | Monthly (DB) to 2026-09; by referrer source (ShopifyQL) | Medium |
| Acquisition source / UTM | Via Shopify API | `customerJourneySummary` for all 5,174 orders; **58–64% have a journey** (consent and tracking gaps) | Medium. 40% unknown, and "unknown" ≠ "direct" |
| Klaviyo | Aggregates only | 403 campaigns (Sep 2025→), 8 flows by day | Counts and attributed value only; no profiles, unsubscribes, bounces or list size |
| Paid media | Partly | Meta: 5 campaigns, €9,690, Nov 2025–Feb 2026 | High for spend |
| Smile.io | **No** | — | Unavailable |
| COGS / margin | **No** | — | Unavailable: all economics are revenue, not contribution |
| Customer service | Yes (not used here) | Tickets and cases | — |

**Population funnel** (`q01_exclusion_funnel`): 5,174 qualifying orders. Excluded: Amazon 624, Mirakl 417, Nov 2026 partial 52, fully refunded 31, internal/test codes 12 (`LAPFAM26`, `pattest`), zero-merchandise orders 7, draft orders 6, pre-launch strays 6, cancelled 3.

**Data-quality findings that matter**
- **VAT:** Shopify recorded almost no tax before July 2026 (≈3% of sales, against ≈17% after). **Shopify's own "net sales" before July 2026 therefore includes VAT**, which flatters any year-on-year comparison made in the admin. This analysis uses TTC ÷ 1.2 throughout, so the series is consistent.
- **Legacy customers:** 814 of the 3,478 Shopify buyers are imported legacy customers. Counted as "new", they would inflate 2025 acquisition by 70% (Mar–Oct 2025: 659 genuinely new + 461 legacy). Every acquisition and cohort metric below separates them.
- **Duplicates:** only 3 email hashes map to two customer records. Guest checkout is reconciled by Shopify.
- 6,382 sample lines and 1,322 gifted (100%-discount) lines are excluded from product metrics, so gifts with purchase don't create fake product pairs.
- 541 lines have no product id (a deleted product, the *Accessoire d'Acupression*); they are keyed by title.

**Definitions.** Gross = Σ line `original_total`. Net = `subtotal_price` − refunds (capped at the merchandise value), ÷1.2. Qualifying order = net > 0. New customer = first qualifying order, not legacy. Returning = order rank ≥ 2. Repeat rate = share with a later order. Windows are counted from the first order. A cohort metric is shown only when the whole cohort has had the full window (as of 2026-11-01).

### 2.1 Headline windows (`q02_periods`)

| Window | Orders | Buyers | New | Legacy first | Net ex-VAT | AOV | Orders/buyer | % revenue repeat | Orders with discount app. |
|---|---|---|---|---|---|---|---|---|---|
| Full Mar 25–Oct 26 | 5,174 | 3,478 | 2,664 | 814 | €324.4k | €62.70 | 1.49 | 35.8% | 49.5% |
| T12 Nov 25–Oct 26 | 3,791 | 2,760 | 2,005 | 353 | €237.0k | €62.52 | 1.37 | 40.9% | 46.4% |
| T6 May–Oct 26 | 1,516 | 1,247 | 702 | 81 | €91.2k | €60.13 | 1.22 | 51.8% | 68.5% |
| T3 Aug–Oct 26 | 528 | 491 | 242 | 26 | €32.8k | €62.11 | 1.08 | 53.3% | 66.5% |
| Mar–Oct 2025 | 1,383 | 1,120 | 659 | 461 | €87.4k | €63.18 | 1.24 | 22.1% | 57.9% |
| Mar–Oct 2026 | 1,909 | 1,485 | 892 | 113 | €118.9k | €62.29 | 1.29 | 50.9% | 65.6% |

**What drove the +36% (Mar–Oct 2025 → 2026):** repeat orders went from 263 to 904 (+641) and genuinely new customers from 659 to 892 (+233), while legacy first orders fell from 461 to 113 (−348) and AOV was flat (€63.2 → €62.3). The growth is base maturation plus modest acquisition growth, not basket or price. Over the last three months even that has stopped.

### 2.2 Monthly trend (`q02_monthly`, chart-ready)

| Month | Orders | New | Legacy 1st | Returning buyers | Net ex-VAT | AOV | Sessions | Conv. % |
|---|---|---|---|---|---|---|---|---|
| 2025-03 | 54 | 53 | 0 | 1 | 2,801 | 51.9 | 4,501 | 0.89 |
| 2025-04 | 111 | 76 | 31 | 4 | 8,059 | 72.6 | 4,863 | 1.58 |
| 2025-05 | 159 | 87 | 58 | 13 | 10,662 | 67.1 | 5,476 | 1.86 |
| 2025-06 | 223 | 60 | 121 | 40 | 14,865 | 66.7 | 4,694 | 2.81 |
| 2025-07 | 329 | 118 | 134 | 71 | 19,343 | 58.8 | 8,154 | 2.20 |
| 2025-08 | 243 | 142 | 59 | 41 | 13,686 | 56.3 | 7,114 | 1.97 |
| 2025-09 | 124 | 56 | 33 | 34 | 8,140 | 65.6 | 5,839 | 1.15 |
| 2025-10 | 140 | 67 | 25 | 45 | 9,821 | 70.2 | 5,400 | 1.46 |
| 2025-11 | 619 | 308 | 114 | 178 | 42,256 | 68.3 | 9,425 | 3.82 |
| 2025-12 | 471 | 318 | 52 | 99 | 28,591 | 60.7 | 10,359 | 2.55 |
| 2026-01 | 572 | 354 | 54 | 158 | 34,098 | 59.6 | 10,993 | 3.27 |
| 2026-02 | 220 | 133 | 20 | 65 | 13,175 | 59.9 | 7,124 | 1.94 |
| 2026-03 | 166 | 93 | 14 | 58 | 12,528 | 75.5 | 5,864 | 1.69 |
| 2026-04 | 227 | 97 | 18 | 109 | 15,219 | 67.0 | 4,627 | 2.83 |
| 2026-05 | 350 | 184 | 24 | 134 | 19,850 | 56.7 | 5,480 | 3.94 |
| 2026-06 | 252 | 99 | 16 | 126 | 15,148 | 60.1 | 4,390 | 3.26 |
| 2026-07 | 386 | 177 | 15 | 183 | 23,368 | 60.5 | 5,670 | 4.09 |
| 2026-08 | 142 | 69 | 6 | 66 | 7,879 | 55.5 | 4,164 | 2.04 |
| 2026-09 | 234 | 96 | 12 | 118 | 15,140 | 64.7 | 5,473 | 2.59 |
| 2026-10 | 152 | 77 | 8 | 62 | 9,772 | 64.3 | n/a | n/a |

Sessions in 2026 are flat to down compared with 2025, while conversion is higher. **Traffic, not conversion, caps acquisition.** Units per order are stable at 2.4–3.4. The refund rate is negligible (€255 TTC of refunds on qualifying orders, plus 31 fully refunded orders).

### 2.3 Revenue composition (`q03_*`)

| Range (derived) | Net full | T12 | Mar–Oct 25 → Mar–Oct 26 | Buyers | Rev. on discount-app orders |
|---|---|---|---|---|---|
| Temps Sublime | 76.4k | 54.9k | 21.5k → 29.7k | 780 | 53% |
| Source d'Eau | 37.5k | 26.7k | 10.7k → 16.4k | 682 | 57% |
| Masques, wraps & patchs | 33.0k | 23.4k | 9.6k → 10.4k | 1,164 | 65% |
| Active Énergie | 24.3k | 15.4k | 9.0k → 8.0k ↓ | 460 | 44% |
| Appareils & SPA (LED, acupression, sauna) | 24.2k | 21.7k | 2.5k → 5.7k | 234 | 32% |
| Homme | 23.9k | 17.4k | 6.5k → 8.0k | 460 | 35% |
| Regard (Éclat / Sublime) | 21.9k | 18.7k | 3.2k → 9.5k | 577 | 55% |
| Exception | 20.7k | 14.8k | 5.9k → 7.9k | 165 | 56% |
| Teint & solaire (CC/BB/UV) | 19.3k | 13.5k | 5.9k → 6.9k | 528 | 50% |
| Nettoyage & lotions | 14.4k | 10.0k | 4.4k → 5.8k | 469 | 56% |
| Éclat Parfait | 10.4k | 6.6k | 3.8k → 2.9k ↓ | 233 | 44% |
| Corps / Qi / Sensi Zen | 16.9k | 13.0k | 3.9k → 7.3k | — | — |

By need: anti-ageing 35% of revenue, hydration 16%, radiance/complexion 14%, eyes 14%, cleansing/purifying 9%, devices/SPA 7%, body 4%.

**Concentration is low.** The top product (LED mask) is 6.8% of revenue, the top 5 are 23%, the top 20 are 54% (HHI 225). The dependency is on **one range (Temps Sublime, 24%)** and on **promotional periods**, not on single SKUs. Geography: France 82% of revenue; BE 6.6%, IT 3.7%, NL 2.7%, ES 1.9%. Non-French baskets are larger (€72–89 against €60) and repeat more (BE 41%, NL 47% against FR 32% of orders).

Revenue by order rank (`q03_lifecycle_mix`): first orders (new) €153.0k at €57.4 AOV; first orders (legacy) €55.2k at €67.8; second €59.7k at €67.0; third €26.6k at €69.0; fourth and later €29.9k at €71.2. **AOV rises with loyalty.**

### 2.4 Retention, cohorts and frequency (`q04_*`)

**Pooled repurchase, new customers who have had the full window** (legacy customers in brackets):

| Window | Eligible | 2nd order | 3rd order |
|---|---|---|---|
| 30 d | 2,592 | 4.9% (5.1%) | 0.5% |
| 60 d | 2,495 | 8.3% (9.4%) | 1.0% |
| 90 d | 2,424 | 11.4% (13.7%) | 2.0% |
| 180 d | 1,985 | 18.8% (30.9%) | 5.7% |
| 270 d | 1,684 | 23.2% (39.7%) | 8.8% |
| 365 d | 659 (early cohorts only) | 33.5% (49.0%) | 15.6% |

Kaplan–Meier (all new customers, censored): 4.8% at 30 d, 11.1% at 90 d, 17.9% at 180 d, **25.2% at 365 d**, 29.0% at 540 d. The pooled 365-day figure of 33.5% is flattered by the strong spring 2025 cohorts.

**The ladder** (`q04_transitions`, new customers, each step observed for at least 180 days):

| From order | Eligible | Next within 180 d | Next ever | Median gap |
|---|---|---|---|---|
| 1 → 2 | 1,985 | **18.8%** | 25.1% | 99 d |
| 2 → 3 | 349 | 42.7% | 52.4% | 86 d |
| 3 → 4 | 117 | 64.1% | 70.9% | 83 d |
| 4 → 5 | 53 | 64.2% | 67.9% | 55 d |
| 5+ → next | 52 | 82.7% | 82.7% | 50 d |

**Answer to the critical question:** Qiriness loses the most potential repeat buyers between the first and second purchase. About 75% are lost there, against about 48% at 2→3 and about 29% at 3→4. Converting 1→2 is the largest opportunity by a wide margin. 2→3 is the second; increasing frequency among loyal customers is small in absolute terms (only 209 customers have 4+ orders).

**Monthly cohorts, new customers** (`q04_cohorts`). Rates are 2nd order within the window; value is cumulative ex-VAT per customer.

| Cohort | n | 1st AOV | r90 | r180 | r365 | Value 180 d | Value 365 d |
|---|---|---|---|---|---|---|---|
| 2025-04 | 76 | 75.2 | 21.1 | 38.2 | 51.3 | 122.7 | 168.1 |
| 2025-05 | 87 | 62.8 | 21.8 | 28.7 | 39.1 | 98.4 | 127.0 |
| 2025-07 | 118 | 50.3 | 8.5 | 26.3 | 32.2 | 73.6 | 86.1 |
| 2025-08 | 142 | 49.8 | 5.6 | 17.6 | 24.6 | 73.6 | 84.7 |
| 2025-10 | 67 | 64.4 | 13.4 | 19.4 | 31.3 | 87.1 | 110.2 |
| **2025-11** | 308 | 63.8 | 14.3 | 17.9 | — | 81.5 | — |
| **2025-12** | 318 | 58.2 | 9.7 | **12.9** | — | 67.4 | — |
| **2026-01** | 354 | 53.7 | 8.5 | **13.8** | — | 66.1 | — |
| 2026-02 | 133 | 59.7 | 8.3 | 15.0 | — | 75.3 | — |
| 2026-03 | 93 | 74.4 | 9.7 | 20.4 | — | 92.9 | — |
| 2026-04 | 97 | 55.4 | 16.5 | 21.6 | — | 71.1 | — |
| 2026-05 | 184 | 52.2 | 13.6 | — | — | — | — |
| 2026-07 | 177 | 58.2 | 8.5 | — | — | — | — |

Frequency is **deteriorating across comparable cohorts**: orders per new customer within 180 days were 1.47 for Q2 2025, 1.31 for Q3 2025 and 1.21 for Q4 2025 and Q1 2026 (`q04_frequency_trend`). The large promotional cohorts (Black Friday, Christmas, Soldes) are the weakest.

**Time between orders** (`q04_gaps`): 1→2 has a median of 105 d (p25 43, p75 180, p90 261). 2→3 has a median of 84 d. Later gaps have a median of 69 d. 19% of second orders happen within 30 days, which is probably "forgotten items" or the next promo.

**Order-count distribution** (`q04_frequency`):

| Orders | Customers | % customers | Net | % revenue | Avg value |
|---|---|---|---|---|---|
| 1 | 2,587 | 74.4% | €148.3k | 45.7% | €57 |
| 2 | 505 | 14.5% | €65.6k | 20.2% | €130 |
| 3 | 192 | 5.5% | €38.4k | 11.8% | €200 |
| 4–5 | 137 | 3.9% | €41.6k | 12.8% | €303 |
| 6+ | 57 | 1.6% | €30.6k | 9.4% | €537 |

### 2.5 Segmentation (`q05_segments`, as of 2026-11-01)

Thresholds come from the gap distribution, not arbitrary RFM bands: for one-time buyers, "natural window" runs to 180 d (the 1→2 p75); for repeat buyers, "active" runs to 150 d (repeat p75 116–145 d) and "lapsed" starts after 270 d (beyond p90).

| Segment | Customers | % | Revenue % | AOV | Avg orders | Recency | Email-subscribed | Commercial opportunity |
|---|---|---|---|---|---|---|---|---|
| 01 New (1 order, ≤60 d) | 186 | 5% | 3% | 60 | 1.0 | 32 d | 146 (79%) | Post-purchase series, the highest-leverage moment |
| 02 One order, natural window (61–180 d) | 503 | 14% | 8% | 54 | 1.0 | 126 d | 312 (62%) | Replenishment and routine completion **now** |
| 03 One order, at risk (181–365 d) | 1,252 | 36% | 23% | 60 | 1.0 | 296 d | 737 (59%) | Mostly the BF/Christmas 2025 cohort; one targeted win-back |
| 04 One order, lost (>365 d) | 646 | 19% | 11% | 55 | 1.0 | 474 d | 332 (51%) | Low priority; campaigns only |
| 05 Champions (4+ orders, ≤150 d) | 151 | 4% | **18%** | 70 | 5.3 | 77 d | 141 (93%) | Recognition, early access; don't discount |
| 06 Repeat active (2–3, ≤150 d) | 309 | 9% | 14% | 63 | 2.4 | 81 d | 251 (81%) | Push to the 3rd order (52% will anyway) |
| 07 Repeat at risk (151–270 d) | 172 | 5% | 9% | 67 | 2.5 | 195 d | 139 (81%) | **Best reactivation target** (€172 average history) |
| 08 Repeat lapsed (>270 d) | 259 | 7% | 13% | 69 | 2.4 | 351 d | 187 (72%) | Win-back with their favourite range |

Overlays: **discount-sensitive** customers (every order on a discount application) number 194 of the 891 repeaters. They have *fewer* orders (2.4 against 4.1 for mostly-full-price repeaters) and a 21% realised discount. **High-basket** customers (top-decile AOV) number 348. Favourite range of lapsing repeaters: Temps Sublime 114 (84 subscribed, €24.6k historical), Source d'Eau 62, Masques 46, Homme 43, Active Énergie 40.

**Consent** (`q05_consent`): 6,631 SUBSCRIBED profiles, of which 2,245 are DTC buyers (65% of buyers are reachable). Of the 51.8k imported legacy profiles, **only 1,110 are subscribed** and 45,974 have never bought on Shopify and are not subscribed. That list is not a marketing asset. Shopify's own `rfm_group` is consistent with our segments but labels 978 one-time buyers "DORMANT" at 417 days.

### 2.6 Promotions and price (`q10_*`, `q14_*`)

**Markdowns (compare-at prices) are the dominant promotion and invisible to "discount" fields.** The share of orders with any price incentive (discount application or marked-down line) was 92–100% in every month from Nov 2025 to Oct 2026 except Feb, Mar and Aug (84–89%). Over the T12, net revenue was **€233.9k against a list value of €369.7k (−36.7%)**: markdowns took 34.0 points and discount applications about 3.

| Product (T12) | Units | List TTC | Avg net paid TTC | Reduction | Units at list |
|---|---|---|---|---|---|
| Duo Jour & Nuit Temps Sublime | 233 | €179.00 | €92.69 | 48% | ~0% |
| Caresse Éclat Parfait | 155 | €62.90 | €29.19 | 54% | 3% |
| Soin Bonne Mine Homme | 527 | €33.50 | €18.86 | 44% | 7% |
| Caresse Regard Énergie | 194 | €51.90 | €29.21 | 44% | 2% |
| Caresse Source d'Eau | 247 | €51.90 | €37.38 | 28% | 19% |
| Wrap d'Or | 569 | €8.90 | €6.59 | 26% | 44% |

On top of markdowns, discount applications cut a further 9.9% of gross in the T12 (€26.1k ex-VAT). The most-used offers (`q10_offers`):

| Offer | Orders | AOV | Depth | % new 1st orders | New-cust. 2nd within 180 d |
|---|---|---|---|---|---|
| Wrap Vitaminé offert dès 65 € (gift) | 479 | **€92.0** | 18.8% | 34% | n<30 |
| BIENVENUEQIRINESS (welcome code) | 373 | €53.1 | 19.9% | 80% | 16.8% |
| Masque Or offert (gift) | 325 | €52.8 | 12.0% | 47% | — |
| 3+1 masques offert | 248 | €50.5 | 13.1% | 58% | 18.6% |
| SUMMER30 | 137 | €71.7 | 29.2% | **12%** | — |
| NOEL | 119 | €54.4 | 24.7% | 61% | 12.3% |
| MONPANIER10 (abandoned cart) | 113 | €66.4 | 12.7% | 59% | 19.4% |
| VIP40 / QIRINESS30 | 22 / 17 | €75 / €87 | 13–30% | **12–13%** | — |

- **Deeper discounts don't build bigger net baskets.** By order discount depth: 0% gives €60.2 AOV, under 10% gives €83.7, 10–20% €69.0, 20–30% €57.4, 30%+ €62.9. The shallow, threshold-type incentives are the ones associated with large baskets.
- **Discounted first orders don't retain better.** Within the same cohort quarter, a code-led first order versus full price gave 30.5 vs 27.9 (Q2 2025), 17.7 vs 25.9 (Q3), 13.7 vs 16.1 (Q4) and 17.2 vs 14.3 (Q1 2026) on 180-day repurchase. There is no consistent advantage, so the welcome code buys conversion, not loyalty. Almost every first order carries a markdown, so a clean full-price control does not exist.
- **Repeat demand is promotion-timed.** Repeat orders per 100 "due" customers were 26.5 in Nov, 27.7 in Jan and 21.0 in Jul, against 5–9 in Feb–May (`q12_repeat_demand_by_month`). The share of repeat orders carrying a discount application rose from 24–27% (Q4 2025–Q1 2026) to 69–78% (Q2–Q4 2026), driven by always-on gifts with purchase. That is consistent with **customers having learnt to buy during offers**. It is not proof: campaign intensity is also higher in those months.
- **Promotion incrementality cannot be measured from this data** (there is no holdout and no stable list-price baseline). The Black Friday week (24 Nov 2025: 245 orders, 124 new) is followed by a run-down to 66 orders in Christmas week and a January rebound. There is no clear pre-event dip, so pull-forward is inconclusive.

### 2.7 Products, replenishment and associations (`q03_products`, `q06_*`, `q08_*`, `q13_*`)

**Entry range vs retention** (new customers, first order at least 180 days old):

| Entry range | New customers | 1st AOV | 2nd within 180 d | Value 180 d | Median days to 2nd |
|---|---|---|---|---|---|
| Temps Sublime | 405 | €86.6 | **30.4%** | €119 | 73 |
| Exception | 97 | €105.4 | 24.7% | €157 | 50 |
| Éclat Parfait | 81 | €61.6 | 24.6% | €98 | 69 |
| Active Énergie | 157 | €67.1 | 22.0% | €83 | 120 |
| Source d'Eau | 317 | €53.9 | 19.1% | €73 | 115 |
| Homme | 268 | €39.3 | 17.4% | €49 | 117 |
| Regard | 267 | €38.3 | 16.3% | €51 | 68 |
| Teint (CC/BB/UV) | 256 | €38.3 | 14.7% | €47 | 110 |
| Masques, wraps & patchs | 408 | €33.1 | **14.2%** | €44 | 87 |
| Appareils & SPA (LED…) | 143 | €138.0 | **7.2%** | €147 | 64 |

The best single entry products (n ≥ 25, baseline 18.8%) are the Caresse Regard Sublime eye cream (42.3%), Duo Jour & Nuit Temps Sublime (40.4%), Élixir Éclat Parfait (38.9%), Sérum Booster Vitamine C Temps Sublime (38.1%), Coffret Source d'Eau (34.6%) and Caresse d'Exception (30.0%). The weakest are the LED mask (9.0%), Kit Rituel Hydratant (6.7%), Wrap Purifiant (5.7%), Coffret Source d'Eau Rituel Intense (8.0%), Sauna (10.7%) and Voile Source d'Eau (11.0%). First orders with 3+ products repurchase at 24.3%, against 16.2% for single-product orders. *These are correlations: high-intent customers choose serums and treatment creams.*

**Replenishment windows** (exact product, measured; `q06_replenishment`):

| Product | Buyers | Reorder same product (ever) | Median days | p25–p75 | Note |
|---|---|---|---|---|---|
| Duo Jour & Nuit Temps Sublime | 170 | 22.9% | 117 | 81–215 | 57% of buyers order again (any product) |
| Élixir Source d'Eau | 107 | 21.5% | 106 | 65–163 | |
| Soin Bonne Mine Homme (CC Homme) | 293 | 21.5% | 127 | 74–196 | 1.83 units/order: buy-in-pairs behaviour |
| Crème Yeux Regard d'Exception | 50 | 22.0% | 110 | 59–150 | |
| Sérum d'Exception | 41 | 19.5% | 107 | 81–114 | narrowest window |
| Mousse Divine | 116 | 19.8% | 159 | 106–201 | |
| Caresse Source d'Eau | 215 | 17.2% | 161 | 96–215 | |
| Lotion Exquise | 106 | 17.9% | 64 | 27–188 | |
| Caresse Éclat Parfait (Niacinamide) | 144 | 16.0% | 135 | 64–166 | |
| Sérum Vitamine C Temps Sublime | 128 | 15.6% | 110 | 47–185 | |
| CC Crème Gel Teinté | 313 | 14.1% | 149 | 76–218 | |

Masks, wraps and devices are **not** replenishment products (same-product reorder 1–11%; devices 2%). At range level, Temps Sublime (27.4% re-buy the range), Source d'Eau (23.6%) and Homme (21.7%) are the replenishment families. Homme is a closed loop: 73.5% of next orders after a Homme order contain Homme again.

**Due now** (`q13_replenishment_due`; last purchase of the product inside its p25–p75 window and no order since): CC Crème 73 (51 subscribed), Temps Sublime Duo 62 (49), Soin Bonne Mine Homme 59 (40), Lotion Exquise 33, Vitamin C serum 28, Niacinamide 25, Mousse Divine 24, Élixir Source d'Eau 22, Caresse Source d'Eau 21. That is **≈380 customers (~270 reachable) at any time**, plus ≈550 overdue to 365 days.

**Associations** (same order, paid lines, n ≥ 12; `q08_product_pairs`). Lift > 7 with meaningful support:

| Routine | Pair orders | Confidence | Lift |
|---|---|---|---|
| Caresse d'Exception + Regard d'Exception (+ Élixir d'Exception) | 29 / 23 / 16 | 22–40% | 15–19 |
| Ginger Gel Purifiant + Lotion Kéfir | 51 | 34–39% | 13.5 |
| Homme: Crème Anti-Âge + Baume / Fluide / Nettoyant | 17–20 | 17–23% | 11–12 |
| Éclat Parfait: Caresse + Élixir (+ Lotion tonique) | 32 / 15 / 19 | 11–37% | 7–11 |
| Active Énergie Lift crème + sérum | 39 | 18–33% | 8.1 |
| Élixir Temps Sublime + Caresse Regard Sublime | 16 | 14–18% | 8.5 |
| Élixir Source d'Eau + Caresse Source d'Eau Riche | 23 | 15–22% | 7.5 |
| Wraps (Apaisant + Purifiant, Hyal-Aqua + Éclat…) | 36–70 | 18–53% | 7–13 (the "3+1" offer drives these) |

Range-level lifts are weak (all < 2.7), so customers build routines **within** a range, not across ranges. Across orders, the next order repeats the same range 59–74% of the time (Exception, Temps Sublime, Source d'Eau, Homme). Device buyers' next orders go to masks and wraps (42%).

**Routine-completion gaps** (bought A, never B; reachable = subscribed and active within 12 months; `q13_routine_gaps`): Temps Sublime → Regard Sublime eye cream **428** (only 7.2% completed); Homme CC → nettoyant 134; Source d'Eau crème → élixir 104; Temps Sublime crème → sérum 77; Active Énergie crème → sérum 73; Éclat Parfait crème → élixir 66; LED mask → wraps 56; Exception crème → yeux 45 / → sérum 44; Ginger gel → Kéfir 43.

**Basket structure:** 51% of orders have one paid product (AOV €46.5), 24% two (€64.7), 14% three (€82.3), 12% four or more (€105.5). 448 T12 orders sit at €50–70 TTC, just below free shipping.

**Strategic classification**

| Role | Products/ranges | Evidence |
|---|---|---|
| **Hero + retention** | Temps Sublime (Duo, Vit C serum, Élixir), Caresse Regard Sublime | 24% of revenue; best entry retention (30–42%); highest re-buy of range |
| **Retention / replenishment** | Source d'Eau (Caresse, Élixir), Soin Bonne Mine Homme, Exception, Mousse Divine | 17–23% same-product reorder at 106–160 d |
| **Premium routine** | Exception trio | Highest 180-day value (€157), lift 15–19, small base (165 buyers) |
| **Acquisition (volume)** | Wraps, patches (Wrap d'Or, Regard d'Or, Hyal-Éclat), CC/BB, Google Shopping | Cheapest first baskets (€33–38), 1,164 buyers, but 14% repurchase |
| **Basket builders** | Gift-with-purchase wraps (65 € threshold), 3+1 masks, Lotion Kéfir, eye serums | Gift baskets average €92; high-lift add-ons |
| **Hero (revenue), weak retention** | LED mask, acupression accessory, Sauna | Top revenue SKU (€28.7k TTC) but 9% repurchase. Treat as a gift/event product and follow up with consumables |
| **Promotional** | Coffrets/kits, Temps Sublime Duo at −50% | Sets are 28–34% of revenue in Jul–Aug and Dec; Duo almost never sold at list |
| **Underperformers** | Sensi Zen, Kit Rituel Spa (Glow Or, Corps, Hydratant), Gua Sha, Roller | < €2k each, low repeat |

### 2.8 Acquisition (`acq_*`, Shopify journey data)

New customers by first-touch channel (Mar 2025–Oct 2026; 58–64% of orders have journey data):

| First touch | New customers | 1st AOV | 1st on discount app | 2nd within 180 d | Value 180 d |
|---|---|---|---|---|---|
| Unknown (no journey) | 1,043 | €57.5 | 48% | 20.5% | €75.5 |
| Search (organic) | 716 | €61.5 | 49% | 16.4% | €80.8 |
| Direct / untracked | 324 | €66.4 | 50% | 19.0% | €95.3 |
| Google Shopping free listings | 298 | €41.3 | 37% | 20.4% | €56.8 |
| Email (Klaviyo) | 136 | €65.3 | 56% | **31.9%** | €101.3 |
| **Paid social (Meta)** | 99 | **€36.2** | 33% | **7.1%** | **€44.9** |
| AI assistants (ChatGPT, Perplexity) | 18 | €37.4 | — | n<10 | — |

- **Paid social economics:** €9,690 spend for 99 tracked new customers gives a CAC of about €98. Scaling for untracked orders gives about €59. Meta's own figures are 339 conversions and €10.3k TTC value (ROAS 1.06 on its attribution). The 180-day value of €45 ex-VAT is below CAC before any product cost. **Not profitable as run**; the creative landed buyers on low-value entry products.
- Sessions by source (ShopifyQL, T12): direct 60k sessions at 2.0% conversion, search 31k at 2.8%, social 6.5k at 1.4%, email 1.4k at 4.3%, paid 1.1k at 0%.
- Genuinely new customers' share of revenue: 43% in Mar–Oct 2025 (plus 35% from legacy first orders), 49% in the T12, 40% in the T3. Repeat orders' share rose from 22% to 51% (Mar–Oct 2025 → 2026). **Growth increasingly depends on existing customers** while the inflow of new ones stalls.
- High-quality new customers look like this: entry via a treatment product (serum, eye cream, Duo), first basket ≥ €35 ex-VAT with 2+ products, arriving from email or search. Low-quality ones come via paid social or a single mask, patch or device.

### 2.9 Klaviyo and loyalty (`q11_*`)

| | Value |
|---|---|
| Campaigns | 403 (Sep 2025–Nov 2026); 19–65 per month; average 4–11k recipients |
| Campaign deliveries | 108k–318k per month, ≈ **20–48 emails per Shopify-subscribed profile per month** (Klaviyo list size not synced, so this is an upper estimate) |
| Campaign click rate | 0.7–2.2% (best months: Nov 2025 2.1%, Sep 2026 2.2%) |
| Campaign attributed value | €0.02–0.09 per delivered; €50 per 1,000 |
| Flows | Abandoned cart €10.9k (€6.82 per delivered, 14% CTR); browse abandonment €2.6k (€4.32); new checkout/cart series (Oct 2026); birthday €0.03 per delivered; welcome started 22 Oct 2026 |
| Missing flows | Post-purchase, second purchase, replenishment, cross-sell, win-back, VIP |
| Attribution | Klaviyo claims **24–61%** (typically 45–60%) of DTC revenue each month. Shopify last-touch email accounts for only **14% of orders** (≈23% of orders with journey data). Klaviyo's open-based attribution overstates email by 2–3×; treat it as attribution, not incrementality |
| Unsubscribes, bounces, deliverability | **Not available** in the synced data |
| Smile.io | **Not available**: no points, tiers or redemptions in the DB. Loyalty incrementality cannot be assessed |

The best campaigns are event-driven (Black Friday days, flash offers, Soldes: €260–380 per 1,000). Mid-size targeted sends (5–10k) yield €62.6 per 1,000, against €49.4 for 10–20k blasts. This is weak but directional evidence that segmentation pays.

### 2.10 Seasonality (`q12_*`, one year; treat as hypotheses)

| Month | Net (latest) | What the data shows |
|---|---|---|
| Jan | €34.1k | Soldes; 354 new customers; markdowns on 91% of orders; devices 12.6% of revenue |
| Feb | €13.2k | Trough after Soldes; eyes peak (17.7% share); Valentine's (VDAY 66 orders) |
| Mar | €12.5k | Low; devices still 18.7%; lowest eye share |
| Apr | €15.2k | **Anti-ageing peak (40.5% share)**; Spring Days |
| May | €19.9k | French Days / Mother's Day (MAMAN25); complexion and radiance 17%; 184 new customers |
| Jun | €15.1k | **Hydration peak (20.4%)**; Father's Day (PAPA25; Homme) |
| Jul | €23.4k | Summer sales; sets 34% of revenue (2025); eyes 17.6%; repeat demand high |
| Aug | €7.9k | Weakest month in 2026 (−42% YoY); sets 32% (2025) |
| Sep | €15.1k | Back to school: hydration 20.9% and anti-ageing 36.7% |
| Oct | €9.8k | Anti-ageing 37%; Octobre Rose (BB/CC); "Nuit de l'Éclat" on 30 Oct |
| Nov | €42.3k | **Black Friday: biggest revenue and acquisition month** (308 new customers) |
| Dec | €28.6k | **Gifting**: sets 27.8% of revenue, devices 18.2%, hydration at its low (9.9%) |

Devices and SPA are a winter and gifting category (11–19% of revenue Nov–Mar against 1–4% Apr–Sep). Body care is flat at 2–6% all year, so **there is no evidence for a dedicated body-care month**. Orders are spread evenly across weekdays (Sunday slightly higher, 38% in the evening).

---

## Deliverable 3 — Customer × product opportunity map

| Customer segment | Observed problem | Relevant product/range | Proposed intervention | Priority |
|---|---|---|---|---|
| New buyers, days 0–60 (186 now; ~170/month) | 4.9% buy again within 30 d, 11.4% within 90 d | Their entry range: Temps Sublime → Regard Sublime / sérum; Source d'Eau → Élixir; Homme → nettoyant | Post-purchase series by entry range: usage (d3), routine step (d14–21), replenishment (p25 of the product) | **High** |
| One order, 61–180 d (503, 312 subscribed) | Entering the natural window without a prompt | Replenishment list (Duo TS, CC, Bonne Mine Homme, Source d'Eau, Vit C, Niacinamide) | Replenishment reminder at the measured window; free-shipping nudge | **High** |
| Holiday cohort (Nov–Jan buyers; ~1,000 per season) | 12.9–17.9% repurchase at 180 d, the weakest cohorts | Gift and device buyers: wraps and masks for devices, full-size for sets | "Your routine continues" January–March sequence; self-purchase offer for gift buyers | **High** (seasonal) |
| Masks/patches/CC entrants (~1/4 of new) | 14–15% repurchase, €44–47 at 180 d | Upgrade path: wraps → Temps Sublime/Source d'Eau treatment | Sample or trade-up offer on the 2nd order; PDP "next step" | Medium |
| Device buyers (LED, sauna; 234) | 7–9% repurchase; no consumable attached | Wraps, Hyal-Aqua kit, Regard d'Or | Device onboarding flow + consumable replenishment | Medium |
| Repeat at risk 151–270 d (172, 139 subscribed) | Past their normal 2→3 gap | Favourite range (Temps Sublime 60%+) | Win-back with favourite range and an exclusive gift, not a % discount | **High** (cheap) |
| Repeat lapsed > 270 d (259, 187 subscribed) | €165 average history | Same | Two-touch win-back; then suppress from blasts | Medium |
| Champions (151, 93% subscribed) | 18% of revenue from 4% of customers; get the same blasts | Exception, new launches | VIP early access, previews, no extra discount; ask for reviews | Medium |
| Homme buyers (460) | Closed loop (74% buy Homme again); 21.5% replenishment | Bonne Mine Homme, nettoyant, Crème anti-âge Homme | Homme-specific replenishment and trio routine; Father's Day | Medium |
| Single-product baskets (51% of orders) | AOV €46.9 against €63.7 for two products | Kéfir lotion, eye serum, wraps (high-lift add-ons) | Cart "complete your routine" plus a €65/70 threshold reminder | Medium |
| Paid-social prospects | CAC ~€59–98 against €45 value at 180 d | Temps Sublime Duo / Regard Sublime as hook | Pause cold prospecting; retest with hero product + holdout | Medium |
| Belgium and Netherlands (233 buyers) | Higher AOV and repeat, no tailored CRM | Same as FR | Localised flows (the advisor already speaks NL) | Low |

---

## Deliverable 4 — Prioritised opportunity register

**Scoring:** Impact (1–5) × Confidence (1–5) × Ease (1–5). Values are annual net ex-VAT revenue. Scenario assumptions are stated, and overlaps are removed in the total.

| # | Opportunity | Finding and evidence | Target / audience | Estimated value (cons. / base / opt.) | Action and channels | Conf. | Effort | ICE | Priority |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Second-purchase programme** | 18.8% at 180 d; 75% never return; repeaters are worth +€130 after their first order | ~2,000 new customers a year | +3 / +5 / +8 pts × 2,000 × €130 = **€7.8k / €13k / €21k** | Klaviyo post-purchase by entry range; on-site routine step; 15% holdout | 4 | 3 | 5×4×3 = **60** | High |
| 2 | **Holiday-cohort rescue** (subset of #1, timed) | Nov–Jan cohorts 12.9–17.9% at 180 d | ~1,000 BF/Christmas/Soldes customers | included in #1 (≈40% of its volume) | Jan–Mar sequence; gift-buyer self-purchase offer | 4 | 4 | 4×4×4 = **64** | High |
| 3 | **Replenishment reminders** (11 SKUs) | 15–23% reorder naturally at measured windows | ≈380 due now, ≈1,000 due-events a year | +3 / +5 / +8 pts × 1,000 × €65 = **€2.0k / €3.3k / €5.2k** (≈50% overlap with #1) | Klaviyo flow at p25; PDP "reorder" | 3 | 4 | 3×3×4 = 36 | High |
| 4 | **Routine completion** | 7.2% of Temps Sublime buyers have the eye cream; within-range lift 7–19 | ~1,070 reachable gap customers (with overlaps) | 3 / 5 / 8% × 1,070 × €45 = **€1.4k / €2.4k / €3.9k** a year, recurring as the base grows | Flow + PDP/cart bundles; advisor routines | 3 | 4 | 36 | Medium-high |
| 5 | **Acquisition with retention-quality entry products** | Temps Sublime entrants 30% vs masks/devices 7–14% | BF 2026 and always-on acquisition | Shift 10/20/30% of ~500 low-retention entrants a year (masks, CC/BB, devices); Δ value 180 d ≈ €40 (with a selection haircut) → **€2.0k / €4.0k / €6.0k** | Merchandising: hero entry SKUs, a trial-size Duo, Shopping feed priority | 3 | 3 | 4×3×3 = 36 | High (time-critical for BF) |
| 6 | **Campaign rationalisation** | ~31 campaigns a month; €0.05 per delivered; 2–3× attribution inflation | 6.6k subscribed | Not quantifiable (no unsubscribe or list data). Protects deliverability and the list | Segmented calendar, 2–3 per week max, engagement suppression | 3 | 5 | 3×3×5 = 45 | High |
| 7 | **Stop or redesign paid social** | €9.7k → 99 tracked new, CAC €59–98 > €45 value | Media budget | Avoided loss ≈ €2–3k a month if it resumes as before | Pause cold; test hero-product retargeting with holdout | 4 | 5 | 3×4×5 = **60** | High |
| 8 | **Promotion discipline** | 37% below list; welcome code shows no retention edge; existing-customer codes reach 12–13% new | All | Recover 5/10/15% of the €26k a year of discount applications = **€1.3k / €2.6k / €3.9k** (margin, not revenue) | Holdout tests; gifts with purchase instead of %; one list-price anchor policy | 2 | 3 | 4×2×3 = 24 | Medium |
| 9 | **Basket building** | 51% single-product; €16.7 uplift for a second product; €70 threshold bunching | ~1,930 single-product orders a year | 5 / 10 / 15% converted × €16.7 = **€1.6k / €3.2k / €4.8k** | Cart add-ons (Kéfir, eye serum, wraps), threshold bar, bundles | 3 | 4 | 3×3×4 = 36 | Medium |
| 10 | **Repeat-customer win-back** | 431 at-risk/lapsed repeaters (326 subscribed), average €168 history | Segments 07–08 | 3 / 5 / 8% × 431 × €100 = **€1.3k / €2.2k / €3.4k** | 2-touch win-back with favourite range | 3 | 5 | 2×3×5 = 30 | Medium |
| 11 | **Device owners → consumables** | 7–9% repurchase; 42% of their next orders are masks | ~230 device buyers a year | +6 / +10 / +15 pts × 230 × €60 = **€0.8k / €1.4k / €2.1k** | Device onboarding flow | 3 | 5 | 2×3×5 = 30 | Medium |
| 12 | **VIP / Champions programme** | 151 customers = 18% of revenue | Champions + repeat active | Protects ≈€57k; upside not estimable without Smile.io data | Early access, recognition; connect Smile.io | 2 | 3 | 3×2×3 = 18 | Medium (after data) |
| 13 | **Measurement foundation** | No holdouts, COGS, Smile, unsubscribes; 40% unknown source | — | Enabler | See Deliverable 8 | 5 | 3 | — | High (prerequisite) |
| 14 | **Benelux and Italy CRM** | Higher AOV (€72–89) and repeat | ~350 buyers | < €2k | Localised flows | 2 | 3 | 12 | Low |

**De-duplicated total** (#1, #3 at 50%, #4, #5, #8–#11; −25% overlap haircut): roughly **€13k conservative / €23k base / €36k optimistic** a year, or **+5% / +10% / +15%** on the T12 €237k. These are *analytical estimates*. #1, #3 and #5 need holdout confirmation, and the margin effect is unknown without COGS.

---

## Deliverable 5 — Proposed 360° marketing architecture

**Strategic pillars** (four, no more):

| Pillar | Objective | Segments | Main channels | KPIs |
|---|---|---|---|---|
| **A. First 180 days** (new → 2nd → 3rd) | Lift the 180-day 2nd-order rate from 18.8% to 24% and keep 2→3 at ≥ 45% | 01, 02, holiday cohort | Klaviyo flows, PDP/cart, advisor routines, packaging inserts | 90/180-d repurchase vs holdout; value at 180 d per new customer |
| **B. Routines & replenishment** | More products per customer within a range; reorder on time | Buyers of the 11 replenishable SKUs; routine-gap lists | Flows, PDP bundles, Smile rewards for routine completion | Products per customer; same-range reorder rate; single-product order share |
| **C. Quality acquisition** | More new customers who start on retention products | Prospects | SEO/Shopping feed, organic social, partner content, BF; paid only with test design | New customers by entry range; value at 180 d by source; CAC where spend exists |
| **D. Loyal base: VIP & win-back** | Keep Champions, recover lapsing repeaters | 05–08 | Klaviyo segments, Smile.io, early access | Repeat-customer retention; win-back rate vs holdout |

Brand education and discovery is a **content layer** serving pillars A and C (routine guides, ingredient explainers), not a separate pillar.

**Monthly operating structure**
- **One primary commercial objective** per month, tied to a pillar KPI (for example "180-day 2nd-order rate of the BF cohort" or "Temps Sublime eye-cream attach rate").
- **One or two secondary objectives.**
- **2–3 hero products from one range**, the same across email, homepage, PDP badges, social and any ads.
- **Campaign budget:** 8–12 campaigns a month, each to a defined segment, against roughly 31 blasts today. The always-on flows carry retention.
- **Promotion rule:** at most two price-led events a quarter (Black Friday, Soldes, French/Spring Days, Summer). Outside them, use gifts with purchase at the €65–70 threshold, early access or routine gifts.

**Channel responsibilities**

| Channel | Role |
|---|---|
| Klaviyo flows | Pillars A, B and D (always on): welcome, post-purchase by range, replenishment, routine completion, device onboarding, win-back, VIP |
| Klaviyo campaigns | Monthly theme and events; segmented by range affinity and lifecycle stage; engagement-based suppression |
| Shopify storefront | Hero range on the homepage; "complete your routine" on PDP and cart; threshold bar; a trial or duo entry product; advisor routines |
| Smile.io | Reward the 2nd order and routine completion (points boost); VIP tiers for Champions, *after the data is connected* |
| Organic social | Theme education, routine demos, UGC and reviews (Judge.me is already used by 265 customers) |
| Acquisition | SEO and Shopping feed on hero entry SKUs; BF as the acquisition peak; paid only as a controlled test |

**Always-on CRM structure (priority order)**
1. Post-purchase by entry range (d0, d3 usage, d14–21 routine step, d45 review/UGC, p25 replenishment).
2. Replenishment for the 11 SKUs at the measured p25.
3. Routine completion (top 6 gaps).
4. Win-back at 151 d for repeaters and 181 d for one-timers.
5. Welcome (live since 22 Oct): add range-quiz branching using the storefront advisor answers.
6. Device onboarding.
7. VIP/Champions.
Abandoned cart, checkout and browse flows stay as they are.

**Measurement**
- A **global 10% control group** excluded from all flows, so flow incrementality can be read directly.
- Monthly scorecard: new customers by entry range; 90/180-day 2nd-order rate by cohort; repeat revenue share; products per customer; effective price vs list; campaign value per 1,000; unsubscribes.
- Report everything ex-VAT, with legacy customers separated.

---

## Deliverable 6 — Preliminary 12-month commercial calendar

*Confidence: H = recurring signal plus behavioural logic; M = one year of evidence; L = hypothesis.*

| Month | Primary objective (theme) | Secondary | Segments | Priority products | Klaviyo | Shopify / site | Social | Acquisition | Loyalty | KPIs | Evidence | Conf. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Jan** | Convert the holiday cohort to a 2nd order ("your routine continues") | Soldes revenue without deeper % | Nov–Dec new buyers; device and gift buyers | Wraps/Hyal-Aqua for devices; Temps Sublime/Source d'Eau full sizes | Cohort sequence + 3–4 Soldes sends | Routine bundles; post-Soldes list price | Device routines, before/after | Soldes acquisition (354 new in Jan 2026) | 2nd-order points boost | Holiday cohort 90-d rate; Soldes net | Holiday cohorts 12.9–17.9% r180; Jan €34k | H |
| **Feb** | Eye-care routine completion (Regard) | Win-back of at-risk repeaters (trough month) | Temps Sublime buyers without the eye cream (428); segment 07 | Caresse Regard Sublime, Élixir Regard Éclat, Regard d'Or | Routine-gap campaign; Valentine's gift | "Complete with eyes" on TS PDPs | Eye routine education | Low (trough) | — | Eye-cream attach rate | Eyes 17.7% share in Feb; gap 7.2% | M |
| **Mar** | Reset routine, low promotion: replenishment month | Device owners → consumables | Due-now lists; device buyers | Replenishment SKUs; wraps | Replenishment + device flows (no blast discount) | Reorder shortcuts | Spring skin reset | Prepare Spring Days creative | — | Repeat orders per 100 due | Repeat demand 5–9 per 100 in Feb–May | L |
| **Apr** | Anti-ageing acquisition with Temps Sublime | AOV via the €65 gift | Prospects; one-time buyers | TS Duo, Vit C serum, Élixir TS | Spring Days (event 1 of Q2) | Hero TS homepage; trial entry | Anti-ageing proof content | SEO/Shopping TS; paid test with holdout | — | New customers on TS; value at 180 d | Anti-ageing 40.5% share in Apr; TS r180 30.4% | M |
| **May** | Mother's Day gifting + radiance (Éclat/CC/BB) | New-customer volume | Gift buyers; complexion buyers | Coffrets, Éclat Parfait, CC/BB, UV | French Days / Mother's Day | Gift guide | Gifting | French Days | — | New customers; set share | 184 new (2026); radiance 17% | M |
| **Jun** | Hydration routine (Source d'Eau crème → élixir) | Father's Day: Homme trio | SdE buyers (104 gap); Homme buyers | Source d'Eau, Homme trio | Routine + Father's Day | SdE bundle | Summer hydration | — | — | SdE attach rate; Homme reorder | Hydration 20.4% (Jun); Homme loop 74% | M |
| **Jul** | Summer sales with routine sets (AOV) | Repeat customers' promo-timed purchases | Repeat active and at risk | Summer coffrets, eye care | Soldes d'été (event 1 of Q3) | Sets; threshold bar | Summer routine | Soldes | VIP early access | AOV; repeat orders | Sets 34% of revenue (Jul 2025); repeat demand 21 | M |
| **Aug** | Protect margin: always-on only | Prepare the back-to-school list | — | — | Flows only; 2–4 light sends | — | UGC | — | — | Margin; unsubscribes | Aug 2026 −42% YoY; discounting doesn't fix it | M |
| **Sep** | Back to school "post-summer repair" (hydration + anti-ageing) | Reactivate the spring/summer one-timers | Segment 02/03 from Mar–Jun | Source d'Eau, Temps Sublime | Repair routine; win-back | Routine finder (advisor) | Education | SEO | — | One-timer reactivation | Hydration 20.9%, anti-ageing 36.7% in Sep | M |
| **Oct** | Pre-BF list building + premium routine (Exception) | Octobre Rose (BB/CC) | Subscribers; Champions | Exception trio; BB/CC | VIP preview; sign-up | Pop-up for BF early access | Exception launch content | Grow list (sign-ups) | VIP tier preview | New subscribers; Exception attach | Exception value €157 at 180 d; lift 15–19 | L |
| **Nov** | **Black Friday acquisition with retention-quality entry products** | Device gifting | Prospects + all | TS Duo, Exception, Regard Sublime; LED as gift | BF sequence (the best value per 1,000 of the year) | Hero entry bundles; threshold | BF | **Peak acquisition** (308 new) | Points on 1st order | New customers by entry range; cohort r90 | Nov €42k; BF campaigns €230–380 per 1,000 | H |
| **Dec** | Gifting: coffrets and SPA | Capture gift buyers for January | Gift buyers | Coffrets, LED, Sauna | Gift guide; last-shipping date | Gift finder | Gifting | Gifting search | — | Set revenue; gift-buyer opt-in | Sets 27.8% of revenue; devices 18.2% | H |

Months **not** given a dedicated theme for lack of evidence: body care (flat 2–6% all year) and a stand-alone "SPA experience" outside the Nov–Mar device season.

---

## Deliverable 7 — First 90-day roadmap (Nov 2026 – Jan 2027)

**Immediate (weeks 0–4, before and around Black Friday)**
1. **BF 2026 merchandising:** feature TS Duo, Regard Sublime, Exception and Éclat Parfait as entry products. Keep LED for gifting. Use gifts at the €65/70 threshold rather than stacking codes on top of markdowns. *KPI:* share of new customers entering on high-retention ranges (baseline: TS + Exception + Éclat Parfait = 22% of new customers since Mar 2025).
2. **Post-purchase flow v1** (3 branches: Temps Sublime / Source d'Eau / other) live before the BF cohort lands, with a **15% random holdout**. *KPI:* 90-day 2nd-order rate (baseline 11.4%; Nov 2025 cohort 14.3%).
3. **Campaign cadence cap** (≤ 3 per week per profile; suppress profiles not engaged for 90 d from blasts). *KPI:* value per 1,000, unsubscribe rate (once synced).
4. **Pause cold paid social** until a test design exists.

**Experiments (weeks 2–12)**

| Test | Design | Success metric |
|---|---|---|
| Replenishment reminder (11 SKUs) | Random 50/50 among customers reaching p25 | Same-product reorder within 60 d of trigger; ≥ +3 pts |
| Routine completion (TS → Regard Sublime) | 80/20 holdout within the 428 | Eye-cream attach within 60 d |
| Welcome incentive | Code 15% vs gift-with-purchase vs 10% (randomised in the welcome flow) | First-order conversion **and** 180-d value |
| Cart add-on (Kéfir / eye serum / wraps) | A/B on the cart drawer | Share of 2+ product orders; AOV |
| Win-back repeaters (segment 07) | 80/20 holdout | Orders within 45 d |
| Paid social retest (Jan) | Hero-product creative, geo or audience holdout | Incremental new customers; value at 90 d vs CAC |

**Structural projects**
- Sync Klaviyo list size, unsubscribes and bounces (an extension of `sync:klaviyo`), and Smile.io points, redemptions and tiers.
- Load COGS per SKU (even approximate) so the register can move from revenue to contribution.
- Range and need as product metafields instead of title rules.
- Tracking: consent-mode and journey coverage (40% of orders have no source).
- Check the Shopify tax configuration and VAT reporting before July 2026 (finance).

**Lower priority:** Benelux/Italy localised flows; AI-assistant discovery (18 new customers so far); body-care themes.

---

## Deliverable 8 — Data limitations and instrumentation

**Well supported (high confidence):** the 1→2 drop-off and the ladder; cohort deterioration; order-count concentration; entry-range differences (as correlations); replenishment intervals for the 11 SKUs; the markdown depth; the Klaviyo flow gap; paid-social economics on tracked data; revenue reconciliation (−0.4% vs ShopifyQL).

**Uncertain:** seasonality (one year, overlapping with launch ramp-up and changing promotions); promotional incrementality (no holdouts, almost no full-price baseline); causal effect of entry products (selection: high-intent buyers choose serums); channel attribution (40% unknown; Klaviyo self-attribution inflated); email pressure per person (Klaviyo list size unknown).

**Absent:** Smile.io (points, tiers, redemptions, liability); COGS and margin; Klaviyo profiles, unsubscribes, bounces, list size and per-flow-message metrics; pre-Shopify order history (the 51.8k legacy profiles); ad spend outside Nov 2025–Feb 2026; product taxonomy as structured data.

**Most valuable additions, in order:**
1. **Holdout groups** in Klaviyo flows and campaigns: no new system needed, and they turn every later decision into a measured one.
2. **COGS per SKU**: needed for any discount or GWP decision, given the 37% price reduction.
3. **Klaviyo unsubscribe/bounce/list sync**: to manage contact pressure.
4. **Smile.io export/API**: before any loyalty redesign.
5. **Journey coverage** (consent banner and UTM discipline on all owned links).

There is no evidence that any existing system needs rebuilding. The gaps are a few missing data feeds and the absence of controlled tests.

---

### Reproducibility

| File | Content |
|---|---|
| `run.mjs` | Read-only runner (`begin read only`, rollback, refuses statements without the Qiriness shop id or with writing keywords) |
| `sql/_base.sqlinc` | Population, money definitions, taxonomy (shared by every statement) |
| `sql/01…14_*.sql` | One file per analysis; each `-- name:` writes `data/<name>.csv` |
| `acquisition.mjs` | Shopify `customerJourneySummary` (read-only, Qiriness domain asserted) → `data/acq_*.csv` (aggregates only) |
| `shopifyql.mjs` | ShopifyQL sales and sessions → `data/sql_*.csv`; reconciliation in `data/recon_shopifyql_vs_db.csv` |

All outputs are aggregates; no names, emails or addresses are written.
