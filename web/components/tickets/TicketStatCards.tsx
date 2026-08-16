import type { TicketStats } from "@/lib/types";
import styles from "./TicketStatCards.module.css";

interface TicketStatCardsProps {
  stats: TicketStats;
}

/**
 * The four header figures, each with the denominator it should be read
 * against — a bare "172" says nothing without "of 565".
 *
 * THE FIRST THREE READ AGAINST THE LIVE SET, and say so: "of N open" rather
 * than the old "of N categorised". Categorised was the honest denominator while
 * "high priority" meant level 3 + 4 and an uncategorised ticket had no level to
 * be counted by. The red band is scored for every ticket, uncategorised ones
 * included (they carry their own weight for being unread), so the set it should
 * be read against is simply everything still open.
 */
export function TicketStatCards({ stats }: TicketStatCardsProps) {
  return (
    <ul className={styles.grid}>
      <li className={`${styles.card} ${styles.open}`}>
        <span className={styles.label}>Open tickets</span>
        <span className={styles.figure}>
          {stats.open.toLocaleString()}
          <span className={styles.of}>of {stats.total.toLocaleString()}</span>
        </span>
        <span className={styles.foot}>Not yet resolved or closed</span>
      </li>

      <li className={`${styles.card} ${styles.high}`}>
        <span className={styles.label}>High priority</span>
        <span className={styles.figure}>
          {stats.highPriority.toLocaleString()}
          <span className={styles.of}>of {stats.open.toLocaleString()} open</span>
        </span>
        {/* Names the threshold rather than the colour: the bar is the cue in the
            table, and a card that says "the red ones" is useless to anyone who
            cannot separate the two warm bands. */}
        <span className={styles.foot}>Priority score 70 and above</span>
      </li>

      <li className={`${styles.card} ${styles.level3}`}>
        <span className={styles.label}>Level 3</span>
        <span className={styles.figure}>
          {stats.levelThree.toLocaleString()}
          <span className={styles.of}>of {stats.open.toLocaleString()} open</span>
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
