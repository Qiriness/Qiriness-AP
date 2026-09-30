"use client";

import { useEffect, useState } from "react";
import type { InsightsRange, InsightsScope, PlatformId } from "@/lib/types";
import { PLATFORMS, RANGE_PRESETS } from "../../../scripts/lib/insights-range.mjs";
import { useT } from "@/lib/i18n/client";
import { useInsightsFrame } from "./InsightsFrame";
import styles from "./InsightsHeader.module.css";

/**
 * The one row of filters above every panel: range first, then a calendar month,
 * then platform, then a custom from/to on the browser's own date picker.
 *
 * THE FOUR WAYS TO PICK A PERIOD ARE ONE CHOICE. A preset, a month and a
 * custom from/to each clear the other two in the URL, so the address never
 * holds two answers and the bar never shows two selections.
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
  months,
}: {
  range: InsightsRange;
  platform: PlatformId;
  scope: InsightsScope;
  /** The months the picker offers, newest first (`monthOptions`). */
  months: { id: string; label: string }[];
}) {
  const t = useT();
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
    navigate({ range: null, month: null, from: nextFrom, to: nextTo });
  };

  const rangeTitle = scope.range ? undefined : t(scope.rangeReason ?? "insights.filter.snapshotReason");
  const platformTitle = scope.platform ? undefined : t(scope.platformReason ?? "insights.filter.noPlatformReason");

  return (
    <div className={styles.filters} data-pending={pending || undefined}>
      <div className={styles.presets} role="group" aria-label={t("insights.filter.dateRange")} title={rangeTitle}>
        {RANGE_PRESETS.map((preset) => {
          const active = scope.range && range.preset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={`${styles.preset} ${active ? styles.presetActive : ""}`}
              aria-pressed={active}
              disabled={!scope.range}
              onClick={() => navigate({ range: preset.id, month: null, from: null, to: null })}
            >
              {t(`insights.range.preset.${preset.id}`)}
            </button>
          );
        })}
      </div>

      <div className={styles.filterRight}>
        <label className={styles.selectWrap} title={rangeTitle}>
          <span className={styles.srOnly}>{t("insights.filter.month")}</span>
          <select
            className={styles.select}
            value={scope.range && range.preset === "month" ? range.query.month ?? "" : ""}
            disabled={!scope.range}
            onChange={(event) =>
              navigate({ month: event.target.value || null, range: null, from: null, to: null })
            }
          >
            <option value="">{t("insights.filter.monthPlaceholder")}</option>
            {months.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectWrap} title={platformTitle}>
          <span className={styles.srOnly}>{t("insights.filter.platform")}</span>
          <select
            className={styles.select}
            value={scope.platform ? platform : "all"}
            disabled={!scope.platform}
            onChange={(event) => navigate({ platform: event.target.value === "all" ? null : event.target.value })}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === "all" ? t("insights.filter.allPlatforms") : p.label}
              </option>
            ))}
          </select>
        </label>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.dates} title={rangeTitle}>
          <label>
            <span className={styles.srOnly}>{t("insights.filter.from")}</span>
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
          <span className={styles.dateSep}>{t("insights.filter.to")}</span>
          <label>
            <span className={styles.srOnly}>{t("insights.filter.toLabel")}</span>
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
