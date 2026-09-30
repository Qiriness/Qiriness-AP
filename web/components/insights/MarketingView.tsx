import { Suspense } from "react";
import type { Compared, FunnelStep, Grain, LandingType, LivePart, MarketingPanel, ProductPage, PromotionRow, StorefrontChannel, StorefrontTotals } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import { Await, BlockedCard, Caption, Card, DeltaChip, Grid, KpiCard, LoadingNote } from "./InsightsKit";
import { MarketingChannels } from "./MarketingChannels";
import { NewsletterRows } from "./NewsletterRows";
import t from "./tables.module.css";
import o from "./OverviewView.module.css";
import styles from "./MarketingView.module.css";

// The one funnel step this store cannot answer is "Product viewers"
// (`insights.marketing.noProductViews`): `product_views` and every spelling of it
// is refused. What IS measured is how many sessions ARRIVED on a product page — a
// different question, so it has its own card rather than a row pretending to be a
// funnel stage.

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
  const tr = getT();
  const fmt = getFormat();
  const { euros, integer, percent, percentOf } = fmt;
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
      <Grid min={14} pin="headline" label={tr("insights.marketing.headline")}>
        <KpiCard
          label={tr("insights.marketing.discounts")}
          value={euros(f.discounts)}
          delta={<DeltaChip current={f.discounts} previous={fb?.discounts} polarity="down" compareLabel={compareLabel} />}
          sub={[{ label: tr("insights.marketing.shareGross"), value: discountShare === null ? "—" : percentOf(discountShare, 1) }]}
        />
        <KpiCard
          label={tr("insights.marketing.withPromo")}
          value={integer(f.discountedOrders)}
          unit={tr("insights.fulfilment.of", { total: integer(f.paidOrders) })}
          delta={<DeltaChip current={discountShare} previous={previousShare} polarity="down" points compareLabel={compareLabel} />}
          sub={[{ label: tr("insights.marketing.shareOrders"), value: percent(f.discountedOrders, f.paidOrders) }]}
        />
        <KpiCard
          label={tr("insights.marketing.fullPrice")}
          value={euros(f.fullPriceRevenue)}
          delta={<DeltaChip current={f.fullPriceRevenue} previous={fb?.fullPriceRevenue} polarity="up" compareLabel={compareLabel} />}
          sub={[
            {
              label: tr("insights.marketing.discountedAov"),
              value: euros(f.discountedOrders > 0 ? f.discountedRevenue / f.discountedOrders : null, { cents: true }),
            },
            {
              label: tr("insights.marketing.fullAov"),
              value: euros(
                f.paidOrders - f.discountedOrders > 0 ? f.fullPriceRevenue / (f.paidOrders - f.discountedOrders) : null,
                { cents: true }
              ),
            },
          ]}
        />
        {panel.newsletter.marketing.covered ? (
          <KpiCard
            label={tr("insights.marketing.nlNet")}
            value={signedCount(net, fmt)}
            sub={[
              // A net can be negative, and a percentage of a negative baseline
              // reads backwards; the previous net is shown as a count instead.
              { label: tr("insights.marketing.netCompare", { label: compareLabel }), value: nlBefore ? signedCount(nlBefore.subscribed - nlBefore.unsubscribed, fmt) : "—" },
              { label: tr("insights.marketing.joined"), value: `+${integer(nl.subscribed)}` },
              { label: tr("insights.marketing.left"), value: `−${integer(nl.unsubscribed)}` },
            ]}
          />
        ) : (
          <BlockedCard label={tr("insights.marketing.nlNet")} reason="insights.marketing.startsBefore" />
        )}
      </Grid>

      <Grid min={26} pin="funnel-channels" label={tr("insights.marketing.funnelRow")}>
        <Suspense
          fallback={
            <Card title={tr("insights.marketing.funnel")}>
              <LoadingNote />
            </Card>
          }
        >
          <Await promise={Promise.all([panel.live.funnel, panel.live.totals])}>
            {([funnel, totals]) => <FunnelCard funnel={funnel} totals={totals} paidOrders={f.paidOrders} />}
          </Await>
        </Suspense>
        <Card title={tr("insights.marketing.channels")} aside={<span>{tr("insights.marketing.channelsAside")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={panel.live.channels}>{(channels) => <ChannelTable channels={channels} />}</Await>
          </Suspense>
        </Card>
      </Grid>

      <Grid min={26} pin="marketing-promotions" label={tr("insights.marketing.perfRow")}>
        <Card title={tr("insights.marketing.perf")} aside={<span>{tr("insights.marketing.perfAside")}</span>}>
          <MarketingChannels klaviyo={panel.klaviyo} />
        </Card>
        <Card title={tr("insights.marketing.promotions")} span={2} aside={<span>{tr("insights.marketing.promotionsAside")}</span>}>
          <PromotionTable rows={panel.promotions} />
        </Card>
      </Grid>

      <Grid min={26} pin="landing-pages" label={tr("insights.marketing.landRow")}>
        <Card title={tr("insights.marketing.landRow")} aside={<span>{tr("insights.marketing.landAside")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={panel.live.landingTypes}>{(rows) => <LandingTypeTable rows={rows} />}</Await>
          </Suspense>
        </Card>
        <Card title={tr("insights.marketing.productPages")} span={2} aside={<span>{tr("insights.marketing.productPagesAside")}</span>}>
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
  const tr = getT();
  const { integer, percentOf } = getFormat();
  const store = totals.value.current;
  return (
    <Card
      title={tr("insights.marketing.funnel")}
      aside={
        <span className={`${o.pill} ${store.conversionRate === null ? o.pillNeutral : o.pillGood}`}>
          {tr("insights.marketing.cvr")} {store.conversionRate === null ? "—" : percentOf(store.conversionRate, 2)}
        </span>
      }
    >
      {funnel.blockedReason ? <p className={t.muted}>{tr(funnel.blockedReason)}</p> : null}
      <div className={styles.funnel}>
        {funnel.value.map((step, i) => (
          <div key={step.key} className={styles.funnelRow}>
            <label>
              {step.label}
              <small>
                {i === 0
                  ? tr("insights.marketing.entry")
                  : step.chained
                    ? tr("insights.marketing.fromPrior", { pct: step.ofPrevious === null ? "—" : percentOf(step.ofPrevious, 1) })
                    : tr("insights.marketing.outsideChain")}
              </small>
            </label>
            <div className={`${styles.funnelBar} ${step.chained ? "" : styles.funnelAside}`}>
              <i style={{ width: step.ofEntry === null ? "0%" : `${Math.max(2, step.ofEntry).toFixed(1)}%` }} />
            </div>
            <div className={styles.funnelValue}>
              <b>{step.value === null ? "—" : integer(step.value)}</b>
              <small>{step.ofEntry === null ? tr("insights.overview.notMeasured").toLowerCase() : tr("insights.marketing.ofEntry", { pct: percentOf(step.ofEntry, 1) })}</small>
            </div>
          </div>
        ))}
      </div>
      <p className={o.callout}>
        <b>{tr("insights.marketing.calloutBold")}</b> {tr("insights.marketing.callout1", { n: integer(paidOrders) })}{" "}
        <b>{tr("insights.marketing.callout2", { name: tr("insights.marketing.noProductViews") })}</b> {tr("insights.marketing.callout3")}
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
  const tr = getT();
  const { integer, percentOf } = getFormat();
  if (rows.blockedReason) return <p className={t.muted}>{tr(rows.blockedReason)}</p>;
  if (rows.value.length === 0) {
    return <p className={t.muted}>{tr("insights.marketing.noTraffic")}</p>;
  }
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">{tr("insights.marketing.landedOn")}</th>
            <th scope="col" className={t.n}>{tr("insights.overview.sessions")}</th>
            <th scope="col" className={t.n}>{tr("insights.marketing.addedToCart")}</th>
            <th scope="col" className={t.n}>{tr("insights.marketing.converted")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.value.map((row) => (
            <tr key={row.type}>
              <th scope="row">{row.type}</th>
              <td className={t.n}>{row.sessions === null ? "—" : integer(row.sessions)}</td>
              <td className={t.n}>{row.cartRate === null ? "—" : percentOf(row.cartRate, 1)}</td>
              <td className={t.n}>{row.conversionRate === null ? "—" : percentOf(row.conversionRate, 2)}</td>
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
  const tr = getT();
  const { integer, percentOf } = getFormat();
  if (pages.blockedReason) return <p className={t.muted}>{tr(pages.blockedReason)}</p>;
  if (pages.value.length === 0) {
    return <p className={t.muted}>{tr("insights.marketing.noPageSession")}</p>;
  }
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.marketing.productPage")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.sessions")}</th>
              <th scope="col" className={t.n}>{tr("insights.marketing.visitors")}</th>
              <th scope="col" className={t.n}>{tr("insights.marketing.addedToCart")}</th>
            </tr>
          </thead>
          <tbody>
            {pages.value.map((page) => (
              <tr key={page.path}>
                <th scope="row" className={styles.promoName} title={page.path}>
                  {page.title ?? page.path}
                </th>
                <td className={t.n}>{page.sessions === null ? "—" : integer(page.sessions)}</td>
                <td className={t.n}>{page.visitors === null ? "—" : integer(page.visitors)}</td>
                <td className={t.n}>
                  {page.cartSessions === null ? "—" : integer(page.cartSessions)}
                  {page.cartRate === null ? null : <span className={t.muted}> ({percentOf(page.cartRate, 1)})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>{tr("insights.marketing.pagesNote")}</Caption>
    </>
  );
}

function signedCount(value: number, fmt: { integer: (value: number) => string }): string {
  return `${value >= 0 ? "+" : "−"}${fmt.integer(Math.abs(value))}`;
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
  const tr = getT();
  const { euros, integer, percentOf } = getFormat();
  if (channels.blockedReason) {
    return <p className={t.muted}>{tr(channels.blockedReason)}</p>;
  }
  if (channels.value.length === 0) {
    return <p className={t.muted}>{tr("insights.marketing.noTraffic")}</p>;
  }
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.marketing.channel")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.sessions")}</th>
              <th scope="col" className={t.n}>{tr("insights.sales.revenue")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.orders")}</th>
              <th scope="col" className={t.n}>{tr("insights.marketing.cvr")}</th>
              <th scope="col" className={t.n}>{tr("insights.marketing.revPerSession")}</th>
            </tr>
          </thead>
          <tbody>
            {channels.value.map((channel) => (
              <tr key={channel.channel}>
                <th scope="row">{channel.channel}</th>
                <td className={t.n}>{channel.sessions === null ? <span className={t.muted}>—</span> : integer(channel.sessions)}</td>
                <td className={t.n}>{channel.revenue === null ? <span className={t.muted}>—</span> : euros(channel.revenue)}</td>
                <td className={t.n}>{channel.orders === null ? <span className={t.muted}>—</span> : integer(channel.orders)}</td>
                <td className={t.n}>{channel.conversionRate === null ? <span className={t.muted}>—</span> : percentOf(channel.conversionRate, 2)}</td>
                <td className={t.n}>
                  {channel.revenuePerSession === null ? <span className={t.muted}>—</span> : euros(channel.revenuePerSession, { cents: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>{tr("insights.marketing.channelNote")}</Caption>
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
  const tr = getT();
  const { euros, integer } = getFormat();
  if (rows.every((r) => r.orders === 0)) return <p className={t.muted}>{tr("insights.marketing.noOrders")}</p>;
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.marketing.promotion")}</th>
              <th scope="col" className={t.n}>{tr("insights.sales.revenue")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.orders")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.aov")}</th>
              <th scope="col" className={t.n} title={tr("insights.marketing.discountHint")}>
                {tr("insights.marketing.discount")}
              </th>
              <th scope="col" className={t.n} title={tr("insights.marketing.newHint")}>
                {tr("insights.marketing.newCust")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name ?? "__full_price"}>
                <th scope="row" className={styles.promoName} title={row.name ?? tr("insights.marketing.noPromo")}>
                  {row.name ?? tr("insights.marketing.noPromoFull")}
                  {row.kind === "code" ? <span className={styles.kind}>{tr("insights.marketing.code")}</span> : null}
                </th>
                <td className={t.n}>{euros(row.revenue)}</td>
                <td className={t.n}>{integer(row.orders)}</td>
                <td className={t.n}>{euros(row.orders > 0 ? row.revenue / row.orders : null, { cents: true })}</td>
                <td className={t.n}>
                  {row.name === null ? (
                    <span className={t.muted}>—</span>
                  ) : row.target === "SHIPPING_LINE" ? (
                    <span className={t.muted}>{tr("insights.marketing.shipping")}</span>
                  ) : (
                    euros(row.discount)
                  )}
                </td>
                <td className={t.n}>{row.newCustomerOrders === null ? "—" : integer(row.newCustomerOrders)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>{tr("insights.marketing.promoNote")}</Caption>
    </>
  );
}
