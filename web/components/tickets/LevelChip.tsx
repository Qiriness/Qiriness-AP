import type { TicketLevel } from "@/lib/types";
import { TICKET_LEVEL_MEANINGS } from "@/lib/types";
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
  if (level === null) {
    return (
      <span className={`${styles.chip} ${styles.none}`} title="Not categorised yet">
        Uncategorised
      </span>
    );
  }

  return (
    <span
      className={`${styles.chip} ${styles[`level${level}`]}`}
      title={`Level ${level} — ${TICKET_LEVEL_MEANINGS[level]}`}
    >
      L{level}
      <span className={styles.meaning}>{TICKET_LEVEL_MEANINGS[level]}</span>
    </span>
  );
}
