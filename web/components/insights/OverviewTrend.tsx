"use client";

import { useState } from "react";
import type { SeriesPoint } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { Segmented } from "./Segmented";
import { TimeSeriesChart } from "./TimeSeriesChart";
import styles from "./OverviewView.module.css";

type Metric = "revenue" | "orders" | "aov" | "sessions";

/**
 * The performance trend with its metric switch. Every series arrives
 * together, so switching is instant; a series that could not be read says so
 * in the chart's place rather than drawing a flat line. The money series are
 * Shopify's net sales, orders and AOV — the headline's basis — and `note`
 * names the fallback when they had to come from our synced orders instead.
 */
export function OverviewTrend({
  revenueLabel,
  note = null,
  revenue,
  orders,
  aov,
  sessions,
  sessionsBlockedReason,
}: {
  revenueLabel?: string;
  note?: string | null;
  revenue: SeriesPoint[];
  orders: SeriesPoint[];
  aov: SeriesPoint[];
  /** Null when Shopify Analytics could not be read — then the reason is shown. */
  sessions: SeriesPoint[] | null;
  sessionsBlockedReason: string | null;
}) {
  const t = useT();
  const revenueName = revenueLabel ?? t("insights.overview.netSales");
  const [metric, setMetric] = useState<Metric>("revenue");
  const metrics: { id: Metric; label: string }[] = [
    { id: "revenue", label: revenueName },
    { id: "orders", label: t("insights.overview.orders") },
    { id: "aov", label: t("insights.overview.aov") },
    { id: "sessions", label: t("insights.overview.sessions") },
  ];
  const chart =
    metric === "revenue" ? (
      <TimeSeriesChart points={revenue} unit="euro" ariaLabel={revenueName} missingLabel="insights.overview.notMeasured" />
    ) : metric === "orders" ? (
      <TimeSeriesChart points={orders} unit="count" ariaLabel={t("insights.overview.orders")} missingLabel="insights.overview.notMeasured" />
    ) : metric === "aov" ? (
      <TimeSeriesChart
        points={aov}
        unit="euro"
        ariaLabel={t("insights.overview.aovFull")}
        missingLabel="insights.overview.notMeasured"
      />
    ) : sessions ? (
      <TimeSeriesChart points={sessions} unit="count" ariaLabel={t("insights.overview.sessions")} missingLabel="insights.overview.notCovered" />
    ) : (
      <p className={styles.chartBlocked}>{t(sessionsBlockedReason ?? "insights.overview.sessionsUnreadable")}</p>
    );

  return (
    <>
      <div className={styles.trendTabs}>
        <Segmented options={metrics} value={metric} onChange={setMetric} label={t("insights.overview.trendMetric")} />
      </div>
      {chart}
      {note && metric !== "sessions" ? <p className={styles.chartNote}>{note}</p> : null}
    </>
  );
}
