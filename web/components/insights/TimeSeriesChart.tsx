"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SeriesPoint, ValueUnit } from "@/lib/types";
import { formatTick, formatValue } from "@/lib/insights-format";
import styles from "./TimeSeriesChart.module.css";

/**
 * One series over the range's buckets: a 2px line over a 10% wash, the way the
 * reference dashboard draws revenue.
 *
 * THREE BUCKET STATES, THREE LOOKS. `measured` draws normally — an empty bucket
 * there is a real zero on the floor. `partial` (the bucket holding "now", or a
 * source's edge) gets a hollow marker, so today's half-day does not read as a
 * collapse. `missing` (before a source begins, after it was last synced) is a
 * hatched band with a gap in the line: "no mail synced after 20 August" must
 * never draw as zero mail.
 *
 * Client-side only for the hover layer and for measuring its own width; the
 * points arrive computed and formatted by unit, never by a function prop.
 */

interface Props {
  points: SeriesPoint[];
  unit: ValueUnit;
  ariaLabel: string;
  height?: number;
  /** A reference line the business argues about — 72 hours to ship. */
  threshold?: { value: number; label: string };
  /** What a missing bucket means, for the tooltip. */
  missingLabel?: string;
}

const PAD = { top: 16, right: 16, bottom: 30 };
const LABEL_GAP = 64;

