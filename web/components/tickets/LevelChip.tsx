"use client";

import { useT } from "@/lib/i18n/client";
import type { TicketLevel } from "@/lib/types";
import styles from "./LevelChip.module.css";

interface LevelChipProps {
  level: TicketLevel | null;
}

/**
 * Severity pill. Colour climbs 1 -> 4 (neutral, blue, amber, red) so a queue
 * scans by shape as well as by number, and carries the meaning as a title so
 * "Level 3" is not the only thing an operator has to go on.
 *
 * A null level is its own state, not a zero: it means the categoriser has not
 * reached this ticket yet, which is a different thing from "low severity".
 */
export function LevelChip({ level }: LevelChipProps) {
  const t = useT();
  if (level === null) {
    return (
      <span className={`${styles.chip} ${styles.none}`} title={t("tickets.dialogs.level.notCategorised")}>
        {t("tickets.panels.uncategorised")}
      </span>
    );
  }

  return (
    <span
      className={`${styles.chip} ${styles[`level${level}`]}`}
      title={`${t(`level.${level}`)} — ${t(`levelMeaning.${level}`)}`}
    >
      L{level}
      <span className={styles.meaning}>{t(`levelMeaning.${level}`)}</span>
    </span>
  );
}
