"use client";

import { useState } from "react";
import type { SeriesPoint } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { Segmented } from "./Segmented";
import { TimeSeriesChart } from "./TimeSeriesChart";
import styles from "./OverviewView.module.css";

type Metric = "views" | "engagement" | "growth" | "posts";

/** The organic trend with its metric switch; every series arrives together, so switching is instant. */
export function SocialTrend({ series }: { series: Record<Metric, SeriesPoint[]> }) {
  const t = useT();
  const [metric, setMetric] = useState<Metric>("views");
  const metrics: { id: Metric; label: string }[] = (["views", "engagement", "growth", "posts"] as Metric[]).map((id) => ({
    id,
    label: t(`insights.social.trend.${id}`),
  }));
  return (
    <>
      <div className={styles.trendTabs}>
        <Segmented options={metrics} value={metric} onChange={setMetric} label={t("insights.social.trend.metric")} />
      </div>
      <TimeSeriesChart points={series[metric]} unit="count" ariaLabel={t(`insights.social.trend.${metric}`)} missingLabel="insights.social.notSynced" />
    </>
  );
}
