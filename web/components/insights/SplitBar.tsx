import type { ReactNode } from "react";
import styles from "./SplitBar.module.css";

export interface SplitPart {
  key: string;
  label: string;
  value: number;
  /** A categorical slot (`var(--chart-1)`…) — fixed per entity, never by rank. */
  color: string;
  display?: ReactNode;
}

/**
 * A whole split into parts, as the reference dashboard draws "Répartition CA":
 * one row per part — label, share and value — each over its own bar, so the
 * parts read as a list and not as a single stacked bar nobody can compare.
 *
 * The colour is a line-key beside the label; the text itself stays in ink.
 */
export function SplitBar({ parts, total }: { parts: SplitPart[]; total: number }) {
  return (
    <ul className={styles.list}>
      {parts.map((part) => {
        const share = total > 0 ? part.value / total : 0;
        return (
          <li key={part.key} className={styles.row}>
            <div className={styles.head}>
              <span className={styles.label}>
                <span className={styles.key} style={{ background: part.color }} aria-hidden="true" />
                {part.label}
              </span>
              <span className={styles.figures}>
                <span className={styles.share}>{total > 0 ? `${(share * 100).toFixed(1)}%` : "—"}</span>
                <span className={styles.value}>{part.display ?? part.value.toLocaleString("en-GB")}</span>
              </span>
            </div>
            <span className={styles.track}>
              <span className={styles.fill} style={{ width: `${(share * 100).toFixed(2)}%`, background: part.color }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
