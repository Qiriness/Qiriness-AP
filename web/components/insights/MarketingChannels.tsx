"use client";

import { useState } from "react";
import type { KlaviyoMessageRow, KlaviyoPerformance } from "@/lib/types";
import { euros } from "@/lib/insights-format";
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
const SOURCES: Record<Source, { label: string; summary: string[]; head: string[]; reason: string }> = {
  email: {
    label: "Klaviyo",
    summary: ["Open rate", "Click rate", "Recipients", "Revenue"],
    head: ["Flow / campaign", "Open rate", "Click rate", "Recipients", "Revenue"],
    reason: "Needs the Klaviyo integration — flows and campaigns are not read yet.",
  },
  paid: {
    label: "Paid",
    summary: ["Spend", "Revenue", "ROAS", "CAC"],
    head: ["Platform", "Spend", "Revenue", "ROAS", "CPA"],
    reason: "Needs Google Ads and Meta Ads — spend is not read yet.",
  },
  social: {
    label: "Social",
    summary: ["Reach", "Engagement", "Link clicks", "Revenue"],
    head: ["Platform", "Reach", "Engagement", "Clicks", "Revenue"],
    reason: "Needs Instagram and TikTok insights — not read yet.",
  },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `3 Sep 2026`, built by hand so server and browser print the same characters. */
function day(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function rate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function MarketingChannels({ klaviyo }: { klaviyo: KlaviyoPerformance }) {
  const [source, setSource] = useState<Source>("email");
  const current = SOURCES[source];
  const live = source === "email" && !klaviyo.blockedReason && klaviyo.summary;
  return (
    <>
      <div className={styles.tabs}>
        <Segmented
          options={(Object.keys(SOURCES) as Source[]).map((id) => ({ id, label: SOURCES[id].label }))}
          value={source}
          onChange={setSource}
          label="Marketing source"
        />
      </div>
      {live ? (
        <KlaviyoTable klaviyo={klaviyo} />
      ) : (
        <Pending current={current} reason={source === "email" && klaviyo.blockedReason ? klaviyo.blockedReason : current.reason} />
      )}
    </>
  );
}

function KlaviyoTable({ klaviyo }: { klaviyo: KlaviyoPerformance }) {
  const s = klaviyo.summary!;
  const tiles = [
    { label: "Open rate", value: rate(s.openRate) },
    { label: "Click rate", value: rate(s.clickRate) },
    { label: "Recipients", value: s.recipients.toLocaleString("en-GB") },
    { label: "Revenue", value: euros(s.revenue) },
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
          <caption className={t.srOnly}>Klaviyo flows and campaigns with at least one click in the range, by open rate</caption>
          <thead>
            <tr>
              {SOURCES.email.head.map((h, i) => (
                <th key={h} scope="col" className={i ? t.n : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {klaviyo.rows.length === 0 ? (
              <tr>
                <td colSpan={SOURCES.email.head.length} className={t.muted}>
                  No flow or campaign with 50 or more recipients was clicked in this range.
                </td>
              </tr>
            ) : (
              klaviyo.rows.map((row) => <KlaviyoRow key={`${row.kind}:${row.id}`} row={row} />)
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        Open and click rates are unique opens and clicks over delivered, as Klaviyo counts them — Apple Mail Privacy Protection counts some opens that were not read. Revenue is Klaviyo&apos;s attribution on Placed Order. Flows sum the days in the range; a campaign counts in the range it was sent.
        {hiddenNote(klaviyo)}
        {klaviyo.lastSyncAt ? ` Synced ${day(klaviyo.lastSyncAt)}.` : ""}
      </p>
    </>
  );
}

/** Which sends the tiles count but the table leaves out, and why. */
function hiddenNote(klaviyo: KlaviyoPerformance): string {
  const parts = [
    klaviyo.hiddenWithoutClicks > 0 ? `${klaviyo.hiddenWithoutClicks} with no click` : null,
    klaviyo.hiddenTooSmall > 0 ? `${klaviyo.hiddenTooSmall} sent to fewer than 50 people` : null,
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" and ")} are counted above but not listed.` : "";
}

function KlaviyoRow({ row }: { row: KlaviyoMessageRow }) {
  return (
    <tr>
      <th scope="row">
        {row.name ?? <span className={t.muted}>Unnamed {row.kind}</span>}
        <span className={t.sub}>
          {row.kind === "flow" ? "Flow" : `Campaign${row.sentAt ? ` · ${day(row.sentAt)}` : ""}`} ·{" "}
          {row.clicks.toLocaleString("en-GB")} clicks
        </span>
      </th>
      <td className={t.n}>{rate(row.openRate)}</td>
      <td className={t.n}>{rate(row.clickRate)}</td>
      <td className={t.n}>{row.recipients.toLocaleString("en-GB")}</td>
      <td className={t.n}>{euros(row.revenue)}</td>
    </tr>
  );
}

function Pending({ current, reason }: { current: (typeof SOURCES)[Source]; reason: string }) {
  return (
    <>
      <div className={styles.summary}>
        {current.summary.map((label) => (
          <div key={label} className={styles.summaryTile}>
            <span>{label}</span>
            <strong aria-label={`${label}: not measured yet`}>—</strong>
          </div>
        ))}
      </div>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              {current.head.map((h, i) => (
                <th key={h} scope="col" className={i ? t.n : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={current.head.length} className={t.pending}>
                {reason}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
