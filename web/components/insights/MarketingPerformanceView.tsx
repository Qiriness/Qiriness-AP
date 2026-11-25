import { Suspense } from "react";
import type { ExecutiveKey, Figure, MarketingPerformanceData, MarketingPerformancePanel, ProviderComparison } from "@/lib/marketing-types";
import type { Grain, LivePart } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import { Await, BlockedCard, Card, DeltaChip, Grid, KpiCard, LoadingCard, type Polarity } from "./InsightsKit";
import { ChannelAttributionTable } from "./ChannelAttributionTable";
import { KlaviyoSectionView } from "./KlaviyoSectionView";
import { CompareBars, InfoTip } from "./MarketingKit";
import { NewsletterRows } from "./NewsletterRows";
import { PaidHighlights } from "./PaidHighlights";
import t from "./tables.module.css";
import styles from "./MarketingPerformanceView.module.css";

type Kind = "money" | "ratio" | "count";

/** The KPIs the row leads with: the ones a budget decision turns on. */
const PRIMARY: { key: ExecutiveKey; kind: Kind; polarity: Polarity }[] = [
  { key: "adSpend", kind: "money", polarity: "neutral" },
  { key: "websiteNet", kind: "money", polarity: "up" },
  { key: "mer", kind: "ratio", polarity: "up" },
  { key: "shopifyRoas", kind: "ratio", polarity: "up" },
  { key: "newCustomers", kind: "count", polarity: "up" },
  { key: "cac", kind: "money", polarity: "down" },
  { key: "newCustomerMer", kind: "ratio", polarity: "up" },
  { key: "revenueAfterAds", kind: "money", polarity: "up" },
];

/** Behind « More figures »: the rest of the definitions, and what is not built yet. */
const SECONDARY: { key: ExecutiveKey; kind: Kind; polarity: Polarity }[] = [
  { key: "providerRoas", kind: "ratio", polarity: "up" },
  { key: "providerRevenue", kind: "money", polarity: "neutral" },
  { key: "shopifyPaidNet", kind: "money", polarity: "up" },
  { key: "cpa", kind: "money", polarity: "down" },
  { key: "marketingCosts", kind: "money", polarity: "neutral" },
  { key: "emer", kind: "ratio", polarity: "up" },
  { key: "newCustomerNet", kind: "money", polarity: "up" },
  { key: "returningNet", kind: "money", polarity: "up" },
  { key: "contribution", kind: "money", polarity: "up" },
  { key: "ltvCac", kind: "ratio", polarity: "up" },
  { key: "ltgpCac", kind: "ratio", polarity: "up" },
];

/**
 * Marketing Performance: what the spend bought, by Shopify's measure and by
 * each provider's, then Klaviyo and the newsletter. The ShopifyQL and ad
 * figures stream in together; Klaviyo and the newsletter are database reads
 * and render at once.
 */
export function MarketingPerformanceView({ panel, compareLabel, grain }: { panel: MarketingPerformancePanel; compareLabel: string; grain: Grain }) {
  const tr = getT();
  return (
    <>
      <Suspense fallback={<LoadingKpis />}>
        <Await promise={panel.performance}>{(part) => <PerformanceBody part={part} compareLabel={compareLabel} />}</Await>
      </Suspense>

      <Grid min={30} pin="klaviyo" label={tr("insights.mkt.klaviyo.title")}>
        <Card title={tr("insights.mkt.klaviyo.title")} span={3} aside={<span>{tr("insights.mkt.klaviyo.aside")}</span>}>
          <Suspense fallback={<KlaviyoSectionView klaviyo={panel.klaviyo} email={null} />}>
            <Await promise={panel.performance}>{(part) => <KlaviyoSectionView klaviyo={panel.klaviyo} email={part.value?.email ?? null} />}</Await>
          </Suspense>
        </Card>
      </Grid>

      <NewsletterRows newsletter={panel.newsletter} grain={grain} compareLabel={compareLabel} />
    </>
  );
}

