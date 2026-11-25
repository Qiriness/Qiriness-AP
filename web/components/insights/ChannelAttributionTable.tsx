"use client";

import type { ReactNode } from "react";
import type { ChannelRow } from "@/lib/marketing-types";
import { useFormat, useT } from "@/lib/i18n/client";
import { DataTable, type Column } from "./MarketingKit";
import t from "./tables.module.css";

/**
 * Every channel group by Shopify's attribution: traffic, conversion, money,
 * new customers, and — only where a connected provider carries it — spend
 * with ROAS, CAC and CPA. Spend is never spread over groups it was not spent in.
 */
export function ChannelAttributionTable({ rows }: { rows: ChannelRow[] }) {
  const tr = useT();
  const { euros, integer, percentOf, decimal } = useFormat();
  const dash = <span className={t.muted}>—</span>;
  const pct = (v: number | null, d = 1) => (v === null ? dash : percentOf(v, d));
  const money = (v: number | null, cents = false) => (v === null ? dash : euros(v, { cents }));
  const col = (id: string, sort: (r: ChannelRow) => number | null, render: (r: ChannelRow) => ReactNode): Column<ChannelRow> => ({
    id,
    label: tr(`insights.mkt.channels.col.${id}`),
    tip: tr(`insights.mkt.channels.tip.${id}`),
    numeric: true,
    sort,
    render,
  });
  const columns: Column<ChannelRow>[] = [
    { id: "group", label: tr("insights.mkt.channels.col.group"), sort: (r) => tr(`insights.mkt.group.${r.group}`), render: (r) => tr(`insights.mkt.group.${r.group}`) },
    col("sessions", (r) => r.sessions, (r) => integer(r.sessions)),
    col("sessionShare", (r) => r.sessionShare, (r) => pct(r.sessionShare, 0)),
    col("cvr", (r) => r.conversionRate, (r) => pct(r.conversionRate, 2)),
    col("orders", (r) => r.orders, (r) => integer(Math.round(r.orders))),
    col("revenue", (r) => r.netSales, (r) => euros(r.netSales)),
    col("revenueShare", (r) => r.revenueShare, (r) => pct(r.revenueShare, 0)),
    col("aov", (r) => r.aov, (r) => money(r.aov, true)),
    col("rps", (r) => r.revenuePerSession, (r) => money(r.revenuePerSession, true)),
    col("newCustomers", (r) => r.newCustomers, (r) => integer(Math.round(r.newCustomers))),
    col("newShare", (r) => r.newCustomerShare, (r) => pct(r.newCustomerShare, 0)),
    col("spend", (r) => r.spend, (r) => money(r.spend)),
    col("spendShare", (r) => r.spendShare, (r) => pct(r.spendShare, 0)),
    col("roas", (r) => r.roas, (r) => (r.roas === null ? dash : `${decimal(r.roas, 2)}×`)),
    col("cac", (r) => r.cac, (r) => money(r.cac)),
    col("cpa", (r) => r.cpa, (r) => money(r.cpa)),
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => r.group} initialSort={{ id: "revenue", desc: true }} caption={tr("insights.mkt.channels.title")} />;
}