export function TimeSeriesChart({
  points,
  unit,
  ariaLabel,
  height: baseHeight = 280,
  threshold,
  missingLabel = "No data for this period",
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  // The root font size over the 16px base: >1 on large screens (globals.css),
  // so axis text and the room reserved for it grow with the rest of the UI.
  const [scale, setScale] = useState(1);
  const [active, setActive] = useState<number | null>(null);
  const patternId = useId().replace(/:/g, "");

  // TALLER ON WIDE SCREENS. A chart stretched across a large monitor at its
  // base height reads as a flat line; it grows with its width (and the root
  // size), up to 1.6x the base, and never shrinks below it.
  const height = Math.round(Math.min(baseHeight * 1.6, Math.max(baseHeight * scale, width * 0.24)));

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (Number.isFinite(root) && root > 0) setScale(root / 16);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const values = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
    const rawMax = Math.max(threshold?.value ?? 0, ...values, 0);
    const ticks = niceTicks(rawMax);
    const max = ticks[ticks.length - 1] || 1;
    const left = Math.max(40, ...ticks.map((t) => formatTick(unit, t).length * 7 * scale + 14));
    const plotW = Math.max(10, width - left - PAD.right);
    const plotH = height - PAD.top - PAD.bottom;
    const band = plotW / Math.max(1, points.length);
    const x = (i: number) => left + band * (i + 0.5);
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
    const every = Math.max(1, Math.ceil(LABEL_GAP / band));
    return { ticks, max, left, plotW, plotH, band, x, y, every };
  }, [points, width, height, unit, threshold?.value, scale]);

  const { ticks, left, plotW, plotH, band, x, y, every } = geometry;
  const base = PAD.top + plotH;

  // Contiguous runs of drawable points: a null breaks the line and the wash.
  const runs = useMemo(() => {
    const out: { i: number; v: number }[][] = [];
    let current: { i: number; v: number }[] = [];
    points.forEach((p, i) => {
      if (p.value === null || !Number.isFinite(p.value)) {
        if (current.length) out.push(current);
        current = [];
      } else current.push({ i, v: p.value });
    });
    if (current.length) out.push(current);
    return out;
  }, [points]);

  const showMarkers = points.length <= 31;
  const activePoint = active !== null ? points[active] : null;

  const pick = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const i = Math.floor((clientX - rect.left - left) / band);
    setActive(i >= 0 && i < points.length ? i : null);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const last = points.length - 1;
    setActive((i) => {
      if (i === null) return event.key === "ArrowLeft" ? last : 0;
      return Math.min(last, Math.max(0, i + (event.key === "ArrowLeft" ? -1 : 1)));
    });
  };

  const tooltipLeft = active !== null ? Math.min(Math.max(x(active), 90), width - 90) : 0;

  return (
    <div ref={wrapRef} className={styles.wrap} style={{ height }}>
      <svg
        className={styles.svg}
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((i) => i ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <defs>
          <pattern id={patternId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="var(--surface-sunken)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--mist)" strokeWidth="3" />
          </pattern>
        </defs>

        {/* Missing buckets first, so everything else sits on top of the hatch. */}
        {points.map((p, i) =>
          p.state === "missing" ? (
            <rect
              key={`m-${p.key}`}
              x={left + band * i}
              y={PAD.top}
              width={band + 0.5}
              height={plotH}
              fill={`url(#${patternId})`}
            />
          ) : null
        )}

        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.grid} />
            <text x={left - 10} y={y(t)} className={styles.tick} textAnchor="end" dominantBaseline="middle">
              {formatTick(unit, t)}
            </text>
          </g>
        ))}

        {threshold ? (
          <g>
            <line
              x1={left}
              x2={left + plotW}
              y1={y(threshold.value)}
              y2={y(threshold.value)}
              className={styles.threshold}
            />
            <text x={left + plotW} y={y(threshold.value) - 6} className={styles.thresholdLabel} textAnchor="end">
              {threshold.label}
            </text>
          </g>
        ) : null}

        {runs.map((run) => (
          <g key={`r-${run[0].i}`}>
            {run.length > 1 ? (
              <>
                <path
                  className={styles.area}
                  d={`M${x(run[0].i)},${base} ${run.map((p) => `L${x(p.i)},${y(p.v)}`).join(" ")} L${x(
                    run[run.length - 1].i
                  )},${base} Z`}
                />
                <path className={styles.line} d={run.map((p, k) => `${k ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ")} />
              </>
            ) : (
              <circle cx={x(run[0].i)} cy={y(run[0].v)} r={4} className={styles.dot} />
            )}
          </g>
        ))}

        {points.map((p, i) => {
          if (p.value === null) return null;
          const hollow = p.state === "partial";
          if (!showMarkers && !hollow && i !== active) return null;
          return (
            <circle
              key={`d-${p.key}`}
              cx={x(i)}
              cy={y(p.value)}
              r={i === active ? 5.5 : 4}
              className={hollow ? styles.dotHollow : styles.dot}
            />
          );
        })}

        {points.map((p, i) => {
          // Every `every`-th label, plus the last one when it has room: the most
          // recent bucket is the one a reader looks for first.
          const last = i === points.length - 1;
          const shown = i % every === 0 || (last && i % every >= Math.ceil(every * 0.6));
          return shown ? (
            <text key={`x-${p.key}`} x={x(i)} y={height - 8} className={styles.xLabel} textAnchor="middle">
              {p.label}
            </text>
          ) : null;
        })}

        {active !== null ? (
          <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={base} className={styles.crosshair} />
        ) : null}
      </svg>

      {activePoint ? (
        <div className={styles.tooltip} style={{ left: tooltipLeft }} role="status">
          <span className={styles.tipValue}>
            {activePoint.state === "missing" ? "—" : formatValue(unit, activePoint.value)}
          </span>
          <span className={styles.tipTitle}>{activePoint.title}</span>
          {activePoint.state === "missing" ? (
            <span className={styles.tipNote}>{missingLabel}</span>
          ) : activePoint.state === "partial" ? (
            <span className={styles.tipNote}>Period not complete</span>
          ) : null}
        </div>
      ) : null}

      {/* The table view: every value reachable without hovering. */}
      <table className={styles.srOnly}>
        <caption>{ariaLabel}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={`t-${p.key}`}>
              <th scope="row">{p.title}</th>
              <td>{p.state === "missing" ? missingLabel : formatValue(unit, p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Round axis steps: 0 / 500 / 1,000 / 1,500 rather than 0 / 437 / 874. */
function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const stepSize = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t <= max + stepSize * 0.001; t += stepSize) ticks.push(Number(t.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + stepSize).toPrecision(12)));
  return ticks;
}
