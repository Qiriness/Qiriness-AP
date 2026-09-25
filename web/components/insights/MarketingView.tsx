import { Suspense } from "react";
import type { Compared, FunnelStep, Grain, LandingType, LivePart, MarketingPanel, ProductPage, PromotionRow, StorefrontChannel, StorefrontTotals } from "@/lib/types";
import { Await, BlockedCard, Caption, Card, DeltaChip, Grid, KpiCard, LoadingNote, euros, percent } from "./InsightsKit";
import { MarketingChannels } from "./MarketingChannels";
import { NewsletterRows } from "./NewsletterRows";
import t from "./tables.module.css";
import o from "./OverviewView.module.css";
import styles from "./MarketingView.module.css";

/**
 * The one step of the reference report's funnel this store cannot answer.
 * `product_views` and every spelling of it is refused; the other four steps are
 * real columns on the sessions dataset. What IS measured is how many sessions
 * ARRIVED on a product page — a different question, so it has its own card
 * rather than a row here pretending to be a funnel stage.
 */
const NO_PRODUCT_VIEWS = "Product viewers";

/**
 * Marketing & funnel. Laid out as the report is, with every card present:
 * what the orders record — promotions, discounting, purchases, the newsletter —
 * is measured, and so is Klaviyo (nightly); traffic above the purchase and the
 * ad and social platforms have no source yet and stay empty with the reason.
 */
