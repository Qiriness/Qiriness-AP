"use client";

import { useState } from "react";
import type { SeriesPoint } from "@/lib/types";
import { Segmented } from "./Segmented";
import { TimeSeriesChart } from "./TimeSeriesChart";
import styles from "./OverviewView.module.css";

type Metric = "revenue" | "orders" | "aov" | "sessions";

const METRICS: { id: Metric; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "orders", label: "Orders" },
  { id: "aov", label: "AOV" },
  { id: "sessions", label: "Sessions" },
];

/**
 * The performance trend with its metric switch. All three measured series
 * arrive with the page, so switching is instant; Sessions has no source and
 * says so in the chart's place rather than drawing a flat line.
 */
export function OverviewTrend({
  revenue,
  orders,
  aov,
  sessions,
  sessionsBlockedReason,
}: {
  revenue: SeriesPoint[];
  orders: SeriesPoint[];
  aov: SeriesPoint[];
  /** Null when Shopify Analytics could not be read — then the reason is shown. */
  sessions: SeriesPoint[] | null;
  sessionsBlockedReason: string | null;
}) {
  const [metric, setMetric] = useState<Metric>("revenue");
  const chart =
    metric === "revenue" ? (
      <TimeSeriesChart points={revenue} unit="euro" ariaLabel="Revenue" missingLabel="Not synced from Shopify yet" />
    ) : metric === "orders" ? (
      <TimeSeriesChart points={orders} unit="count" ariaLabel="Orders" missingLabel="Not synced from Shopify yet" />
    ) : metric === "aov" ? (
      <TimeSeriesChart
        points={aov}
        unit="euro"
        ariaLabel="Average order value"
        missingLabel="Not synced from Shopify yet"
      />
    ) : sessions ? (
      <TimeSeriesChart points={sessions} unit="count" ariaLabel="Sessions" missingLabel="Not covered by Shopify Analytics" />
    ) : (
      <p className={styles.chartBlocked}>{sessionsBlockedReason ?? "Sessions could not be read from Shopify Analytics."}</p>
    );

  return (
    <>
      <div className={styles.trendTabs}>
        <Segmented options={METRICS} value={metric} onChange={setMetric} label="Trend metric" />
      </div>
      {chart}
    </>
  );
}
