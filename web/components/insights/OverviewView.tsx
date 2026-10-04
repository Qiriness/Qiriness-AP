import { Suspense, type ReactNode } from "react";
import type { Compared, LivePart, OverviewPanel, SalesSeries, SeriesPoint, StorefrontMoney, StorefrontTotals } from "@/lib/types";
import { averageOrderValue, revenueDrivers } from "../../../scripts/lib/sales-overview.mjs";
import { InventoryTable, inventoryAside } from "./InventoryCard";
import { getFormat, getT } from "@/lib/i18n/server";
import { Await, BlockedCard, Caption, Card, DeltaChip, Grid, KpiCard, LoadingCard, LoadingNote } from "./InsightsKit";
import { OverviewTrend } from "./OverviewTrend";
import { ReportDownload } from "./ReportDownload";
import styles from "./OverviewView.module.css";

// Loading text: `insights.kit.loadingShopify`. The fallback note: `insights.overview.fallbackNote`,
// said wherever a card had to use our synced orders because Shopify could not be read.

/**
 * The management view, laid out as the sales report is: the headline row, the
 * trend beside what moved net sales, then the bridge, signals and the mix.
 *
 * ONE BASIS FOR EVERY MONEY FIGURE. Net sales, orders, AOV, the refund rate,
 * the trend, the drivers, the signals, revenue per session and the platform
 * mix all read Shopify's ladder for the exact range — the bridge's figures and
 * the admin's — so no two cards can disagree about the same money (the owner's
 * call, 2026-09-24). Our synced orders fill a card only when Shopify cannot be
 * read, and the card says so. Units and the top products stay ours: Shopify
 * Analytics has no per-product line revenue here.
 *
 * Every Shopify card streams in on its own (Suspense), money first; a card that
 * cannot be read renders blocked with its reason, never as a zero.
 */