function LoadingKpis() {
  const tr = getT();
  return (
    <Grid columns={8}>
      {PRIMARY.map((k) => (
        <LoadingCard key={k.key} label={tr(`insights.mkt.kpi.${k.key}.label`)} />
      ))}
    </Grid>
  );
}

function PerformanceBody({ part, compareLabel }: { part: LivePart<MarketingPerformanceData | null>; compareLabel: string }) {
  const tr = getT();
  if (part.blockedReason || !part.value) {
    return (
      <Grid min={20}>
        <BlockedCard label={tr("insights.mkt.title")} reason={part.blockedReason ?? "insights.mkt.state.unreadable"} />
      </Grid>
    );
  }
  const data = part.value;
  return (
    <>
      <Grid columns={8} pin="marketing-kpis" label={tr("insights.mkt.kpisRow")}>
        {PRIMARY.map((k) => (
          <FigureCard key={k.key} def={k} data={data} compareLabel={compareLabel} />
        ))}
      </Grid>
      <details className={styles.more}>
        <summary>{tr("insights.mkt.moreFigures")}</summary>
        <Grid min={14}>
          {SECONDARY.map((k) => (
            <FigureCard key={k.key} def={k} data={data} compareLabel={compareLabel} />
          ))}
        </Grid>
      </details>

      <Grid min={24} pin="attribution" label={tr("insights.mkt.attr.title")}>
        {data.providers.map((p) => (
          <ProviderCard key={p.id} provider={p} model={data.model} />
        ))}
      </Grid>

      <Grid min={30} pin="channels" label={tr("insights.mkt.channels.title")}>
        <Card title={tr("insights.mkt.channels.title")} span={3} aside={<span>{tr(`insights.mkt.model.${data.model}`)}</span>}>
          <ChannelAttributionTable rows={data.channels} />
          <AttributionNotes data={data} />
        </Card>
      </Grid>

      <Grid min={30} pin="paid-highlights" label={tr("insights.mkt.paid.title")}>
        <Card title={tr("insights.mkt.paid.title")} span={3} aside={<span>{tr("insights.mkt.paid.aside")}</span>}>
          <PaidHighlights providers={data.providers.filter((p) => p.kind !== null)} />
        </Card>
      </Grid>
    </>
  );
}

function formatFigure(value: number, kind: Kind): string {
  const { euros, integer, decimal } = getFormat();
  if (kind === "money") return euros(value);
  if (kind === "count") return integer(Math.round(value));
  return `${decimal(value, 2)}×`;
}

function FigureCard({ def, data, compareLabel }: { def: { key: ExecutiveKey; kind: Kind; polarity: Polarity }; data: MarketingPerformanceData; compareLabel: string }) {
  const tr = getT();
  const label = tr(`insights.mkt.kpi.${def.key}.label`);
  const tip = <InfoTip text={tr(`insights.mkt.kpi.${def.key}.tip`)} label={label} />;
  const now: Figure = data.kpis.current[def.key];
  const before: Figure | undefined = data.kpis.previous?.[def.key];
  if (now.value === null) {
    return (
      <KpiCard
        label={label}
        action={tip}
        value={<span className={t.muted}>—</span>}
        unit={<span className={styles.state}>{tr(`insights.mkt.state.${now.state}`)}</span>}
        sub={now.reason ? [{ label: tr(now.reason), value: "" }] : undefined}
      />
    );
  }
  const sub =
    def.key === "shopifyRoas" && data.kpis.current.providerRoas.value !== null
      ? [{ label: tr("insights.mkt.kpi.providerRoas.label"), value: formatFigure(data.kpis.current.providerRoas.value, "ratio") }]
      : def.key === "cac" && data.kpis.current.cpa.value !== null
        ? [{ label: tr("insights.mkt.kpi.cpa.label"), value: formatFigure(data.kpis.current.cpa.value, "money") }]
        : def.key === "websiteNet" && data.kpis.current.newCustomerNet.value !== null && now.value > 0
          ? [{ label: tr("insights.mkt.kpi.newShare"), value: getFormat().percentOf((data.kpis.current.newCustomerNet.value / now.value) * 100, 0) }]
          : undefined;
  return (
    <KpiCard
      label={label}
      action={tip}
      value={formatFigure(now.value, def.kind)}
      delta={<DeltaChip current={now.value} previous={before?.value ?? null} polarity={def.polarity} compareLabel={compareLabel} />}
      sub={sub}
    />
  );
}

