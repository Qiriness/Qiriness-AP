"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ProviderCampaignRow, ProviderComparison } from "@/lib/marketing-types";
import { useFormat, useT } from "@/lib/i18n/client";
import { DataTable, usePanelHref, type Column } from "./MarketingKit";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./PaidHighlights.module.css";

/**
 * One management-level view per ad provider: spend and results by campaign
 * type (the provider's own classification), then the campaigns with the
 * provider's figures beside Shopify's for the UTM campaign of the same name.
 * The detail — ad sets, creatives, placements — stays on the Social panel.
 */
export function PaidHighlights({ providers }: { providers: ProviderComparison[] }) {
  const tr = useT();
  const href = usePanelHref();
  const connected = providers.filter((p) => p.connected);
  const [id, setId] = useState(connected[0]?.id ?? providers[0]?.id);
  if (!connected.length) return <p className={t.muted}>{tr("insights.mkt.paid.none")}</p>;
  const p = connected.find((x) => x.id === id) ?? connected[0];
  return (
    <>
      <div className={styles.head}>
        <Segmented options={connected.map((x) => ({ id: x.id, label: tr(`insights.mkt.provider.${x.id}`) }))} value={p.id} onChange={setId} label={tr("insights.mkt.paid.provider")} />
        <a className={styles.link} href={href("social", { mode: "paid", network: p.kind ?? "all" })}>
          {tr("insights.mkt.paid.details")} →
        </a>
      </div>
      <TypeSummary provider={p} />
      <CampaignTable provider={p} />
      {p.unmatchedCampaigns.length ? <Unmatched provider={p} /> : null}
      <p className={styles.note}>{tr(`insights.mkt.paid.note.${p.id}`)}</p>
    </>
  );
}

/** Spend and results per campaign type (Google's channel type, Meta's objective). */
function TypeSummary({ provider }: { provider: ProviderComparison }) {
  const tr = useT();
  const { euros, decimal, integer, percentOf } = useFormat();
  const types = new Map<string, { spend: number; value: number; conversions: number; impressions: number; clicks: number }>();
  for (const c of provider.campaigns) {
    const key = c.objective ?? "—";
    const acc = types.get(key) ?? { spend: 0, value: 0, conversions: 0, impressions: 0, clicks: 0 };
    acc.spend += c.spend;
    acc.value += c.conversionValue;
    acc.conversions += c.conversions;
    acc.impressions += c.impressions;
    acc.clicks += c.clicks;
    types.set(key, acc);
  }
  const rows = [...types.entries()].sort((a, b) => b[1].spend - a[1].spend);
  if (!rows.length) return null;
  return (
    <div className={styles.types}>
      {rows.map(([type, v]) => (
        <div key={type} className={styles.type}>
          <span>{typeLabel(type, tr)}</span>
          <strong>{euros(v.spend)}</strong>
          <small>
            {tr("insights.mkt.paid.typeLine", {
              roas: v.spend > 0 ? `${decimal(v.value / v.spend, 2)}×` : "—",
              conv: integer(Math.round(v.conversions)),
              ctr: v.impressions > 0 ? percentOf((v.clicks / v.impressions) * 100, 2) : "—",
            })}
          </small>
        </div>
      ))}
    </div>
  );
}

function typeLabel(type: string, tr: (k: string) => string): string {
  const key = `insights.mkt.paid.type.${type}`;
  const label = tr(key);
  return label === key ? type.replaceAll("_", " ").toLowerCase() : label;
}

function CampaignTable({ provider }: { provider: ProviderComparison }) {
  const tr = useT();
  const { euros, integer, percentOf, decimal } = useFormat();
  const dash = <span className={t.muted}>—</span>;
  const money = (v: number | null, cents = false) => (v === null ? dash : euros(v, { cents }));
  const col = (id: string, sort: (r: ProviderCampaignRow) => number | null, render: (r: ProviderCampaignRow) => ReactNode): Column<ProviderCampaignRow> => ({
    id,
    label: tr(`insights.mkt.paid.col.${id}`),
    tip: tr(`insights.mkt.paid.tip.${id}`),
    numeric: true,
    sort,
    render,
  });
  const meta = provider.id === "meta_ads";
  const columns: Column<ProviderCampaignRow>[] = [
    {
      id: "name",
      label: tr("insights.mkt.paid.col.name"),
      sort: (r) => r.name ?? "",
      render: (r) => (
        <>
          {r.url ? (
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.name ?? r.key}
            </a>
          ) : (
            r.name ?? r.key
          )}
          <span className={t.sub}>
            {typeLabel(r.objective ?? "—", tr)}
            {r.status ? ` · ${r.status.toLowerCase()}` : ""}
          </span>
        </>
      ),
    },
    col("spend", (r) => r.spend, (r) => euros(r.spend)),
    col("impressions", (r) => r.impressions, (r) => integer(r.impressions)),
    col("ctr", (r) => r.ctr, (r) => (r.ctr === null ? dash : percentOf(r.ctr, 2))),
    col("cpc", (r) => r.cpc, (r) => money(r.cpc, true)),
    ...(meta ? [col("cpm", (r) => r.cpm, (r) => money(r.cpm, true))] : []),
    col("conversions", (r) => r.conversions, (r) => decimal(r.conversions, r.conversions % 1 ? 1 : 0)),
    col("value", (r) => r.conversionValue, (r) => euros(r.conversionValue)),
    col("roas", (r) => r.roas, (r) => (r.roas === null ? dash : `${decimal(r.roas, 2)}×`)),
    col("shopifySessions", (r) => r.shopify?.sessions ?? null, (r) => (r.shopify ? integer(r.shopify.sessions) : dash)),
    col("shopifyOrders", (r) => r.shopify?.orders ?? null, (r) => (r.shopify ? integer(Math.round(r.shopify.orders)) : dash)),
    col("shopifyNet", (r) => r.shopify?.netSales ?? null, (r) => (r.shopify ? euros(r.shopify.netSales) : dash)),
    col("shopifyCvr", (r) => r.shopify?.conversionRate ?? null, (r) => (r.shopify?.conversionRate == null ? dash : percentOf(r.shopify.conversionRate, 2))),
  ];
  return (
    <DataTable
      rows={provider.campaigns}
      columns={columns}
      rowKey={(r) => r.key}
      initialSort={{ id: "spend", desc: true }}
      search={(r) => r.name ?? ""}
      limit={12}
      caption={tr("insights.mkt.paid.title")}
      empty={tr("insights.mkt.paid.noCampaigns")}
    />
  );
}

/** UTM campaigns Shopify credits to the provider under a name no provider campaign has. */
function Unmatched({ provider }: { provider: ProviderComparison }) {
  const tr = useT();
  const { euros, integer } = useFormat();
  return (
    <p className={styles.note}>
      {tr("insights.mkt.paid.unmatched")}{" "}
      {provider.unmatchedCampaigns.slice(0, 6).map((u, i) => (
        <span key={u.name}>
          {i ? " · " : ""}
          <b>{u.name}</b> {tr("insights.mkt.paid.unmatchedLine", { sessions: integer(u.sessions), orders: integer(Math.round(u.orders)), net: euros(u.netSales) })}
        </span>
      ))}
    </p>
  );
}