export function MarketingView({
  panel,
  compareLabel,
  grain,
}: {
  panel: MarketingPanel;
  compareLabel: string;
  /** The range's grain, for the newsletter charts' "per day" / "per month" wording. */
  grain: Grain;
}) {
  const f = panel.figures.current;
  const fb = panel.figures.previous;
  const gross = panel.summary.current.grossRevenue + f.discounts;
  const discountShare = gross > 0 ? (f.discounts / gross) * 100 : null;
  const previousGross = panel.summary.previous && fb ? panel.summary.previous.grossRevenue + fb.discounts : null;
  const previousShare = previousGross && fb ? (fb.discounts / previousGross) * 100 : null;
  const nl = panel.newsletter.marketing.current;
  const nlBefore = panel.newsletter.marketing.previous;
  const net = nl.subscribed - nl.unsubscribed;

  return (
    <>
      <Grid min={14} pin="headline" label="Discounting and newsletter figures">
        <KpiCard
          label="Discounts & gifts"
          value={euros(f.discounts)}
          delta={<DeltaChip current={f.discounts} previous={fb?.discounts} polarity="down" compareLabel={compareLabel} />}
          sub={[{ label: "Share of gross sales", value: discountShare === null ? "—" : `${discountShare.toFixed(1)}%` }]}
        />
        <KpiCard
          label="Orders with a promotion"
          value={f.discountedOrders.toLocaleString("en-GB")}
          unit={`of ${f.paidOrders.toLocaleString("en-GB")}`}
          delta={<DeltaChip current={discountShare} previous={previousShare} polarity="down" points compareLabel={compareLabel} />}
          sub={[{ label: "Share of orders", value: percent(f.discountedOrders, f.paidOrders) }]}
        />
        <KpiCard
          label="Full-price revenue"
          value={euros(f.fullPriceRevenue)}
          delta={<DeltaChip current={f.fullPriceRevenue} previous={fb?.fullPriceRevenue} polarity="up" compareLabel={compareLabel} />}
          sub={[
            {
              label: "Discounted-order AOV",
              value: euros(f.discountedOrders > 0 ? f.discountedRevenue / f.discountedOrders : null, { cents: true }),
            },
            {
              label: "Full-price AOV",
              value: euros(
                f.paidOrders - f.discountedOrders > 0 ? f.fullPriceRevenue / (f.paidOrders - f.discountedOrders) : null,
                { cents: true }
              ),
            },
          ]}
        />
        {panel.newsletter.marketing.covered ? (
          <KpiCard
            label="Newsletter, net"
            value={signedCount(net)}
            sub={[
              // A net can be negative, and a percentage of a negative baseline
              // reads backwards; the previous net is shown as a count instead.
              { label: `Net, ${compareLabel}`, value: nlBefore ? signedCount(nlBefore.subscribed - nlBefore.unsubscribed) : "—" },
              { label: "Joined", value: `+${nl.subscribed.toLocaleString("en-GB")}` },
              { label: "Left", value: `−${nl.unsubscribed.toLocaleString("en-GB")}` },
            ]}
          />
        ) : (
          <BlockedCard label="Newsletter, net" reason="The range starts before the earliest recorded unsubscribe" />
        )}
      </Grid>

      <Grid min={26} pin="funnel-channels" label="Funnel and acquisition channels">
        <Suspense
          fallback={
            <Card title="E-commerce funnel">
              <LoadingNote />
            </Card>
          }
        >
          <Await promise={Promise.all([panel.live.funnel, panel.live.totals])}>
            {([funnel, totals]) => <FunnelCard funnel={funnel} totals={totals} paidOrders={f.paidOrders} />}
          </Await>
        </Suspense>
        <Card title="Acquisition channels" aside={<span>Shopify&apos;s own attribution</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={panel.live.channels}>{(channels) => <ChannelTable channels={channels} />}</Await>
          </Suspense>
        </Card>
      </Grid>

      <Grid min={26} pin="marketing-promotions" label="Marketing performance and promotions">
        <Card title="Marketing performance" aside={<span>Owned, paid and organic demand</span>}>
          <MarketingChannels klaviyo={panel.klaviyo} />
        </Card>
        <Card title="Promotions & discounting" span={2} aside={<span>What each promotion recorded on its orders</span>}>
          <PromotionTable rows={panel.promotions} />
        </Card>
      </Grid>

      <Grid min={26} pin="landing-pages" label="Where sessions land">
        <Card title="Where sessions land" aside={<span>The page a session arrived on</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={panel.live.landingTypes}>{(rows) => <LandingTypeTable rows={rows} />}</Await>
          </Suspense>
        </Card>
        <Card title="Product pages" span={2} aside={<span>Sessions that ARRIVED on the product — entries, not views</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={panel.live.productPages}>{(pages) => <ProductPageTable pages={pages} />}</Await>
          </Suspense>
        </Card>
      </Grid>

      <NewsletterRows newsletter={panel.newsletter} grain={grain} compareLabel={compareLabel} />
    </>
  );
}

/**
 * The four session steps with product-page entries beside them. Rendered once
 * the totals and the landing types have answered; blocked with the reason if
 * the totals could not be read.
 */
function FunnelCard({
  funnel,
  totals,
  paidOrders,
}: {
  funnel: LivePart<FunnelStep[]>;
  totals: LivePart<Compared<StorefrontTotals>>;
  paidOrders: number;
}) {
  const store = totals.value.current;
  return (
    <Card
      title="E-commerce funnel"
      aside={
        <span className={`${o.pill} ${store.conversionRate === null ? o.pillNeutral : o.pillGood}`}>
          CVR {store.conversionRate === null ? "—" : `${store.conversionRate.toFixed(2)}%`}
        </span>
      }
    >
      {funnel.blockedReason ? <p className={t.muted}>{funnel.blockedReason}</p> : null}
      <div className={styles.funnel}>
        {funnel.value.map((step, i) => (
          <div key={step.key} className={styles.funnelRow}>
            <label>
              {step.label}
              <small>
                {i === 0
                  ? "entry · human sessions"
                  : step.chained
                    ? `${step.ofPrevious === null ? "—" : `${step.ofPrevious.toFixed(1)}%`} from prior step`
                    : "entries, not views · outside the chain"}
              </small>
            </label>
            <div className={`${styles.funnelBar} ${step.chained ? "" : styles.funnelAside}`}>
              <i style={{ width: step.ofEntry === null ? "0%" : `${Math.max(2, step.ofEntry).toFixed(1)}%` }} />
            </div>
            <div className={styles.funnelValue}>
              <b>{step.value === null ? "—" : step.value.toLocaleString("en-GB")}</b>
              <small>{step.ofEntry === null ? "not measured" : `${step.ofEntry.toFixed(1)}% of entry`}</small>
            </div>
          </div>
        ))}
      </div>
      <p className={o.callout}>
        <b>Every step counts sessions, not orders.</b> The last step over the first is Shopify&apos;s conversion rate.
        Our own {paidOrders.toLocaleString("en-GB")} paid orders is a larger number because it counts every
        platform, including marketplace orders that never had a session. <b>{NO_PRODUCT_VIEWS} is not measurable</b>
        — Shopify keeps no product-view metric — so the product row counts sessions that <i>arrived</i> on a product
        page; it sits outside the chain, and the cart step below is measured against sessions, not against it.
      </p>
    </Card>
  );
}

/**
 * Where sessions came in, by the kind of page. Shopify types the landing page
 * (`Product`, `Homepage`, `Collection`…), so nothing here matches on URLs.
 *
 * The conversion column is the interesting one: an entry type can carry most of
 * the traffic and little of the buying.
 */
function LandingTypeTable({ rows }: { rows: LivePart<LandingType[]> }) {
  if (rows.blockedReason) return <p className={t.muted}>{rows.blockedReason}</p>;
  if (rows.value.length === 0) {
    return <p className={t.muted}>Shopify Analytics reported no traffic in this range.</p>;
  }
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">Landed on</th>
            <th scope="col" className={t.n}>Sessions</th>
            <th scope="col" className={t.n}>Added to cart</th>
            <th scope="col" className={t.n}>Converted</th>
          </tr>
        </thead>
        <tbody>
          {rows.value.map((row) => (
            <tr key={row.type}>
              <th scope="row">{row.type}</th>
              <td className={t.n}>{row.sessions === null ? "—" : row.sessions.toLocaleString("en-GB")}</td>
              <td className={t.n}>{row.cartRate === null ? "—" : `${row.cartRate.toFixed(1)}%`}</td>
              <td className={t.n}>{row.conversionRate === null ? "—" : `${row.conversionRate.toFixed(2)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The product pages sessions arrived on, busiest first, named from our own
 * catalogue by matching the handle in the path.
 *
 * ENTRIES, NOT VIEWS, and the caption says so twice over: Shopify keeps no
 * product-view metric, so a session that landed on the homepage and then
 * browsed to this product is not counted here. Every figure is a floor.
 */
function ProductPageTable({ pages }: { pages: LivePart<ProductPage[]> }) {
  if (pages.blockedReason) return <p className={t.muted}>{pages.blockedReason}</p>;
  if (pages.value.length === 0) {
    return <p className={t.muted}>No session arrived on a product page in this range.</p>;
  }
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">Product page</th>
              <th scope="col" className={t.n}>Sessions</th>
              <th scope="col" className={t.n}>Visitors</th>
              <th scope="col" className={t.n}>Added to cart</th>
            </tr>
          </thead>
          <tbody>
            {pages.value.map((page) => (
              <tr key={page.path}>
                <th scope="row" className={styles.promoName} title={page.path}>
                  {page.title ?? page.path}
                </th>
                <td className={t.n}>{page.sessions === null ? "—" : page.sessions.toLocaleString("en-GB")}</td>
                <td className={t.n}>{page.visitors === null ? "—" : page.visitors.toLocaleString("en-GB")}</td>
                <td className={t.n}>
                  {page.cartSessions === null ? "—" : page.cartSessions.toLocaleString("en-GB")}
                  {page.cartRate === null ? null : <span className={t.muted}> ({page.cartRate.toFixed(1)}%)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>
        Sessions whose FIRST page was this product. Shopify keeps no product-view metric, so a session that landed
        elsewhere and browsed here is not counted — every figure is a floor, and the rows do not sum to the funnel.
      </Caption>
    </>
  );
}

function signedCount(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-GB")}`;
}

/**
 * Traffic and money per source, both from Shopify: sessions from the sessions
 * dataset, revenue and orders from the sales dataset's own attribution.
 *
 * A CHANNEL PRESENT ON ONE SIDE ONLY KEEPS ITS FIGURE and shows a dash for the
 * other. Traffic that produced no attributed order, and revenue credited to a
 * channel the session data never saw, are both real findings — filling either
 * with a zero would bury them.
 */
function ChannelTable({ channels }: { channels: LivePart<StorefrontChannel[]> }) {
  if (channels.blockedReason) {
    return <p className={t.muted}>{channels.blockedReason}</p>;
  }
  if (channels.value.length === 0) {
    return <p className={t.muted}>Shopify Analytics reported no traffic in this range.</p>;
  }
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col" className={t.n}>Sessions</th>
              <th scope="col" className={t.n}>Revenue</th>
              <th scope="col" className={t.n}>Orders</th>
              <th scope="col" className={t.n}>CVR</th>
              <th scope="col" className={t.n}>Rev / session</th>
            </tr>
          </thead>
          <tbody>
            {channels.value.map((channel) => (
              <tr key={channel.channel}>
                <th scope="row">{channel.channel}</th>
                <td className={t.n}>{channel.sessions === null ? <span className={t.muted}>—</span> : channel.sessions.toLocaleString("en-GB")}</td>
                <td className={t.n}>{channel.revenue === null ? <span className={t.muted}>—</span> : euros(channel.revenue)}</td>
                <td className={t.n}>{channel.orders === null ? <span className={t.muted}>—</span> : channel.orders.toLocaleString("en-GB")}</td>
                <td className={t.n}>{channel.conversionRate === null ? <span className={t.muted}>—</span> : `${channel.conversionRate.toFixed(2)}%`}</td>
                <td className={t.n}>
                  {channel.revenuePerSession === null ? <span className={t.muted}>—</span> : euros(channel.revenuePerSession, { cents: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>
        Revenue is Shopify&apos;s attribution, not this dashboard&apos;s: it counts the storefront and can differ from the
        revenue elsewhere on this page.
      </Caption>
    </>
  );
}

/**
 * One row per promotion, full price last. An order carrying two promotions
 * counts in both, so the rows do not sum; the caption says so. A shipping
 * promotion takes nothing off a line, so its discount cell says "shipping"
 * instead of a zero.
 */
function PromotionTable({ rows }: { rows: PromotionRow[] }) {
  if (rows.every((r) => r.orders === 0)) return <p className={t.muted}>No order in this range.</p>;
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">Promotion</th>
              <th scope="col" className={t.n}>Revenue</th>
              <th scope="col" className={t.n}>Orders</th>
              <th scope="col" className={t.n}>AOV</th>
              <th scope="col" className={t.n} title="What the promotion took off the order lines — gifts at their list value">
                Discount
              </th>
              <th scope="col" className={t.n} title="Orders that were the buyer's first — marketplaces excluded">
                New cust.
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name ?? "__full_price"}>
                <th scope="row" className={styles.promoName} title={row.name ?? "No promotion"}>
                  {row.name ?? "No promotion (full price)"}
                  {row.kind === "code" ? <span className={styles.kind}>code</span> : null}
                </th>
                <td className={t.n}>{euros(row.revenue)}</td>
                <td className={t.n}>{row.orders.toLocaleString("en-GB")}</td>
                <td className={t.n}>{euros(row.orders > 0 ? row.revenue / row.orders : null, { cents: true })}</td>
                <td className={t.n}>
                  {row.name === null ? (
                    <span className={t.muted}>—</span>
                  ) : row.target === "SHIPPING_LINE" ? (
                    <span className={t.muted}>shipping</span>
                  ) : (
                    euros(row.discount)
                  )}
                </td>
                <td className={t.n}>{row.newCustomerOrders === null ? "—" : row.newCustomerOrders.toLocaleString("en-GB")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>An order with two promotions counts in both rows. Gifts are valued at list price.</Caption>
    </>
  );
}
