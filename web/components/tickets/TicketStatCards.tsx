import type { TicketStats } from "@/lib/types";
import styles from "./TicketStatCards.module.css";

interface TicketStatCardsProps {
  stats: TicketStats;
}

/**
 * The four header figures, each with the denominator it should be read
 * against — a bare "172" says nothing without "of 565".
 *
 * "High priority" is level 3 + 4, not the `priority` column: nothing writes
 * priority today, so every ticket sits at its default and the card would read
 * zero for ever. This is a deliberate stand-in until priority is populated —
 * see TicketStats.
 */
export function TicketStatCards({ stats }: TicketStatCardsProps) {
  const categorised = stats.total - stats.uncategorised;

  return (
    <ul className={styles.grid}>
      <li className={`${styles.card} ${styles.open}`}>
        <span className={styles.label}>Open tickets</span>
        <span className={styles.figure}>
          {stats.open.toLocaleString()}
          <span className={styles.of}>of {stats.total.toLocaleString()}</span>
        </span>
        <span className={styles.foot}>Awaiting a first resolution</span>
      </li>

      <li className={`${styles.card} ${styles.high}`}>
        <span className={styles.label}>High priority</span>
        <span className={styles.figure}>
          {stats.highPriority.toLocaleString()}
          <span className={styles.of}>of {categorised.toLocaleString()} categorised</span>
        </span>
        <span className={styles.foot}>Level 3 and 4</span>
      </li>

      <li className={`${styles.card} ${styles.level3}`}>
        <span className={styles.label}>Level 3</span>
        <span className={styles.figure}>
          {stats.levelThree.toLocaleString()}
          <span className={styles.of}>of {categorised.toLocaleString()} categorised</span>
        </span>
        <span className={styles.foot}>Needs a human</span>
      </li>

      {/* Both volume figures share one card: a rate is two numbers or it is
          not a rate. Rolling windows, so a day without a poll reads as idle
          rather than as a broken card. */}
      <li className={`${styles.card} ${styles.volume}`}>
        <span className={styles.label}>New tickets</span>
        <div className={styles.split}>
          <div className={styles.splitHalf}>
            <span className={styles.figure}>{stats.last24h.toLocaleString()}</span>
            <span className={styles.foot}>Last 24 hours</span>
          </div>
          <div className={styles.splitDivider} aria-hidden="true" />
          <div className={styles.splitHalf}>
            <span className={styles.figure}>{stats.last30d.toLocaleString()}</span>
            <span className={styles.foot}>Last 30 days</span>
          </div>
        </div>
      </li>
    </ul>
  );
}
