import type { ReactNode } from "react";
import { change } from "../../../scripts/lib/insights-range.mjs";
import { PinnableRow } from "./PinBoard";
import styles from "./InsightsKit.module.css";

/**
 * The pieces every panel is built from. Presentational and server-renderable:
 * no state, no effects, no "use client".
 *
 * THE HOUSE RULE THEY ENCODE: a figure that could not be measured renders as an
 * em dash with a reason beside it, never as 0. On a dashboard, zero is a claim
 * — "nothing was late", "nobody complained" — and making an absent measurement
 * look like one is the fastest way to lose trust in the whole screen.
 */

export { compactNumber, euros, formatValue, hours, percent, usd } from "@/lib/insights-format";

// --- layout ---------------------------------------------------------------

/**
 * A row of cards. With `pin` it carries a pin button in its rightmost card and
 * can be moved to the panel's Pinned section (PinBoard.tsx); `pin` is the row's
 * stable id within its panel, `label` names it for the button.
 */
export function Grid({
  children,
  min = 15,
  pin,
  label,
  columns,
}: {
  children: ReactNode;
  min?: number;
  pin?: string;
  label?: string;
  /**
   * A fixed column count instead of `min`-based reflow. `8` steps 8 -> 4 -> 2,
   * so a row of eight tiles halves as a block rather than dropping one tile at
   * a time and leaving a ragged last row.
   */
  columns?: 8;
}) {
  const style = columns
    ? undefined
    : { gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}rem), 1fr))` };
  const className = columns ? `${styles.grid} ${styles[`grid${columns}`]}` : styles.grid;
  if (pin) {
    return (
      <PinnableRow id={pin} label={label ?? pin} style={style} className={className}>
        {children}
      </PinnableRow>
    );
  }
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

/** A white card with a small heading — the unit every panel is laid out in. */
export function Card({
  title,
  aside,
  children,
  span,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  /** Columns to span in a `Grid` (desktop only; stacks on narrow screens). */
  span?: 2 | 3;
  className?: string;
}) {
  return (
    <section className={`${styles.card} ${span ? styles[`span${span}`] : ""} ${className ?? ""}`}>
      {title || aside ? (
        <header className={styles.cardHead}>
          {title ? <h2 className={styles.cardTitle}>{title}</h2> : <span />}
          {aside ? <div className={styles.cardAside}>{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

// --- figures --------------------------------------------------------------

/**
 * Whether a rise in this figure is good news. Colours the change chip:
 * direction x goodness, so "dispatch time up" is red and "revenue up" green.
 */
export type Polarity = "up" | "down" | "neutral";

/**
 * The change against the previous period.
 *
 * `points` renders a percentage-point difference rather than a relative change:
 * "late shipments 6% -> 9%" is +3 pts, and "+50%" would be true and useless.
 * A comparison that does not exist renders nothing rather than a dash, so the
 * tile never implies one was attempted.
 */
export function DeltaChip({
  current,
  previous,
  polarity,
  points = false,
  compareLabel,
}: {
  current: number | null;
  previous: number | null | undefined;
  polarity: Polarity;
  points?: boolean;
  compareLabel: string;
}) {
  if (current === null || previous === null || previous === undefined) return null;

  const diff = points ? current - previous : change(current, previous);
  if (diff === null || !Number.isFinite(diff)) return null;

  const flat = Math.abs(points ? diff : diff * 100) < 0.05;
  const up = diff > 0;
  const tone = flat || polarity === "neutral" ? "flat" : up === (polarity === "up") ? "good" : "bad";
  const text = points
    ? `${up ? "+" : ""}${diff.toFixed(1)} pts`
    : `${up ? "+" : ""}${(diff * 100).toFixed(1)}%`;

  return (
    <span className={styles.deltaRow}>
      <span className={`${styles.delta} ${styles[`delta_${tone}`]}`}>
        <span aria-hidden="true">{flat ? "→" : up ? "↑" : "↓"}</span>
        {text.replace(/^[+-]/, "")}
        <span className={styles.srOnly}>{up ? " up" : " down"}</span>
      </span>
      <span className={styles.deltaLabel}>vs {compareLabel}</span>
    </span>
  );
}

export interface SubMetric {
  label: string;
  value: ReactNode;
}

/**
 * One headline figure, the size the screenshot set: the number is the loudest
 * thing on the card, its change sits under it, and up to three supporting
 * figures sit below a hairline.
 */
export function KpiCard({
  label,
  value,
  unit,
  delta,
  sub,
  hero = false,
  tone,
  action,
  span,
}: {
  label: string;
  value: ReactNode;
  /** Small text after the figure: "orders", "of 207". */
  unit?: ReactNode;
  delta?: ReactNode;
  sub?: SubMetric[];
  hero?: boolean;
  tone?: "warn" | "bad";
  action?: ReactNode;
  span?: 2 | 3;
}) {
  return (
    <section
      className={`${styles.card} ${styles.kpi} ${hero ? styles.hero : ""} ${tone ? styles[`kpi_${tone}`] : ""} ${
        span ? styles[`span${span}`] : ""
      }`}
    >
      <header className={styles.kpiHead}>
        <h2 className={styles.kpiLabel}>{label}</h2>
        {action ? <span className={styles.kpiAction}>{action}</span> : null}
      </header>
      <p className={styles.kpiFigure}>
        <span className={styles.kpiValue}>{value}</span>
        {unit ? <span className={styles.kpiUnit}>{unit}</span> : null}
      </p>
      {delta ? <div className={styles.kpiDelta}>{delta}</div> : null}
      {sub && sub.length > 0 ? (
        <dl className={styles.kpiSub}>
          {sub.map((item) => (
            <div key={item.label} className={styles.kpiSubItem}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * A figure that cannot be computed yet. A different component from a zero, and
 * the reason is required, so a blocked metric can never ship without saying
 * what is missing.
 */
export function BlockedCard({ label, reason }: { label: string; reason: string }) {
  return (
    <section className={`${styles.card} ${styles.kpi} ${styles.blocked}`}>
      <header className={styles.kpiHead}>
        <h2 className={styles.kpiLabel}>{label}</h2>
      </header>
      <p className={styles.kpiFigure}>
        <span className={styles.kpiValue} aria-hidden="true">
          —
        </span>
        <span className={styles.srOnly}>Not measurable</span>
      </p>
      <p className={styles.blockedReason}>{reason}</p>
    </section>
  );
}

/**
 * A KPI tile whose Shopify figure is still on its way. Not a blocked card and
 * not a zero: the figure has not failed, it has not arrived. Long ranges can
 * wait up to a minute behind Shopify Analytics' rate limit, which resets every
 * minute, so the wait is named rather than left as a spinner.
 */
export function LoadingCard({ label }: { label: string }) {
  return (
    <section className={`${styles.card} ${styles.kpi}`} aria-busy="true">
      <header className={styles.kpiHead}>
        <h2 className={styles.kpiLabel}>{label}</h2>
      </header>
      <p className={styles.kpiFigure}>
        <span className={`${styles.kpiValue} ${styles.loadingBar}`} aria-hidden="true" />
        <span className={styles.srOnly}>Loading</span>
      </p>
      <p className={styles.blockedReason}>Loading from Shopify Analytics…</p>
    </section>
  );
}

/** The body of a card whose Shopify rows are still on their way. */
export function LoadingNote() {
  return (
    <p className={`${styles.blockedReason} ${styles.loadingNote}`} aria-busy="true">
      Loading from Shopify Analytics… a long range can take up to a minute while Shopify&apos;s rate limit resets.
    </p>
  );
}

/**
 * Render once a promise settles. A server component, used inside `<Suspense>`
 * so a card streams in when its own Shopify queries answer and nothing else
 * waits for it.
 */
export async function Await<T>({ promise, children }: { promise: Promise<T>; children: (value: T) => ReactNode }) {
  return <>{children(await promise)}</>;
}

// --- bars -----------------------------------------------------------------

export interface BarDatum {
  key: string;
  label: ReactNode;
  value: number | null;
  /** Rendered at the end of the row; the caller owns the unit. */
  display?: ReactNode;
  /** Past the line — the one other colour a bar may take. */
  emphasis?: boolean;
  /** No data, as opposed to a measured zero. Renders hatched. */
  missing?: boolean;
  title?: string;
}

/**
 * A horizontal bar list, scaled against the whole list so rows compare. A
 * missing row is hatched at full width instead of drawn at zero.
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
              className={`${styles.barFill} ${d.emphasis ? styles.barEmphasis : ""} ${d.missing ? styles.barMissing : ""}`}
              style={{ width: d.missing ? "100%" : `${Math.max(0, ((d.value ?? 0) / max) * 100).toFixed(1)}%` }}
            />
          </span>
          <span className={`${styles.barValue} ${d.missing ? styles.barValueDim : ""}`}>
            {d.missing ? "no data" : d.display ?? (d.value ?? 0).toLocaleString("en-GB")}
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- states ---------------------------------------------------------------

export function PanelError({ message }: { message: string }) {
  return (
    <div className={styles.error} role="alert">
      <strong>This panel could not load.</strong> {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/**
 * A small heading over a group of rows — used where one panel mixes a snapshot
 * with ranged figures, so "today" and "in the selected range" cannot be confused.
 */
export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={styles.sectionLabel}>
      <h2>{children}</h2>
      {aside ? <span>{aside}</span> : null}
    </div>
  );
}

/** A short line under a figure or table — a fact about the data, never an essay. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className={styles.caption}>{children}</p>;
}
