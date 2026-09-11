"use client";

import { useEffect, useState } from "react";
import type { InsightsRange, InsightsScope, PlatformId } from "@/lib/types";
import { PLATFORMS, RANGE_PRESETS } from "../../../scripts/lib/insights-range.mjs";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

/**
 * The one row of filters above every panel: range first, then platform, then a
 * custom from/to on the browser's own date picker.
 *
 * The date inputs always show the dates the current range resolves to, so
 * picking a preset and reading "13/08/2026 – 11/09/2026" beside it are the same
 * fact. Editing either date switches to a custom range.
 *
 * A filter that does not apply to a panel is shown disabled, with the reason as
 * its tooltip, rather than hidden: a control that vanishes between tabs reads as
 * a bug, and one that silently does nothing reads as broken data.
 */
export function FilterBar({
  range,
  platform,
  scope,
}: {
  range: InsightsRange;
  platform: PlatformId;
  scope: InsightsScope;
}) {
  const { navigate, pending } = useInsightsFrame();
  const fromDay = range.from.slice(0, 10);
  const today = range.now.slice(0, 10);
  // A month or week bucket ends after today; the box shows the data's real end.
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

  const rangeTitle = scope.range ? undefined : scope.rangeReason ?? "This panel is a snapshot as of the last sync";
  const platformTitle = scope.platform ? undefined : scope.platformReason ?? "Tickets are not tied to a sales platform";

  return (
    <div className={styles.filters} data-pending={pending || undefined}>
      <div className={styles.presets} role="group" aria-label="Date range" title={rangeTitle}>
        {RANGE_PRESETS.map((preset) => {
          const active = scope.range && range.preset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={`${styles.preset} ${active ? styles.presetActive : ""}`}
              aria-pressed={active}
              disabled={!scope.range}
              onClick={() => navigate({ range: preset.id, from: null, to: null })}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className={styles.filterRight}>
        <label className={styles.selectWrap} title={platformTitle}>
          <span className={styles.srOnly}>Platform</span>
          <select
            className={styles.select}
            value={scope.platform ? platform : "all"}
            disabled={!scope.platform}
            onChange={(event) => navigate({ platform: event.target.value === "all" ? null : event.target.value })}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.dates} title={rangeTitle}>
          <label>
            <span className={styles.srOnly}>From</span>
            <input
              type="date"
              className={styles.date}
              value={from}
              max={to || today}
              disabled={!scope.range}
              onChange={(event) => {
                setFrom(event.target.value);
                applyDates(event.target.value, to);
              }}
            />
          </label>
          <span className={styles.dateSep}>to</span>
          <label>
            <span className={styles.srOnly}>To</span>
            <input
              type="date"
              className={styles.date}
              value={to}
              min={from}
              max={today}
              disabled={!scope.range}
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
