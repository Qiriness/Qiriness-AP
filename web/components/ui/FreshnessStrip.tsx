import type { FreshnessItem } from "@/lib/types";
import { getT } from "@/lib/i18n/server";
import { freshnessLine } from "@/lib/insights-labels";
import styles from "./FreshnessStrip.module.css";

/**
 * How current each source is — Orders synced, last Email, Nightly sync — as a
 * row of pills. One component for every page that shows it (Insights, Tickets),
 * so a stale sync reads the same wherever someone is looking.
 *
 * Server-rendered: the items come from `insights_freshness` through
 * `describeFreshness`, and the words from the dictionary.
 */
export function FreshnessStrip({
  items,
  tzFallback = false,
  className,
}: {
  items: FreshnessItem[];
  /** Insights only: the shop has no timezone yet, so days are cut in UTC. */
  tzFallback?: boolean;
  className?: string;
}) {
  const t = getT();
  if (items.length === 0 && !tzFallback) return null;
  return (
    <ul className={`${styles.freshness} ${className ?? ""}`} aria-label={t("insights.shell.freshnessLabel")}>
      {items.map((item) => {
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
  );
}
