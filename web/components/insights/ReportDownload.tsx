"use client";

import { useState } from "react";
import styles from "./OverviewView.module.css";

/**
 * Pick a month and download its sales report — the same HTML file that will
 * be emailed to the CEOs at the start of each month. A plain link, so the
 * browser handles the download and nothing is built until it is asked for.
 */
export function ReportDownload({
  months,
  initial,
}: {
  months: { id: string; label: string }[];
  initial: string;
}) {
  const [month, setMonth] = useState(months.some((m) => m.id === initial) ? initial : months[0]?.id ?? "");
  if (months.length === 0) return <p className={styles.muted}>No month has ended since the first synced order.</p>;
  return (
    <div className={styles.report}>
      <label className={styles.reportLabel}>
        <span>Month</span>
        <select className={styles.reportSelect} value={month} onChange={(event) => setMonth(event.target.value)}>
          {months.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <a className={styles.reportButton} href={`/api/insights/report?month=${month}`} download>
        Download report (HTML)
      </a>
    </div>
  );
}
