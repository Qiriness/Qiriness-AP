import type { ReactNode } from "react";
import styles from "./InsightsKit.module.css";

/**
 * The pieces every panel is built from.
 *
 * One file rather than six, because each of these is a dozen lines and they are
 * only ever used together — splitting them would be six imports at the top of
 * every panel to save nothing. They are presentational and server-renderable:
 * no state, no effects, no "use client".
 *
 * THE HOUSE RULE THEY ENCODE: a figure that could not be measured renders as an
 * em dash with a reason beside it, never as 0. On a dashboard, zero is a claim
 * — "nothing was late", "nobody complained" — and making an absent measurement
 * look like one is the fastest way to lose trust in the whole screen.
 */

// --- section --------------------------------------------------------------

export function PanelSection({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitles}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {subtitle ? <p className={styles.sectionSub}>{subtitle}</p> : null}
        </div>
        {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

// --- tiles ----------------------------------------------------------------

export type TileTone = "neutral" | "good" | "warn" | "bad" | "blocked";

export function TileGrid({ children }: { children: ReactNode }) {
  return <ul className={styles.tileGrid}>{children}</ul>;
}

/**
 * One headline figure.
 *
 * `value` is already formatted by the caller — the service knows whether a
 * number is hours, euros or a count, and a tile that reformats it would be a
 * second place for the unit to be wrong.
 */
export function StatTile({
  label,
  value,
  of,
  foot,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  of?: ReactNode;
  foot?: ReactNode;
  tone?: TileTone;
}) {
  return (
    <li className={`${styles.tile} ${styles[tone]}`}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileFigure}>
        {value}
        {of ? <span className={styles.tileOf}>{of}</span> : null}
      </span>
      {foot ? <span className={styles.tileFoot}>{foot}</span> : null}
    </li>
  );
}

/**
 * A tile for a metric that cannot be computed yet.
 *
 * Deliberately a different component from a zero-valued `StatTile`: the reason
 * is required, so a blocked metric can never ship without saying what is
 * missing.
 */
export function BlockedTile({ label, reason }: { label: string; reason: string }) {
  return (
    <li className={`${styles.tile} ${styles.blocked}`}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileFigure}>
        <span className={styles.dash} aria-hidden="true">
          —
        </span>
        <span className={styles.srOnly}>Not measurable</span>
      </span>
      <span className={styles.tileFoot}>{reason}</span>
    </li>
  );
}

// --- bars -----------------------------------------------------------------

export interface BarDatum {
  key: string;
  label: string;
  value: number | null;
  /** Rendered at the end of the row; the caller owns the unit. */
  display?: string;
  /** Draws attention without a second colour scale — used for "past the line". */
  emphasis?: boolean;
  /** No data, as opposed to a measured zero. Renders hatched. */
  missing?: boolean;
  title?: string;
}

/**
 * A horizontal bar list — the workhorse of these panels.
 *
 * Scaled against `max` across the whole list rather than per row, because the
 * comparison between rows is the entire point. A missing row is hatched at full
 * width instead of drawn at zero: an empty bar and a bar that was never
 * measured are the same picture otherwise.
 */
export function BarList({ data, ariaLabel }: { data: BarDatum[]; ariaLabel: string }) {
  const max = Math.max(1, ...data.map((d) => (d.missing ? 0 : d.value ?? 0)));

  return (
    <ul className={styles.bars} aria-label={ariaLabel}>
      {data.map((d) => (
        <li key={d.key} className={styles.barRow} title={d.title}>
          <span className={styles.barKey}>{d.label}</span>
          <span className={styles.barTrack}>
            <span
              className={`${styles.barFill} ${d.emphasis ? styles.barEmphasis : ""} ${
                d.missing ? styles.barMissing : ""
              }`}
              style={{ width: d.missing ? "100%" : `${(((d.value ?? 0) / max) * 100).toFixed(1)}%` }}
            />
          </span>
          <span className={`${styles.barValue} ${d.missing ? styles.barValueDim : ""}`}>
            {d.missing ? "no data" : d.display ?? (d.value ?? 0).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- notes ----------------------------------------------------------------

export function Note({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.note} ${tone === "warn" ? styles.noteWarn : ""}`}>
      <span className={styles.noteTitle}>{title}</span>
      <p className={styles.noteBody}>{children}</p>
    </div>
  );
}

export function PanelError({ message }: { message: string }) {
  return (
    <div className={`${styles.note} ${styles.noteWarn}`} role="alert">
      <span className={styles.noteTitle}>This panel could not load</span>
      <p className={styles.noteBody}>{message}</p>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

// --- formatting -----------------------------------------------------------
// Shared so two panels cannot render the same quantity two ways.

/** An hours figure, at the precision the number deserves. */
export function hours(value: number | null): string {
  if (value === null) return "—";
  if (value >= 100) return `${Math.round(value)}h`;
  return `${value.toFixed(1)}h`;
}

export function percent(part: number, whole: number, digits = 1): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function euros(value: number): string {
  return value.toLocaleString("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

/**
 * A dollar figure that stays honest at both ends: agent spend is currently
 * fractions of a cent per call and could be hundreds of dollars a month later,
 * and `$0.00` for a real cost is the same lie as a zero on a tile.
 */
export function usd(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function compactNumber(value: number): string {
  return value.toLocaleString("en-GB", { notation: value >= 10_000 ? "compact" : "standard" });
}