export function OverviewView({ panel, compareLabel }: { panel: OverviewPanel; compareLabel: string }) {
  const t = getT();
  const f = getFormat();
  const figures = panel.figures.current;
  const before = panel.figures.previous;
  const { live } = panel;

  return (
    <>
      <Grid columns={8} pin="headline" label={t("insights.overview.headline")}>
        <Suspense fallback={<LoadingCard label={t("insights.overview.netSales")} />}>
          <Await promise={live.sales}>
            {(sales) => <NetSalesCard sales={sales} panel={panel} compareLabel={compareLabel} />}
          </Await>
        </Suspense>
        <Suspense fallback={<LoadingCard label={t("insights.overview.orders")} />}>
          <Await promise={live.sales}>{(sales) => <OrdersCard sales={sales} panel={panel} compareLabel={compareLabel} />}</Await>
        </Suspense>
        <KpiCard
          label={t("insights.overview.units")}
          value={f.integer(figures.units)}
          delta={<DeltaChip current={figures.units} previous={before?.units} polarity="up" compareLabel={compareLabel} />}
        />
        <Suspense fallback={<LoadingCard label={t("insights.overview.aov")} />}>
          <Await promise={live.sales}>{(sales) => <AovCard sales={sales} panel={panel} compareLabel={compareLabel} />}</Await>
        </Suspense>
        <Suspense fallback={<LoadingCard label={t("insights.overview.refundRate")} />}>
          <Await promise={live.sales}>
            {(sales) => <RefundRateCard sales={sales} panel={panel} compareLabel={compareLabel} />}
          </Await>
        </Suspense>
        <Suspense
          fallback={
            <>
              <LoadingCard label={t("insights.overview.sessions")} />
              <LoadingCard label={t("insights.overview.conversion")} />
              <LoadingCard label={t("insights.overview.perSession")} />
            </>
          }
        >
          <Await promise={Promise.all([live.totals, live.sales])}>
            {([totals, sales]) => <SessionCards totals={totals} sales={sales} compareLabel={compareLabel} />}
          </Await>
        </Suspense>
      </Grid>

      <Grid min={26} pin="trend" label={t("insights.overview.trendRow")}>
        <Card title={t("insights.overview.trend")} span={2}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={Promise.all([live.series, live.sessions])}>
              {([series, sessions]) => <Trend panel={panel} series={series} sessions={sessions} />}
            </Await>
          </Suspense>
        </Card>
        <Card title={t("insights.overview.whatMoved")} aside={<span>{t("insights.overview.ordersTimesAov")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={live.sales}>
              {(sales) => (
                <MoneyDrivers
                  sales={sales}
                  panel={panel}
                  compareLabel={compareLabel}
                  sessionRows={
                    <Suspense
                      fallback={
                        <>
                          <DriverRow label={t("insights.overview.sessions")} hint={t("insights.overview.trafficHint")} value={null} blocked blockedTitle={t("insights.kit.loadingShopify")} />
                          <DriverRow label={t("insights.overview.conversion")} hint={t("insights.overview.efficiencyHint")} value={null} blocked blockedTitle={t("insights.kit.loadingShopify")} />
                        </>
                      }
                    >
                      <Await promise={live.totals}>{(totals) => <SessionDrivers totals={totals} />}</Await>
                    </Suspense>
                  }
                />
              )}
            </Await>
          </Suspense>
        </Card>
      </Grid>

      <Grid min={20} pin="bridge-signals-mix" label={t("insights.overview.bridgeRow")}>
        <Card title={t("insights.overview.bridge")} aside={<span>{t("insights.overview.shopifyOwn")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={live.sales}>{(sales) => <SalesBridge sales={sales} />}</Await>
          </Suspense>
        </Card>
        <Card title={t("insights.overview.signals")} aside={<span>{t("insights.overview.ruleBased")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={live.signals}>
              {({ signals, basis }) => (
                <>
                  <ol className={styles.signals}>
                    {signals.map((signal, i) => (
                      <li key={signal.title} className={`${styles.signal} ${styles[`signal_${signal.tone}`]}`}>
                        <i aria-hidden="true">{String(i + 1).padStart(2, "0")}</i>
                        <div>
                          <b>{signal.title}</b>
                          {signal.detail ? <span>{signal.detail}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {basis === "orders" ? <Caption>{t("insights.overview.fallbackNote")}.</Caption> : null}
                </>
              )}
            </Await>
          </Suspense>
        </Card>
        <Card title={t("insights.overview.mix")} aside={<span>{t("insights.overview.mixAside")}</span>}>
          <Suspense fallback={<LoadingNote />}>
            <Await promise={live.sales}>{(sales) => <PlatformMix sales={sales} panel={panel} />}</Await>
          </Suspense>
          <MixBars
            title={t("insights.overview.topProducts")}
            total={panel.productRevenue}
            rows={panel.topProducts.map((p) => ({ key: p.productId, label: p.title, value: p.revenue }))}
          />
        </Card>
      </Grid>

      <Grid min={26} pin="stock-report" label={t("insights.overview.stockRow")}>
        <Card title={t("insights.overview.inventory")} span={2} aside={<span>{inventoryAside(panel.inventory, t)}</span>}>
          <InventoryTable inventory={panel.inventory} />
        </Card>
        <Card title={t("insights.overview.report")}>
          <p className={styles.muted}>{t("insights.overview.reportNote")}</p>
          <ReportDownload months={panel.reportMonths} initial={panel.reportMonth} />
        </Card>
      </Grid>
    </>
  );
}

// --- the Shopify cards, rendered once their promise settles -------------------

type Sales = LivePart<StorefrontMoney>;
type Totals = LivePart<Compared<StorefrontTotals>>;

/**
 * NET SALES LEADS: what the goods earned, before VAT and shipping — Shopify's
 * own figure for this exact range, live. Net sales cannot be derived from our
 * columns, so without Shopify the card falls back to the total and names what
 * it is.
 */
function NetSalesCard({ sales, panel, compareLabel }: { sales: Sales; panel: OverviewPanel; compareLabel: string }) {
  const t = getT();
  const { euros } = getFormat();
  const ladder = sales.value.current;
  if (!ladder) {
    const { current, previous } = panel.summary;
    return (
      <KpiCard
        label={t("insights.overview.totalSales")}
        value={euros(current.revenue)}
        delta={<DeltaChip current={current.revenue} previous={previous?.revenue} polarity="up" compareLabel={compareLabel} />}
        sub={[{ label: t("insights.overview.netSales"), value: t("insights.overview.shopifyUnavailable") }]}
      />
    );
  }
  return (
    <KpiCard
      label={t("insights.overview.netSales")}
      value={euros(ladder.netSales)}
      delta={
        <DeltaChip current={ladder.netSales} previous={sales.value.previous?.netSales ?? null} polarity="up" compareLabel={compareLabel} />
      }
    />
  );
}

/**
 * SHOPIFY'S ORDER COUNT, the one its AOV divides by. It includes orders later
 * cancelled — 4,574 against our 4,571 paid orders for the year to September
 * 2026 — which is what the admin prints.
 */
function OrdersCard({ sales, panel, compareLabel }: { sales: Sales; panel: OverviewPanel; compareLabel: string }) {
  const t = getT();
  const fmt = getFormat();
  const ladder = sales.value.current;
  if (!ladder) {
    const f = panel.figures;
    return (
      <KpiCard
        label={t("insights.overview.orders")}
        value={fmt.integer(f.current.paidOrders)}
        delta={<DeltaChip current={f.current.paidOrders} previous={f.previous?.paidOrders} polarity="up" compareLabel={compareLabel} />}
        sub={[{ label: t("insights.overview.paidOrdersOurs"), value: t("insights.overview.shopifyUnavailable") }]}
      />
    );
  }
  return (
    <KpiCard
      label={t("insights.overview.orders")}
      value={fmt.integer(ladder.orders)}
      delta={<DeltaChip current={ladder.orders} previous={sales.value.previous?.orders ?? null} polarity="up" compareLabel={compareLabel} />}
    />
  );
}

/** AOV IS SHOPIFY'S OWN, weighted by orders across the channels folded. */
function AovCard({ sales, panel, compareLabel }: { sales: Sales; panel: OverviewPanel; compareLabel: string }) {
  const t = getT();
  const { euros } = getFormat();
  const aov = sales.value.current?.averageOrderValue ?? null;
  const previousAov = sales.value.previous?.averageOrderValue ?? null;
  const fallbackAov = averageOrderValue(panel.summary.current.revenue, panel.figures.current.paidOrders);
  return (
    <KpiCard
      label={t("insights.overview.aov")}
      value={euros(aov ?? fallbackAov, { cents: true })}
      delta={<DeltaChip current={aov} previous={previousAov} polarity="up" compareLabel={compareLabel} />}
      sub={[
        aov === null
          ? { label: t("insights.overview.aovFallback"), value: t("insights.overview.shopifyUnavailable") }
          : { label: t("insights.overview.aovBasis"), value: t("insights.overview.shopifysOwn") },
      ]}
    />
  );
}

/**
 * RETURNS OVER GROSS SALES, Shopify's: the bridge's Returns step as a share of
 * the bridge's Gross sales. It counts a refund in the period it was MADE and
 * only the goods' value before VAT — so it matches the bridge, not our old
 * refunds-by-order-date figure (the 30 days to 24 Sep 2026: €84.96 of returns
 * against €19.43 of refunds on orders placed in the window).
 */
function RefundRateCard({ sales, panel, compareLabel }: { sales: Sales; panel: OverviewPanel; compareLabel: string }) {
  const t = getT();
  const { euros, percentOf } = getFormat();
  const rate = (l: StorefrontMoney["current"]) => (l && l.grossSales > 0 ? (l.returns / l.grossSales) * 100 : null);
  const ladder = sales.value.current;
  if (!ladder) {
    const ours = (s: { grossRevenue: number; revenue: number } | null) =>
      s && s.grossRevenue > 0 ? ((s.grossRevenue - s.revenue) / s.grossRevenue) * 100 : null;
    const now = ours(panel.summary.current);
    return (
      <KpiCard
        label={t("insights.overview.refundRate")}
        value={now === null ? "—" : percentOf(now, 1)}
        delta={<DeltaChip current={now} previous={ours(panel.summary.previous)} polarity="down" points compareLabel={compareLabel} />}
        sub={[{ label: t("insights.overview.refundOurs"), value: t("insights.overview.shopifyUnavailable") }]}
      />
    );
  }
  const now = rate(ladder);
  return (
    <KpiCard
      label={t("insights.overview.refundRate")}
      value={now === null ? "—" : percentOf(now, 1)}
      delta={<DeltaChip current={now} previous={rate(sales.value.previous)} polarity="down" points compareLabel={compareLabel} />}
      sub={[{ label: t("insights.overview.returnsOverGross"), value: euros(ladder.returns) }]}
    />
  );
}

/**
 * Sessions, conversion and net sales per session. Sessions and conversion are
 * Shopify's and count the STOREFRONT, so the per-session figure divides the
 * STOREFRONT's net sales — Shopify's ladder folded onto the Shopify platform —
 * not the headline, which includes marketplace orders whose buyers never saw
 * the shop.
 *
 * A range assembled from stored months and live days has no bounce figure
 * (it does not add up across months), so its bounce sub reads "—".
 */
function SessionCards({ totals, sales, compareLabel }: { totals: Totals; sales: Sales; compareLabel: string }) {
  const t = getT();
  const { euros, integer, decimal, percentOf } = getFormat();
  const store = totals.value.current;
  const storeBefore = totals.value.previous;
  const reason = totals.blockedReason;
  const storefront = sales.value.storefront;
  const perSession = store.sessions && storefront.current ? storefront.current.netSales / store.sessions : null;
  const previousPerSession =
    storeBefore?.sessions && storefront.previous ? storefront.previous.netSales / storeBefore.sessions : null;
  return (
    <>
      {store.sessions === null ? (
        <BlockedCard label={t("insights.overview.sessions")} reason={reason ?? "insights.overview.notMeasured"} />
      ) : (
        <KpiCard
          label={t("insights.overview.sessions")}
          value={integer(store.sessions)}
          delta={<DeltaChip current={store.sessions} previous={storeBefore?.sessions ?? null} polarity="up" compareLabel={compareLabel} />}
          sub={[{ label: t("insights.overview.pageviews"), value: store.pageviews === null ? "—" : integer(store.pageviews) }]}
        />
      )}
      {store.conversionRate === null ? (
        <BlockedCard label={t("insights.overview.conversion")} reason={reason ?? "insights.overview.notMeasured"} />
      ) : (
        <KpiCard
          label={t("insights.overview.conversion")}
          value={percentOf(store.conversionRate, 2)}
          delta={
            <DeltaChip
              current={store.conversionRate}
              previous={storeBefore?.conversionRate ?? null}
              polarity="up"
              points
              compareLabel={compareLabel}
            />
          }
          sub={[{ label: t("insights.overview.bounce"), value: store.bounceRate === null ? "—" : percentOf(store.bounceRate, 1) }]}
        />
      )}
      {perSession === null ? (
        <BlockedCard
          label={t("insights.overview.perSession")}
          reason={reason ?? sales.blockedReason ?? "insights.overview.needsSessions"}
        />
      ) : (
        <KpiCard
          label={t("insights.overview.perSession")}
          value={euros(perSession, { cents: true })}
          delta={<DeltaChip current={perSession} previous={previousPerSession} polarity="up" compareLabel={compareLabel} />}
          sub={[{ label: t("insights.overview.storefrontNet"), value: euros(storefront.current!.netSales) }]}
        />
      )}
    </>
  );
}

/**
 * The trend on the headline's basis: Shopify's net sales, orders and AOV per
 * bucket. Our synced orders draw it only when Shopify could not be read, and
 * the chart says so.
 */
function Trend({
  panel,
  series,
  sessions,
}: {
  panel: OverviewPanel;
  series: LivePart<SalesSeries | null>;
  sessions: LivePart<SeriesPoint[] | null>;
}) {
  const t = getT();
  const shopify = series.value;
  return (
    <OverviewTrend
      revenueLabel={shopify ? t("insights.overview.netSales") : t("insights.overview.revenue")}
      revenue={shopify ? shopify.netSales : panel.revenue}
      orders={shopify ? shopify.orders : panel.orders}
      aov={shopify ? shopify.aov : panel.aov}
      note={shopify ? null : t("insights.overview.fallbackNote")}
      sessions={sessions.value}
      sessionsBlockedReason={sessions.blockedReason}
    />
  );
}

/**
 * What moved net sales: orders and Shopify's AOV, each as a relative change.
 * Shopify's AOV is (gross − discounts) ÷ orders — before returns — so orders ×
 * AOV is net sales plus returns, and the two changes never add up to the total
 * exactly; the total is shown beside them, not as their sum.
 */
function MoneyDrivers({
  sales,
  panel,
  compareLabel,
  sessionRows,
}: {
  sales: Sales;
  panel: OverviewPanel;
  compareLabel: string;
  sessionRows: ReactNode;
}) {
  const t = getT();
  const now = sales.value.current;
  const then = sales.value.previous;
  const shopify = now !== null;
  const drivers = shopify
    ? revenueDrivers(
        { revenue: now.netSales, paidOrders: now.orders, aov: now.averageOrderValue },
        then ? { revenue: then.netSales, paidOrders: then.orders, aov: then.averageOrderValue } : null
      )
    : revenueDrivers(
        { revenue: panel.summary.current.revenue, paidOrders: panel.figures.current.paidOrders },
        panel.summary.previous && panel.figures.previous
          ? { revenue: panel.summary.previous.revenue, paidOrders: panel.figures.previous.paidOrders }
          : null
      );
  return (
    <>
      <div className={styles.driverTotal}>
        <span>{shopify ? t("insights.overview.netSalesChange") : t("insights.overview.revenueChange")}</span>
        <strong className={tone(drivers.total)}>{signed(drivers.total)}</strong>
      </div>
      <ul className={styles.drivers}>
        <DriverRow label={t("insights.overview.orders")} hint={t("insights.overview.volume")} value={drivers.orders} />
        <DriverRow label={t("insights.overview.aov")} hint={t("insights.overview.basket")} value={drivers.aov} />
        {sessionRows}
      </ul>
      <p className={styles.callout}>
        {drivers.lead === null ? (
          <>{t("insights.overview.noEarlier")}</>
        ) : (
          <>
            <b>{t(drivers.lead === "orders" ? "insights.overview.movedOrders" : "insights.overview.movedAov")}</b>{" "}
            {t("insights.kit.vs", { label: compareLabel })}. {t("insights.overview.driversNote")}
          </>
        )}
      </p>
      {shopify ? null : <Caption>{t("insights.overview.fallbackNote")}.</Caption>}
    </>
  );
}

function SessionDrivers({ totals }: { totals: Totals }) {
  const t = getT();
  const relative = (now: number | null, then: number | null | undefined) =>
    now === null || then === null || then === undefined || then === 0 ? null : (now - then) / Math.abs(then);
  const store = totals.value.current;
  const before = totals.value.previous;
  const sessionChange = relative(store.sessions, before?.sessions);
  const conversionChange = relative(store.conversionRate, before?.conversionRate);
  const title = t(totals.blockedReason ?? "insights.overview.needsSessionsData");
  return (
    <>
      <DriverRow label={t("insights.overview.sessions")} hint={t("insights.overview.trafficHint")} value={sessionChange} blocked={sessionChange === null} blockedTitle={title} />
      <DriverRow
        label={t("insights.overview.conversion")}
        hint={t("insights.overview.efficiencyHint")}
        value={conversionChange}
        blocked={conversionChange === null}
        blockedTitle={title}
      />
    </>
  );
}

/**
 * The platform split on Shopify's net sales, every platform whatever the
 * filter — so the shares add up to the Net sales card when the filter is off.
 */
function PlatformMix({ sales, panel }: { sales: Sales; panel: OverviewPanel }) {
  const t = getT();
  if (sales.value.current) {
    return (
      <MixBars
        title={t("insights.overview.byPlatformNet")}
        rows={sales.value.platforms.map((p) => ({ key: p.platform, label: p.label, value: p.netSales }))}
      />
    );
  }
  return (
    <>
      <MixBars title={t("insights.overview.byPlatform")} rows={panel.platforms.map((p) => ({ key: p.platform, label: p.label, value: p.revenue }))} />
      <Caption>{t("insights.overview.fallbackNote")}.</Caption>
    </>
  );
}

/**
 * Shopify's ladder as a real chain, read from the top line down to the value
 * of the goods:
 *   total − (VAT + shipping)   = net sales
 *   net   + discounts + returns = gross sales
 * Every step is arithmetic the reader can follow along the row.
 */
function SalesBridge({ sales }: { sales: Sales }) {
  const t = getT();
  const { euros } = getFormat();
  const ladder = sales.value.current;
  if (!ladder) return <p className={styles.muted}>{t(sales.blockedReason ?? "insights.overview.shopifyUnreadable")}</p>;
  const steps = [
    { label: t("insights.overview.totalSales"), value: ladder.totalSales, kind: "net" as const },
    { label: t("insights.overview.vatShipping"), value: ladder.taxes + ladder.shipping, kind: "cost" as const },
    { label: t("insights.overview.netSales"), value: ladder.netSales, kind: "net" as const },
    { label: t("insights.overview.discounts"), value: ladder.discounts, kind: "add" as const },
    { label: t("insights.overview.returns"), value: ladder.returns, kind: "add" as const },
    { label: t("insights.overview.grossSales"), value: ladder.grossSales, kind: "gross" as const },
  ];
  return (
    <>
      <Bridge steps={steps} />
      <Caption>{t("insights.overview.bridgeNote", { vat: euros(ladder.taxes), shipping: euros(ladder.shipping) })}</Caption>
    </>
  );
}

function signed(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : "−"}${getFormat().percentOf(Math.abs(value * 100), 1)}`;
}

function tone(value: number | null): string {
  if (value === null || Math.abs(value) < 0.0005) return styles.flat;
  return value > 0 ? styles.up : styles.down;
}

function DriverRow({
  label,
  hint,
  value,
  blocked = false,
  blockedTitle,
}: {
  label: string;
  hint: string;
  value: number | null;
  blocked?: boolean;
  blockedTitle?: string;
}) {
  const t = getT();
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
      <span className={`${styles.driverValue} ${blocked ? styles.flat : tone(value)}`} title={blocked ? blockedTitle ?? t("insights.overview.needsSessionsData") : undefined}>
        {blocked ? "—" : signed(value)}
      </span>
    </li>
  );
}

type BridgeKind = "gross" | "cost" | "net" | "add";

/** The sign the step carries along the chain: taken off, added back, or a subtotal. */
function signedStep(kind: BridgeKind, value: number): string {
  const { euros } = getFormat();
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
  const t = getT();
  const { euros, percentOf } = getFormat();
  const sum = total ?? rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={styles.mix}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className={styles.muted}>{t("insights.overview.noSales")}</p> : null}
      {rows.map((row) => (
        <div key={row.key} className={styles.mixRow} title={`${row.label} · ${euros(row.value)}`}>
          <span className={styles.mixLabel}>{row.label}</span>
          <span className={styles.track}>
            <i className={styles.fill} style={{ width: `${(row.value / max) * 100}%` }} />
          </span>
          <b>{sum > 0 ? percentOf((row.value / sum) * 100, 0) : "—"}</b>
        </div>
      ))}
    </div>
  );
}
