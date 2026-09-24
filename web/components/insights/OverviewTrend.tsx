"use client";

import { useState } from "react";
import type { SeriesPoint } from "@/lib/types";
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
  revenueLabel = "Net sales",
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
  const [metric, setMetric] = useState<Metric>("revenue");
  const metrics: { id: Metric; label: string }[] = [
    { id: "revenue", label: revenueLabel },
    { id: "orders", label: "Orders" },
    { id: "aov", label: "AOV" },
    { id: "sessions", label: "Sessions" },
  ];
  const chart =
    metric === "revenue" ? (
      <TimeSeriesChart points={revenue} unit="euro" ariaLabel={revenueLabel} missingLabel="Not measured" />
    ) : metric === "orders" ? (
      <TimeSeriesChart points={orders} unit="count" ariaLabel="Orders" missingLabel="Not measured" />
    ) : metric === "aov" ? (
      <TimeSeriesChart
        points={aov}
        unit="euro"
        ariaLabel="Average order value"
        missingLabel="Not measured"
      />
    ) : sessions ? (
      <TimeSeriesChart points={sessions} unit="count" ariaLabel="Sessions" missingLabel="Not covered by Shopify Analytics" />
    ) : (
      <p className={styles.chartBlocked}>{sessionsBlockedReason ?? "Sessions could not be read from Shopify Analytics."}</p>
    );

  return (
    <>
      <div className={styles.trendTabs}>
        <Segmented options={metrics} value={metric} onChange={setMetric} label="Trend metric" />
      </div>
      {chart}
      {note && metric !== "sessions" ? <p className={styles.chartNote}>{note}</p> : null}
    </>
  );
}
