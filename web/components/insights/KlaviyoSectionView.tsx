"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { KlaviyoSection, ShopifySide } from "@/lib/marketing-types";
import type { KlaviyoMessageRow } from "@/lib/types";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { formatDayL } from "@/lib/insights-labels";
import { DataTable, InfoTip, type Column } from "./MarketingKit";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./KlaviyoSectionView.module.css";

type View = "campaign" | "flow" | "forms";

/**
 * Klaviyo as an owned channel: its own attribution beside Shopify's email
 * figures, then campaigns, flows and sign-up forms as separate tables.
 *
 * Opens lead nothing here: Apple Mail Privacy Protection opens every mail it
 * receives, so the tables sort by revenue and the open rate carries the warning.
 * Sends with no click or under 50 recipients are counted in the tiles and left
 * out of the tables (the owner's rule, 2026-09-25), and the note says how many.
 */
export function KlaviyoSectionView({ klaviyo, email }: { klaviyo: KlaviyoSection; email: { shopify: ShopifySide; sessions: number | null; conversionRate: number | null } | null }) {
  const tr = useT();
  const { euros, integer, percentOf } = useFormat();
  const [view, setView] = useState<View>("campaign");
  if (klaviyo.blockedReason || !klaviyo.summary) {
    return <p className={t.muted}>{tr(klaviyo.blockedReason ?? "insights.marketing.klaviyoNoSync")}</p>;
  }
  const s = klaviyo.summary;
  const rate = (v: number | null) => (v === null ? "—" : percentOf(v * 100, 1));
  const shopifyTotal = email?.shopify.totalSales ?? null;
  const gap = shopifyTotal !== null && shopifyTotal > 0 ? ((s.revenue - shopifyTotal) / shopifyTotal) * 100 : null;
  const tiles: { key: string; value: string }[] = [
    { key: "klaviyoRevenue", value: euros(s.revenue) },
    { key: "shopifyRevenue", value: email ? euros(email.shopify.netSales) : "…" },
    { key: "gap", value: gap === null ? "—" : `${gap >= 0 ? "+" : "−"}${percentOf(Math.abs(gap), 0)}` },
    { key: "campaignRevenue", value: klaviyo.byKind ? euros(klaviyo.byKind.campaign.revenue) : "—" },
    { key: "flowRevenue", value: klaviyo.byKind ? euros(klaviyo.byKind.flow.revenue) : "—" },
    { key: "rpr", value: s.revenuePerRecipient === null ? "—" : euros(s.revenuePerRecipient, { cents: true }) },
    { key: "orderRate", value: klaviyo.conversions !== null && s.recipients > 0 ? percentOf((klaviyo.conversions / s.recipients) * 100, 2) : "—" },
    { key: "klaviyoOrders", value: klaviyo.conversions === null ? "—" : integer(klaviyo.conversions) },
    { key: "shopifyOrders", value: email ? integer(Math.round(email.shopify.orders)) : "…" },
    { key: "shopifyNew", value: email ? integer(Math.round(email.shopify.newCustomers)) : "…" },
    { key: "clickRate", value: rate(s.clickRate) },
    { key: "cost", value: "—" },
  ];
  const rows = klaviyo.rows.filter((r) => r.kind === view);
  return (
    <>
      <div className={styles.tiles}>
        {tiles.map((tile) => (
          <div key={tile.key} className={styles.tile}>
            <span>
              {tr(`insights.mkt.klaviyo.tile.${tile.key}`)}
              <InfoTip text={tr(`insights.mkt.klaviyo.tip.${tile.key}`)} />
            </span>
            <strong>{tile.value}</strong>
          </div>
        ))}
      </div>
      <div className={styles.head}>
        <Segmented
          options={(["campaign", "flow", "forms"] as View[]).map((id) => ({ id, label: tr(`insights.mkt.klaviyo.view.${id}`) }))}
          value={view}
          onChange={setView}
          label={tr("insights.mkt.klaviyo.title")}
        />
      </div>
      {view === "forms" ? (
        <p className={t.pending}>{tr("insights.mkt.klaviyo.formsPending")}</p>
      ) : (
        <>
          <MessageTable rows={rows} kind={view} />
          <p className={styles.note}>
            {tr(`insights.mkt.klaviyo.note.${view}`)}
            {klaviyo.hiddenWithoutClicks + klaviyo.hiddenTooSmall > 0
              ? ` ${tr("insights.mkt.klaviyo.hidden", { n: klaviyo.hiddenWithoutClicks + klaviyo.hiddenTooSmall })}`
              : ""}
          </p>
        </>
      )}
    </>
  );
}

function MessageTable({ rows, kind }: { rows: KlaviyoMessageRow[]; kind: "campaign" | "flow" }) {
  const tr = useT();
  const locale = useLocale();
  const { euros, integer, percentOf } = useFormat();
  const dash = <span className={t.muted}>—</span>;
  const rate = (v: number | null) => (v === null ? dash : percentOf(v * 100, 1));
  const col = (id: string, sort: (r: KlaviyoMessageRow) => number | null, render: (r: KlaviyoMessageRow) => ReactNode): Column<KlaviyoMessageRow> => ({
    id,
    label: tr(`insights.mkt.klaviyo.col.${id}`),
    tip: tr(`insights.mkt.klaviyo.colTip.${id}`),
    numeric: true,
    sort,
    render,
  });
  const ctor = (r: KlaviyoMessageRow) => (r.opens > 0 ? r.clicks / r.opens : null);
  const aov = (r: KlaviyoMessageRow) => (r.conversions > 0 ? r.revenue / r.conversions : null);
  const columns: Column<KlaviyoMessageRow>[] = [
    {
      id: "name",
      label: tr("insights.mkt.klaviyo.col.name"),
      sort: (r) => r.name ?? "",
      render: (r) => (
        <>
          {r.name ?? <span className={t.muted}>{tr(kind === "flow" ? "insights.marketing.unnamedFlow" : "insights.marketing.unnamedCampaign")}</span>}
          {kind === "campaign" && r.sentAt ? <span className={t.sub}>{formatDayL(new Date(`${r.sentAt.slice(0, 10)}T00:00:00Z`), locale)}</span> : null}
        </>
      ),
    },
    ...(kind === "campaign" ? [col("sent", (r) => (r.sentAt ? Date.parse(r.sentAt) : null), (r) => (r.sentAt ? r.sentAt.slice(0, 10) : dash))] : []),
    col("recipients", (r) => r.recipients, (r) => integer(r.recipients)),
    col("openRate", (r) => r.openRate, (r) => rate(r.openRate)),
    col("clickRate", (r) => r.clickRate, (r) => rate(r.clickRate)),
    col("ctor", ctor, (r) => rate(ctor(r))),
    col("orderRate", (r) => r.conversionRate, (r) => (r.conversionRate === null ? dash : percentOf(r.conversionRate * 100, 2))),
    col("orders", (r) => r.conversions, (r) => integer(r.conversions)),
    col("revenue", (r) => r.revenue, (r) => euros(r.revenue)),
    col("rpr", (r) => r.revenuePerRecipient, (r) => (r.revenuePerRecipient === null ? dash : euros(r.revenuePerRecipient, { cents: true }))),
    col("aov", aov, (r) => (aov(r) === null ? dash : euros(aov(r), { cents: true }))),
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => `${r.kind}:${r.id}`}
      initialSort={{ id: "revenue", desc: true }}
      search={(r) => r.name ?? ""}
      limit={15}
      caption={tr(`insights.mkt.klaviyo.view.${kind}`)}
      empty={tr("insights.marketing.noKlaviyoRow")}
    />
  );
}
