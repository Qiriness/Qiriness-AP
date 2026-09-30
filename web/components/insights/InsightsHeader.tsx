import type { Freshness, InsightsPanel, InsightsRange, InsightsScope, PlatformId } from "@/lib/types";
import { getT } from "@/lib/i18n/server";
import { freshnessLine } from "@/lib/insights-labels";
import { FilterBar } from "./FilterBar";
import { InsightsNav } from "./InsightsNav";
import { LiveRefresh } from "./LiveRefresh";
import styles from "./InsightsHeader.module.css";

/**
 * Title, panel tabs, the filter row, and the line that says how current the
 * sources are. Server-rendered; the interactive pieces are client islands.
 */
export function InsightsHeader({
  active,
  panels,
  scope,
  range,
  platform,
  freshness,
  renderedAt,
  tzFallback,
  months,
}: {
  active: InsightsPanel;
  /** The panels this reader's role may open, and so the only tabs drawn. */
  panels: InsightsPanel[];
  scope: InsightsScope;
  range: InsightsRange | null;
  platform: PlatformId;
  freshness: Freshness | null;
  renderedAt: string | null;
  tzFallback: boolean;
  /** What the month picker offers. */
  months: { id: string; label: string }[];
}) {
  const t = getT();
  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{t("nav.insights")}</h1>
        {renderedAt ? <LiveRefresh renderedAt={renderedAt} /> : null}
      </div>
      <InsightsNav active={active} panels={panels} />
      {range ? <FilterBar range={range} platform={platform} scope={scope} months={months} /> : null}
      {freshness && freshness.items.length > 0 ? (
        <ul className={styles.freshness} aria-label={t("insights.shell.freshnessLabel")}>
          {freshness.items.map((item) => {
            const line = freshnessLine(item, t);
            return (
              <li
                key={item.id}
                className={`${styles.fresh} ${styles[`fresh_${item.tone}`]}`}
                title={item.at ? new Date(item.at).toUTCString() : undefined}
              >
                <span className={styles.freshDot} aria-hidden="true" />
                <strong>{line.label}</strong> {line.text}
              </li>
            );
          })}
          {tzFallback ? (
            <li className={`${styles.fresh} ${styles.fresh_info}`}>
              <span className={styles.freshDot} aria-hidden="true" />
              <strong>{t("insights.shell.days")}</strong> {t("insights.shell.utcNote")}
            </li>
          ) : null}
        </ul>
      ) : null}
    </header>
  );
}
