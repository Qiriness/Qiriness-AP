"use client";

import { useEffect, useState } from "react";
import type { InsightsRange } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
import { useInsightsFrame } from "@/components/insights/InsightsFrame";
import styles from "@/components/insights/InsightsHeader.module.css";

/**
 * The dashboard's period: 7, 30 or 90 days, or a custom from/to. The URL is
 * the state, as on Insights: a preset and a custom range each clear the other,
 * and the date boxes always show what the current range resolves to.
 */
export function AgentFilters({ range, presets }: { range: InsightsRange; presets: readonly string[] }) {
  const t = useT();
  const { navigate, prefetch, pending } = useInsightsFrame();
  const fromDay = range.from.slice(0, 10);
  const today = range.now.slice(0, 10);
  const toDay = lastDay(range.to) > today ? today : lastDay(range.to);
  const [from, setFrom] = useState(fromDay);
  const [to, setTo] = useState(toDay);
  useEffect(() => {
    setFrom(fromDay);
    setTo(toDay);
  }, [fromDay, toDay]);

  const applyDates = (nextFrom: string, nextTo: string) => {
    if (!nextFrom || !nextTo || nextFrom > nextTo) return;
    navigate({ range: null, from: nextFrom, to: nextTo });
  };

  return (
    <div className={styles.filters} data-pending={pending || undefined}>
      <div className={styles.presets} role="group" aria-label={t("insights.filter.dateRange")}>
        {presets.map((id) => {
          const active = range.preset === id;
          const patch = { range: id, from: null, to: null };
          return (
            <button
              key={id}
              type="button"
              className={`${styles.preset} ${active ? styles.presetActive : ""}`}
              aria-pressed={active}
              onPointerEnter={active ? undefined : () => prefetch(patch)}
              onFocus={active ? undefined : () => prefetch(patch)}
              onClick={() => navigate(patch)}
            >
              {t(`insights.range.preset.${id}`)}
            </button>
          );
        })}
      </div>
      <div className={styles.filterRight}>
        <div className={styles.dates}>
          <label>
            <span className={styles.srOnly}>{t("insights.filter.from")}</span>
            <input
              type="date"
              className={styles.date}
              value={from}
              max={to || today}
              onChange={(event) => {
                setFrom(event.target.value);
                applyDates(event.target.value, to);
              }}
            />
          </label>
          <span className={styles.dateSep}>{t("insights.filter.to")}</span>
          <label>
            <span className={styles.srOnly}>{t("insights.filter.toLabel")}</span>
            <input
              type="date"
              className={styles.date}
              value={to}
              min={from}
              max={today}
              onChange={(event) => {
                setTo(event.target.value);
                applyDates(from, event.target.value);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

/** `to` is exclusive; the date input shows the last day inside the range. */
function lastDay(toKey: string): string {
  const d = new Date(`${toKey.slice(0, 19)}Z`);
  d.setUTCSeconds(d.getUTCSeconds() - 1);
  return d.toISOString().slice(0, 10);
}
