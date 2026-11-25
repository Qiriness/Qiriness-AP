"use client";

import type { ReactNode } from "react";
import type { Opportunity, WebsitePerformanceData } from "@/lib/marketing-types";
import { useFormat, useT } from "@/lib/i18n/client";
import { DataTable, typeName, type Column } from "./MarketingKit";
import t from "./tables.module.css";
import styles from "./WebsiteExplorer.module.css";

/**
 * Pages worth the next hour of work, by conversions they would add at the
 * conversion rate of comparable pages (scripts/lib/website-opportunities.mjs).
 * The revenue is an estimate at the site's average order value, and says so.
 */
export function OpportunitiesTable({ data }: { data: WebsitePerformanceData }) {
  const tr = useT();
  const { integer, percentOf, euros, decimal } = useFormat();
  const dash = <span className={t.muted}>—</span>;
  const col = (id: string, sort: (r: Opportunity) => number | null, render: (r: Opportunity) => ReactNode): Column<Opportunity> => ({
    id,
    label: tr(`insights.mkt.opps.col.${id}`),
    tip: tr(`insights.mkt.opps.colTip.${id}`),
    numeric: true,
    sort,
    render,
  });
  const columns: Column<Opportunity>[] = [
    {
      id: "page",
      label: tr("insights.mkt.landing.col.page"),
      sort: (o) => o.title ?? o.path,
      render: (o) => (
        <>
          {o.title ?? o.path}
          <span className={t.sub}>
            {typeName(o.type, tr)}
            {o.segment && segmentLabel(o.segment, tr) ? ` · ${segmentLabel(o.segment, tr)}` : ""}
          </span>
          {o.flags.map((f) => (
            <span key={f} className={styles.flag}>
              {tr(`insights.mkt.opps.flag.${f}`)}
            </span>
          ))}
        </>
      ),
    },
    col("sessions", (o) => o.sessions, (o) => integer(o.sessions)),
    col("cvr", (o) => o.conversionRate, (o) => percentOf(o.conversionRate, 2)),
    col("benchmark", (o) => o.benchmarkRate, (o) => (o.benchmarkRate === null ? dash : `${percentOf(o.benchmarkRate, 2)} (${integer(o.peers)})`)),
    col("atc", (o) => o.addToCartRate, (o) => `${percentOf(o.addToCartRate, 1)}${o.benchmarkAddToCart === null ? "" : ` / ${percentOf(o.benchmarkAddToCart, 1)}`}`),
    col("potential", (o) => o.potentialConversions, (o) => (o.potentialConversions > 0 ? `+${decimal(o.potentialConversions, o.potentialConversions < 10 ? 1 : 0)}` : dash)),
    col("revenue", (o) => o.potentialRevenue, (o) => (o.potentialRevenue === null || o.potentialRevenue <= 0 ? dash : `≈ ${euros(o.potentialRevenue)}`)),
    col("confidence", (o) => (o.confidence === "ok" ? 1 : 0), (o) => (o.confidence === "ok" ? tr("insights.mkt.opps.ok") : <span className={t.muted}>{tr("insights.mkt.opps.low")}</span>)),
  ];
  return (
    <>
      <DataTable rows={data.opportunities} columns={columns} rowKey={(o) => o.path} initialSort={{ id: "potential", desc: true }} empty={tr("insights.mkt.opps.none")} />
      <p className={styles.note}>{tr("insights.mkt.opps.note", { aov: data.aov === null ? "—" : euros(data.aov, { cents: true }) })}</p>
    </>
  );
}

function segmentLabel(segment: string, tr: (k: string) => string): string {
  const [kind, value] = segment.split(":");
  if (kind === "product") return tr(`insights.mkt.band.${value}`);
  if (kind === "collection") return tr(`insights.mkt.category.${value}`);
  return "";
}
