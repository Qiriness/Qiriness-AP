import type { OverviewPanel } from "@/lib/types";
import { averageOrderValue, revenueDrivers } from "../../../scripts/lib/sales-overview.mjs";
import { InventoryTable, inventoryAside } from "./InventoryCard";
import { BlockedCard, Caption, Card, DeltaChip, Grid, KpiCard, euros } from "./InsightsKit";
import { OverviewTrend } from "./OverviewTrend";
import { ReportDownload } from "./ReportDownload";
import styles from "./OverviewView.module.css";

/**
 * The management view, laid out as the sales report is: the headline row, the
 * trend beside what moved revenue, then gross-to-net, signals and the mix.
 * Every figure from our own database is one another panel prints; sessions,
 * conversion and revenue per session come live from Shopify Analytics and
 * render blocked with their reason if it cannot be read, never as zeros.
 */
export function OverviewView({ panel, compareLabel }: { panel: OverviewPanel; compareLabel: string }) {
  const { current, previous } = panel.summary;
  const figures = panel.figures.current;
  const before = panel.figures.previous;
  // AOV IS SHOPIFY'S, and net-based: (gross − discounts) ÷ orders. Dividing our
  // revenue — which is Shopify's TOTAL sales, VAT and shipping included — by
  // orders read about 25% high against the admin's own screen.
  const ladder = panel.storefront.sales.current;
  const ladderBefore = panel.storefront.sales.previous;
  const aov = ladder?.averageOrderValue ?? null;
  const previousAov = ladderBefore?.averageOrderValue ?? null;
  const fallbackAov = averageOrderValue(current.revenue, figures.paidOrders);
  const refundRate = current.grossRevenue > 0 ? ((current.grossRevenue - current.revenue) / current.grossRevenue) * 100 : null;
  const previousRefundRate =
    previous && previous.grossRevenue > 0 ? ((previous.grossRevenue - previous.revenue) / previous.grossRevenue) * 100 : null;
  const drivers = revenueDrivers(
    { revenue: current.revenue, paidOrders: figures.paidOrders },
    previous && before ? { revenue: previous.revenue, paidOrders: before.paidOrders } : null
  );
  // Shopify's ladder as a real chain, read from the top line down to the value
  // of the goods:
  //   total − (VAT + shipping)   = net sales
  //   net   + discounts + returns = gross sales
  // Every step is arithmetic the reader can follow along the row, which the
  // previous ordering was not: total minus VAT does not give gross sales.
  const bridge = ladder
    ? [
        { label: "Total sales", value: ladder.totalSales, kind: "net" as const },
        { label: "VAT & shipping", value: ladder.taxes + ladder.shipping, kind: "cost" as const },
        { label: "Net sales", value: ladder.netSales, kind: "net" as const },
        { label: "Discounts", value: ladder.discounts, kind: "add" as const },
        { label: "Returns", value: ladder.returns, kind: "add" as const },
        { label: "Gross sales", value: ladder.grossSales, kind: "gross" as const },
      ]
    : null;

  // Sessions and conversion are Shopify's, and they count the STOREFRONT. So
  // revenue per session divides storefront revenue — not the headline revenue,
  // which includes marketplace orders whose buyers never saw the shop.
  const store = panel.storefront.totals.current;
  const storeBefore = panel.storefront.totals.previous;
  const revenuePerSession = store.sessions ? panel.storefrontRevenue.current / store.sessions : null;
  const relative = (now: number | null, then: number | null | undefined) =>
    now === null || then === null || then === undefined || then === 0 ? null : (now - then) / Math.abs(then);
  const sessionChange = relative(store.sessions, storeBefore?.sessions);
  const conversionChange = relative(store.conversionRate, storeBefore?.conversionRate);
  const previousRevenuePerSession =
    storeBefore?.sessions && panel.storefrontRevenue.previous !== null
      ? panel.storefrontRevenue.previous / storeBefore.sessions
      : null;

  return (
    <>
      <Grid columns={8} pin="headline" label="Headline figures">
        {ladder ? (
          // NET SALES LEADS: what the goods earned, before VAT and shipping. The
          // total is still on the page, as the first bar of the sales bridge.
          <KpiCard
            label="Net sales"
            value={euros(ladder.netSales)}
            delta={
              <DeltaChip
                current={ladder.netSales}
                previous={ladderBefore?.netSales ?? null}
                polarity="up"
                compareLabel={compareLabel}
              />
            }
          />
        ) : (
          // Net sales is Shopify's and cannot be derived from our columns, so
          // without it the card falls back to the total and names what it is.
          <KpiCard
            label="Total sales"
            value={euros(current.revenue)}
            delta={<DeltaChip current={current.revenue} previous={previous?.revenue} polarity="up" compareLabel={compareLabel} />}
            sub={[{ label: "Net sales", value: "Shopify unavailable" }]}
          />
        )}
        <KpiCard
          label="Orders"
          value={figures.paidOrders.toLocaleString("en-GB")}
          delta={<DeltaChip current={figures.paidOrders} previous={before?.paidOrders} polarity="up" compareLabel={compareLabel} />}
        />
        <KpiCard
          label="Units sold"
          value={figures.units.toLocaleString("en-GB")}
          delta={<DeltaChip current={figures.units} previous={before?.units} polarity="up" compareLabel={compareLabel} />}
        />
        <KpiCard
          label="AOV"
          value={euros(aov ?? fallbackAov, { cents: true })}
          delta={<DeltaChip current={aov} previous={previousAov} polarity="up" compareLabel={compareLabel} />}
          sub={[{ label: aov === null ? "Total sales ÷ orders" : "Net sales ÷ orders", value: aov === null ? "Shopify unavailable" : "Shopify's own" }]}
        />
        <KpiCard
          label="Refund rate"
          value={refundRate === null ? "—" : `${refundRate.toFixed(1)}%`}
          delta={<DeltaChip current={refundRate} previous={previousRefundRate} polarity="down" points compareLabel={compareLabel} />}
        />
        {store.sessions === null ? (
          <BlockedCard label="Sessions" reason={panel.storefront.blockedReason ?? "Not measured"} />
        ) : (
          <KpiCard
            label="Sessions"
            value={store.sessions.toLocaleString("en-GB")}
            delta={<DeltaChip current={store.sessions} previous={storeBefore?.sessions ?? null} polarity="up" compareLabel={compareLabel} />}
            sub={[{ label: "Pageviews", value: store.pageviews === null ? "—" : store.pageviews.toLocaleString("en-GB") }]}
          />
        )}
        {store.conversionRate === null ? (
          <BlockedCard label="Conversion" reason={panel.storefront.blockedReason ?? "Not measured"} />
        ) : (
          <KpiCard
            label="Conversion"
            value={`${store.conversionRate.toFixed(2)}%`}
            delta={
              <DeltaChip
                current={store.conversionRate}
                previous={storeBefore?.conversionRate ?? null}
                polarity="up"
                points
                compareLabel={compareLabel}
              />
            }
            sub={[{ label: "Bounce rate", value: store.bounceRate === null ? "—" : `${store.bounceRate.toFixed(1)}%` }]}
          />
        )}
        {revenuePerSession === null ? (
          <BlockedCard label="Revenue / session" reason={panel.storefront.blockedReason ?? "Needs sessions"} />
        ) : (
          <KpiCard
            label="Revenue / session"
            value={euros(revenuePerSession, { cents: true })}
            delta={<DeltaChip current={revenuePerSession} previous={previousRevenuePerSession} polarity="up" compareLabel={compareLabel} />}
            sub={[{ label: "Storefront revenue", value: euros(panel.storefrontRevenue.current) }]}
          />
        )}
      </Grid>

      <Grid min={26} pin="trend" label="Performance trend and revenue drivers">
        <Card title="Performance trend" span={2}>
          <OverviewTrend
            revenue={panel.revenue}
            orders={panel.orders}
            aov={panel.aov}
            sessions={panel.storefront.available ? panel.storefront.sessions : null}
            sessionsBlockedReason={panel.storefront.blockedReason}
          />
        </Card>
        <Card title="What moved revenue?" aside={<span>Revenue = orders × AOV</span>}>
          <div className={styles.driverTotal}>
            <span>Total revenue change</span>
            <strong className={tone(drivers.total)}>{signed(drivers.total)}</strong>
          </div>
          <ul className={styles.drivers}>
            <DriverRow label="Orders" hint="Volume" value={drivers.orders} />
            <DriverRow label="AOV" hint="Basket" value={drivers.aov} />
            <DriverRow label="Sessions" hint="Traffic · storefront" value={sessionChange} blocked={sessionChange === null} />
            <DriverRow label="Conversion" hint="Efficiency · storefront" value={conversionChange} blocked={conversionChange === null} />
          </ul>
          <p className={styles.callout}>
            {drivers.lead === null ? (
              <>No earlier period to compare with.</>
            ) : (
              <>
                <b>{drivers.lead === "orders" ? "Order volume" : "Average order value"} moved most</b> vs {compareLabel}. Orders
                × AOV covers the whole business; sessions and conversion are Shopify&apos;s storefront figures and do not
                multiply out to it, because marketplace orders have no session.
              </>
            )}
          </p>
        </Card>
      </Grid>

      <Grid min={20} pin="bridge-signals-mix" label="Revenue bridge, signals and sales mix">
        <Card title="Sales bridge" aside={<span>Shopify&apos;s own figures</span>}>
          {bridge && ladder ? (
            <>
              <Bridge steps={bridge} />
              <Caption>
                Reads left to right: total sales less VAT ({euros(ladder.taxes)}) and shipping ({euros(ladder.shipping)})
                is net sales; adding back discounts and returns gives gross sales, the value of the goods before any
                reduction.
              </Caption>
            </>
          ) : (
            <p className={styles.muted}>{panel.storefront.blockedReason ?? "Shopify Analytics could not be read."}</p>
          )}
        </Card>
        <Card title="Management signals" aside={<span>Rule-based, not AI</span>}>
          <ol className={styles.signals}>
            {panel.signals.map((signal, i) => (
              <li key={signal.title} className={`${styles.signal} ${styles[`signal_${signal.tone}`]}`}>
                <i aria-hidden="true">{String(i + 1).padStart(2, "0")}</i>
                <div>
                  <b>{signal.title}</b>
                  {signal.detail ? <span>{signal.detail}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Sales mix" aside={<span>Where revenue came from</span>}>
          <MixBars
            title="By platform"
            rows={panel.platforms.map((p) => ({ key: p.platform, label: p.label, value: p.revenue }))}
          />
          <MixBars
            title="Top products"
            total={panel.productRevenue}
            rows={panel.topProducts.map((p) => ({ key: p.productId, label: p.title, value: p.revenue }))}
          />
        </Card>
      </Grid>

      <Grid min={26} pin="stock-report" label="Stock and monthly report">
        <Card title="Inventory exceptions" span={2} aside={<span>{inventoryAside(panel.inventory)}</span>}>
          <InventoryTable inventory={panel.inventory} limit={6} />
        </Card>
        <Card title="Monthly sales report">
          <p className={styles.muted}>
            The month&apos;s figures as one HTML file, laid out for the CEOs — the report that will be emailed at the
            start of each month.
          </p>
          <ReportDownload months={panel.reportMonths} initial={panel.reportMonth} />
        </Card>
      </Grid>
    </>
  );
}

function signed(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;
}

function tone(value: number | null): string {
  if (value === null || Math.abs(value) < 0.0005) return styles.flat;
  return value > 0 ? styles.up : styles.down;
}

function DriverRow({ label, hint, value, blocked = false }: { label: string; hint: string; value: number | null; blocked?: boolean }) {
  const width = value === null ? 0 : Math.min(100, Math.max(3, Math.abs(value) * 400));
  return (
    <li className={styles.driver}>
      <span className={styles.driverLabel}>
        <b>{label}</b>
        <span>{hint}</span>
      </span>
      <span className={`${styles.track} ${blocked ? styles.trackBlocked : ""}`}>
        {blocked ? null : <i className={value !== null && value < 0 ? styles.fillNeg : styles.fill} style={{ width: `${width}%` }} />}
      </span>
      <span className={`${styles.driverValue} ${blocked ? styles.flat : tone(value)}`} title={blocked ? "Needs sessions data" : undefined}>
        {blocked ? "—" : signed(value)}
      </span>
    </li>
  );
}

type BridgeKind = "gross" | "cost" | "net" | "add";

/** The sign the step carries along the chain: taken off, added back, or a subtotal. */
function signedStep(kind: BridgeKind, value: number): string {
  if (value <= 0) return euros(value);
  if (kind === "cost") return `−${euros(value)}`;
  if (kind === "add") return `+${euros(value)}`;
  return euros(value);
}

function Bridge({ steps }: { steps: { label: string; value: number; kind: BridgeKind }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className={styles.bridge}>
      {steps.map((step) => (
        <div key={step.label} className={`${styles.bridgeItem} ${styles[`bridge_${step.kind}`]}`}>
          <div className={styles.bridgeBarWrap}>
            <div className={styles.bridgeBar} style={{ height: `${Math.max(4, (step.value / max) * 100)}%` }} />
          </div>
          <strong>{signedStep(step.kind, step.value)}</strong>
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function MixBars({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { key: string; label: string; value: number }[];
  total?: number;
}) {
  const sum = total ?? rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={styles.mix}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className={styles.muted}>No sales in this range.</p> : null}
      {rows.map((row) => (
        <div key={row.key} className={styles.mixRow} title={`${row.label} · ${euros(row.value)}`}>
          <span className={styles.mixLabel}>{row.label}</span>
          <span className={styles.track}>
            <i className={styles.fill} style={{ width: `${(row.value / max) * 100}%` }} />
          </span>
          <b>{sum > 0 ? `${((row.value / sum) * 100).toFixed(0)}%` : "—"}</b>
        </div>
      ))}
    </div>
  );
}
