"use client";

import { useState } from "react";
import type { KlaviyoMessageRow, KlaviyoPerformance } from "@/lib/types";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/locales";
import { formatDayL } from "@/lib/insights-labels";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./MarketingView.module.css";

type Source = "email" | "paid" | "social";

/**
 * Klaviyo, paid and social. Klaviyo is read (the nightly sync, through
 * insights_klaviyo_messages); paid and social are laid out as they will be once
 * connected: the summary tiles and the table's columns are the agreed shape,
 * the cells are dashes, and the reason says which integration fills them.
 */
// Words: `insights.marketing.source.<id>.label|reason` and `.summary.<n>` / `.head.<n>`.
const SOURCES: Record<Source, { summary: number; head: number }> = {
  email: { summary: 4, head: 5 },
  paid: { summary: 4, head: 5 },
  social: { summary: 4, head: 5 },
};
const SOURCE_IDS = Object.keys(SOURCES) as Source[];

/** `3 Sep 2026` / `3 sept. 2026`. */
function day(iso: string, locale: Locale): string {
  return formatDayL(new Date(`${iso.slice(0, 10)}T00:00:00Z`), locale);
}

export function MarketingChannels({ klaviyo }: { klaviyo: KlaviyoPerformance }) {
  const tr = useT();
  const [source, setSource] = useState<Source>("email");
  const live = source === "email" && !klaviyo.blockedReason && klaviyo.summary;
  return (
    <>
      <div className={styles.tabs}>
        <Segmented
          options={SOURCE_IDS.map((id) => ({ id, label: tr(`insights.marketing.source.${id}.label`) }))}
          value={source}
          onChange={setSource}
          label={tr("insights.marketing.sourceLabel")}
        />
      </div>
      {live ? (
        <KlaviyoTable klaviyo={klaviyo} />
      ) : (
        <Pending source={source} reason={source === "email" && klaviyo.blockedReason ? tr(klaviyo.blockedReason) : tr(`insights.marketing.source.${source}.reason`)} />
      )}
    </>
  );
}

function KlaviyoTable({ klaviyo }: { klaviyo: KlaviyoPerformance }) {
  const tr = useT();
  const locale = useLocale();
  const { euros, integer, percentOf } = useFormat();
  const rate = (value: number | null) => (value === null ? "—" : percentOf(value * 100, 1));
  const s = klaviyo.summary!;
  const heads = [1, 2, 3, 4, 5].map((n) => tr(`insights.marketing.source.email.head.${n}`));
  const tiles = [
    { label: tr("insights.marketing.source.email.summary.1"), value: rate(s.openRate) },
    { label: tr("insights.marketing.source.email.summary.2"), value: rate(s.clickRate) },
    { label: tr("insights.marketing.source.email.summary.3"), value: integer(s.recipients) },
    { label: tr("insights.marketing.source.email.summary.4"), value: euros(s.revenue) },
  ];
  return (
    <>
      <div className={styles.summary}>
        {tiles.map((tile) => (
          <div key={tile.label} className={styles.summaryTile}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </div>
        ))}
      </div>
      <div className={`${t.wrap} ${styles.scroll}`}>
        <table className={t.table}>
          <caption className={t.srOnly}>{tr("insights.marketing.klaviyoCaption")}</caption>
          <thead>
            <tr>
              {heads.map((h, i) => (
                <th key={h} scope="col" className={i ? t.n : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {klaviyo.rows.length === 0 ? (
              <tr>
                <td colSpan={heads.length} className={t.muted}>
                  {tr("insights.marketing.noKlaviyoRow")}
                </td>
              </tr>
            ) : (
              klaviyo.rows.map((row) => <KlaviyoRow key={`${row.kind}:${row.id}`} row={row} rate={rate} />)
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        {tr("insights.marketing.klaviyoNote")}
        {hiddenNote(klaviyo, tr)}
        {klaviyo.lastSyncAt ? ` ${tr("insights.marketing.synced", { date: day(klaviyo.lastSyncAt, locale) })}` : ""}
      </p>
    </>
  );
}

/** Which sends the tiles count but the table leaves out, and why. */
function hiddenNote(klaviyo: KlaviyoPerformance, tr: (key: string, params?: Record<string, string | number>) => string): string {
  const parts = [
    klaviyo.hiddenWithoutClicks > 0 ? tr("insights.marketing.hiddenNoClick", { n: klaviyo.hiddenWithoutClicks }) : null,
    klaviyo.hiddenTooSmall > 0 ? tr("insights.marketing.hiddenSmall", { n: klaviyo.hiddenTooSmall }) : null,
  ].filter(Boolean);
  return parts.length ? ` ${tr("insights.marketing.hiddenCounted", { parts: parts.join(tr("insights.marketing.and")) })}` : "";
}

function KlaviyoRow({ row, rate }: { row: KlaviyoMessageRow; rate: (value: number | null) => string }) {
  const tr = useT();
  const locale = useLocale();
  const { euros, integer } = useFormat();
  return (
    <tr>
      <th scope="row">
        {row.name ?? <span className={t.muted}>{tr(row.kind === "flow" ? "insights.marketing.unnamedFlow" : "insights.marketing.unnamedCampaign")}</span>}
        <span className={t.sub}>
          {row.kind === "flow" ? tr("insights.marketing.flow") : `${tr("insights.marketing.campaign")}${row.sentAt ? ` · ${day(row.sentAt, locale)}` : ""}`} ·{" "}
          {tr("insights.marketing.clicksN", { count: row.clicks, n: integer(row.clicks) })}
        </span>
      </th>
      <td className={t.n}>{rate(row.openRate)}</td>
      <td className={t.n}>{rate(row.clickRate)}</td>
      <td className={t.n}>{integer(row.recipients)}</td>
      <td className={t.n}>{euros(row.revenue)}</td>
    </tr>
  );
}

function Pending({ source, reason }: { source: Source; reason: string }) {
  const tr = useT();
  const summary = Array.from({ length: SOURCES[source].summary }, (_, i) => tr(`insights.marketing.source.${source}.summary.${i + 1}`));
  const head = Array.from({ length: SOURCES[source].head }, (_, i) => tr(`insights.marketing.source.${source}.head.${i + 1}`));
  return (
    <>
      <div className={styles.summary}>
        {summary.map((label) => (
          <div key={label} className={styles.summaryTile}>
            <span>{label}</span>
            <strong aria-label={tr("insights.fulfilment.outcomeNotMeasured", { label })}>—</strong>
          </div>
        ))}
      </div>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={i ? t.n : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={head.length} className={t.pending}>
                {reason}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
