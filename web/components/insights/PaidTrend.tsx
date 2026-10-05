"use client";

import { useState } from "react";
import type { SeriesPoint, ValueUnit } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { Segmented } from "./Segmented";
import { TimeSeriesChart } from "./TimeSeriesChart";
import styles from "./OverviewView.module.css";

type Metric = "spend" | "revenue" | "roas" | "conversions";

/**
 * Spend, platform-attributed revenue, ROAS and conversions over the range. The
 * chart formats euros and dollars itself; any other currency is drawn as a
 * plain amount and named beside the switch, never relabelled as euros.
 */
export function PaidTrend({ series, currency }: { series: Record<Metric, SeriesPoint[]>; currency: string }) {
  const t = useT();
  const [metric, setMetric] = useState<Metric>("spend");
  const moneyUnit: ValueUnit = currency === "EUR" ? "euro" : currency === "USD" ? "usd" : "count";
  const unit: ValueUnit = metric === "roas" ? "multiple" : metric === "conversions" ? "count" : moneyUnit;
  return (
    <>
      <div className={styles.trendTabs}>
        {moneyUnit === "count" && (metric === "spend" || metric === "revenue") ? <span className={styles.muted}>{currency}&nbsp;&nbsp;</span> : null}
        <Segmented
          options={(["spend", "revenue", "roas", "conversions"] as Metric[]).map((id) => ({ id, label: t(`insights.social.paid.series.${id}`) }))}
          value={metric}
          onChange={setMetric}
          label={t("insights.social.trend.metric")}
        />
      </div>
      <TimeSeriesChart points={series[metric]} unit={unit} ariaLabel={t(`insights.social.paid.series.${metric}`)} missingLabel="insights.social.notSynced" />
    </>
  );
}