/**
 * One provider against Shopify: revenue, orders, new customers, ROAS, CPA and
 * CAC side by side, the difference, and the spend / claimed / credited bars.
 */
function ProviderCard({ provider: p, model }: { provider: ProviderComparison; model: string }) {
  const tr = getT();
  const { euros, integer, decimal, percentOf, age } = getFormat();
  const title = tr(`insights.mkt.provider.${p.id}`);
  const sync = p.lastSyncAt ? tr("insights.mkt.attr.synced", { ago: age(p.lastSyncAt) }) : null;
  if (!p.connected) {
    return (
      <Card title={title} aside={<span>{tr("insights.mkt.attr.notConnected")}</span>}>
        <p className={t.muted}>{tr(p.blockedReason ?? "insights.mkt.state.providerNotConnected")}</p>
      </Card>
    );
  }
  const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : euros(v));
  const ratio = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${decimal(v, 2)}×`);
  const count = (v: number | null | undefined) => (v === null || v === undefined ? "—" : integer(Math.round(v)));
  const diff = (d: { abs: number; pct: number | null } | null | undefined, fmt: (v: number) => string) =>
    !d ? "—" : `${d.abs >= 0 ? "+" : "−"}${fmt(Math.abs(d.abs))}${d.pct === null ? "" : ` (${d.pct >= 0 ? "+" : "−"}${percentOf(Math.abs(d.pct), 0)})`}`;
  const owned = p.kind === null;
  const rows: { label: string; tip: string; provider: string; shopify: string; difference: string }[] = [
    {
      label: tr("insights.mkt.attr.revenue"),
      tip: tr("insights.mkt.attr.revenueTip"),
      provider: money(p.provider?.revenue),
      shopify: money(p.shopify.totalSales),
      difference: diff(p.difference?.revenue, (v) => euros(v)),
    },
    {
      label: tr("insights.mkt.attr.orders"),
      tip: tr("insights.mkt.attr.ordersTip"),
      provider: count(p.provider?.conversions),
      shopify: count(p.shopify.orders),
      difference: diff(p.difference?.orders, (v) => integer(Math.round(v))),
    },
    {
      label: tr("insights.mkt.attr.newCustomers"),
      tip: tr("insights.mkt.attr.newCustomersTip"),
      provider: "—",
      shopify: count(p.shopify.newCustomers),
      difference: "—",
    },
  ];
  if (!owned) {
    rows.push(
      { label: tr("insights.mkt.attr.roas"), tip: tr("insights.mkt.attr.roasTip"), provider: ratio(p.provider?.roas), shopify: ratio(p.shopify.roasTotal), difference: "—" },
      { label: tr("insights.mkt.attr.cpa"), tip: tr("insights.mkt.attr.cpaTip"), provider: money(p.provider?.cpa), shopify: money(p.shopify.cpa), difference: "—" },
      { label: tr("insights.mkt.attr.cac"), tip: tr("insights.mkt.attr.cacTip"), provider: "—", shopify: money(p.shopify.cac), difference: "—" }
    );
  }
  return (
    <Card title={title} aside={sync ? <span>{sync}</span> : null}>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.mkt.attr.metric")}</th>
              <th scope="col" className={t.n}>{tr(owned ? "insights.mkt.attr.klaviyoSide" : "insights.mkt.attr.providerSide")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.attr.shopifySide")}</th>
              <th scope="col" className={t.n}>{tr("insights.mkt.attr.difference")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  {r.label}
                  <InfoTip text={r.tip} label={r.label} />
                </th>
                <td className={t.n}>{r.provider}</td>
                <td className={t.n}>{r.shopify}</td>
                <td className={t.n}>{r.difference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className={styles.facts}>
        {!owned ? (
          <div>
            <dt>{tr("insights.mkt.attr.spend")}</dt>
            <dd>{money(p.spend)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{tr("insights.mkt.attr.sessions")}</dt>
          <dd>{count(p.sessions)}</dd>
        </div>
        <div>
          <dt>{tr("insights.mkt.attr.cvr")}</dt>
          <dd>{p.conversionRate === null ? "—" : percentOf(p.conversionRate, 2)}</dd>
        </div>
        <div>
          <dt>{tr("insights.mkt.attr.aov")}</dt>
          <dd>{p.shopify.aov === null ? "—" : euros(p.shopify.aov, { cents: true })}</dd>
        </div>
        <div>
          <dt>{tr("insights.mkt.attr.rps")}</dt>
          <dd>{p.revenuePerSession === null ? "—" : euros(p.revenuePerSession, { cents: true })}</dd>
        </div>
        <div>
          <dt>{tr("insights.mkt.attr.newShare")}</dt>
          <dd>{p.shopify.newCustomerShare === null ? "—" : percentOf(p.shopify.newCustomerShare, 0)}</dd>
        </div>
      </dl>
      <CompareBarsServer
        bars={[
          ...(owned ? [] : [{ label: tr("insights.mkt.attr.spend"), value: p.spend, tone: "spend" as const }]),
          { label: tr("insights.mkt.attr.claimed", { name: title }), value: p.provider?.revenue ?? null, tone: "provider" as const },
          { label: tr("insights.mkt.attr.credited"), value: p.shopify.totalSales, tone: "shopify" as const },
        ]}
      />
      <p className={styles.note}>{tr(`insights.mkt.attr.note.${p.id}`, { model: tr(`insights.mkt.model.${model}`) })}</p>
    </Card>
  );
}

/** The bars, formatted on the server (the client island takes strings only). */
function CompareBarsServer({ bars }: { bars: { label: string; value: number | null; tone: "spend" | "provider" | "shopify" }[] }) {
  const { euros } = getFormat();
  return <CompareBars bars={bars.map((b) => ({ ...b, display: b.value === null ? "—" : euros(b.value) }))} />;
}

/** How the figures above were attributed, and how much of the website's revenue nothing could place. */
function AttributionNotes({ data }: { data: MarketingPerformanceData }) {
  const tr = getT();
  const { integer, percentOf } = getFormat();
  const c = data.coverage;
  return (
    <dl className={styles.notes}>
      <div>
        <dt>{tr("insights.mkt.notes.model")}</dt>
        <dd>{tr(`insights.mkt.model.${data.model}.long`)}</dd>
      </div>
      <div>
        <dt>{tr("insights.mkt.notes.windows")}</dt>
        <dd>{tr("insights.mkt.notes.windowsText")}</dd>
      </div>
      <div>
        <dt>{tr("insights.mkt.notes.revenue")}</dt>
        <dd>{tr("insights.mkt.notes.revenueText")}</dd>
      </div>
      <div>
        <dt>{tr("insights.mkt.notes.dates")}</dt>
        <dd>{tr("insights.mkt.notes.datesText")}</dd>
      </div>
      <div>
        <dt>{tr("insights.mkt.notes.coverage")}</dt>
        <dd>
          {c.knownShare === null
            ? "—"
            : tr("insights.mkt.notes.coverageText", { share: percentOf(c.knownShare, 0), unknown: integer(c.unknownOrders), orders: integer(c.orders) })}
        </dd>
      </div>
      <div>
        <dt>{tr("insights.mkt.notes.incrementality")}</dt>
        <dd>{tr("insights.mkt.notes.incrementalityText")}</dd>
      </div>
    </dl>
  );
}
