"use client";

import { useState } from "react";
import { Segmented } from "./Segmented";
import t from "./tables.module.css";
import styles from "./MarketingView.module.css";

type Source = "email" | "paid" | "social";

/**
 * Klaviyo, paid and social, laid out as they will be once connected: the
 * summary tiles and the table's columns are the agreed shape, the cells are
 * dashes, and the reason says which integration fills them. Nothing here is
 * read yet, so nothing here is a number.
 */
const SOURCES: Record<Source, { label: string; summary: string[]; head: string[]; reason: string }> = {
  email: {
    label: "Klaviyo",
    summary: ["Revenue", "Recipients", "Click rate", "Rev / recipient"],
    head: ["Flow / campaign", "Revenue", "Click", "Conversion", "Rev / recipient"],
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

export function MarketingChannels() {
  const [source, setSource] = useState<Source>("email");
  const current = SOURCES[source];
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
                {current.reason}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
