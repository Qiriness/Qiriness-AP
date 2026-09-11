"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BucketState, ValueUnit } from "@/lib/types";
import { formatTick, formatValue } from "@/lib/insights-format";
import styles from "./ColumnChart.module.css";

/**
 * Columns over categories or time buckets — the one bar form the panels need.
 *
 *   segments   stacked upward from zero, in series order (fixed colours)
 *   negative   one series drawn DOWNWARD from zero, on the same axis: an
 *              unsubscribe is the opposite of a subscribe, not a second measure
 *   line       one series drawn as a line on the same axis (a net figure)
 *   top        a short label on the column cap — a share, not a second axis
 *
 * One y-axis, always. Marks follow the house specs: columns at most 24px wide,
 * a 2px surface gap between stacked segments, rounded data ends, square at the
 * baseline. A `missing` bucket is hatched; a `partial` one is drawn lighter.
 */

export interface ColumnDatum {
  key: string;
  label: string;
  title: string;
  state?: BucketState;
  segments: number[];
  negative?: number;
  line?: number | null;
  top?: string;
  note?: string;
}

export interface ColumnSeries {
  label: string;
  color: string;
}

interface Props {
  data: ColumnDatum[];
  series: ColumnSeries[];
  negativeSeries?: ColumnSeries;
  lineSeries?: ColumnSeries;
  unit: ValueUnit;
  ariaLabel: string;
  height?: number;
  missingLabel?: string;
  /** The x-axis caption, for a categorical axis ("Orders placed"). */
  xTitle?: string;
}

const PAD = { top: 22, right: 12, bottom: 30 };
const LABEL_GAP = 56;
const GAP = 2;
const R = 3;

export function ColumnChart({
  data,
  series,
  negativeSeries,
  lineSeries,
  unit,
  ariaLabel,
  height: baseHeight = 260,
  missingLabel = "No data for this period",
  xTitle,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
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

  const bottom = PAD.bottom + (xTitle ? 16 : 0);

  const g = useMemo(() => {
    const drawable = data.filter((d) => d.state !== "missing");
    const tops = drawable.map((d) => d.segments.reduce((s, v) => s + v, 0));
    const lines = drawable.map((d) => d.line ?? 0);
    const max = Math.max(1, ...tops, ...lines);
    const min = Math.min(0, ...drawable.map((d) => -(d.negative ?? 0)), ...lines);
    const step = niceStep((max - min) / 4);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let t = lo; t <= hi + step / 1000; t += step) ticks.push(Number(t.toPrecision(12)));
    const left = Math.max(36, ...ticks.map((t) => formatTick(unit, t).length * 7 * scale + 14));
    const plotW = Math.max(10, width - left - PAD.right);
    const plotH = height - PAD.top - bottom;
    const band = plotW / Math.max(1, data.length);
    const colW = Math.max(3, Math.min(24, band * 0.62));
    const y = (v: number) => PAD.top + ((hi - v) / (hi - lo || 1)) * plotH;
    const x = (i: number) => left + band * (i + 0.5);
    const every = Math.max(1, Math.ceil(LABEL_GAP / band));
    return { ticks, left, plotW, plotH, band, colW, y, x, every, hi, lo };
  }, [data, width, height, unit, bottom, scale]);

  const { ticks, left, plotW, plotH, band, colW, y, x, every } = g;
  const zero = y(0);
  const showTops = band >= 30;
  const legend = [...series, ...(negativeSeries ? [negativeSeries] : []), ...(lineSeries ? [lineSeries] : [])];

  const pick = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const i = Math.floor((clientX - rect.left - left) / band);
    setActive(i >= 0 && i < data.length ? i : null);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const last = data.length - 1;
    setActive((i) => (i === null ? (event.key === "ArrowLeft" ? last : 0) : Math.min(last, Math.max(0, i + (event.key === "ArrowLeft" ? -1 : 1)))));
  };

  const linePath = lineSeries
    ? data
        .map((d, i) => (d.state === "missing" || d.line === null || d.line === undefined ? null : [x(i), y(d.line)]))
        .reduce<string[]>((acc, pt, i, all) => {
          if (!pt) return acc;
          const prev = i > 0 ? all[i - 1] : null;
          acc.push(`${prev ? "L" : "M"}${pt[0]},${pt[1]}`);
          return acc;
        }, [])
        .join(" ")
    : "";

  const activeDatum = active !== null ? data[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 100), width - 100) : 0;

  return (
    <div className={styles.root}>
      {legend.length > 1 ? (
        <ul className={styles.legend}>
          {legend.map((s) => (
            <li key={s.label}>
              <span
                className={s === lineSeries ? styles.keyLine : styles.keySwatch}
                style={{ background: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}

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
          onFocus={() => setActive((i) => i ?? data.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          <defs>
            <pattern id={patternId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="var(--surface-sunken)" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="var(--mist)" strokeWidth="3" />
            </pattern>
          </defs>

          {data.map((d, i) =>
            d.state === "missing" ? (
              <rect key={`m-${d.key}`} x={left + band * i} y={PAD.top} width={band + 0.5} height={plotH} fill={`url(#${patternId})`} />
            ) : null
          )}

          {active !== null ? (
            <rect x={left + band * active} y={PAD.top} width={band} height={plotH} className={styles.hover} />
          ) : null}

          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.grid} />
              <text x={left - 10} y={y(t)} className={styles.tick} textAnchor="end" dominantBaseline="middle">
                {formatTick(unit, t)}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            if (d.state === "missing") return null;
            const cx = x(i) - colW / 2;
            const faded = d.state === "partial";
            // Stacked in value space; every segment above the first starts 2px
            // higher, so the gap between two is surface, not a stroke.
            let below = 0;
            const drawn = d.segments.map((value, s) => {
              if (value <= 0) return null;
              const topY = y(below + value);
              const bottomY = y(below) - (below > 0 ? GAP : 0);
              const isTop = d.segments.slice(s + 1).every((v) => v <= 0);
              const h = Math.max(0, bottomY - topY);
              below += value;
              return (
                <path
                  key={s}
                  d={isTop ? roundedTop(cx, topY, colW, h, R) : `M${cx},${topY}h${colW}v${h}h${-colW}Z`}
                  fill={series[s]?.color ?? "var(--chart-line)"}
                  opacity={faded ? 0.55 : 1}
                />
              );
            });
            const neg = d.negative && d.negative > 0 ? (
              <path
                d={roundedBottom(cx, zero + GAP / 2, colW, Math.max(0, y(-d.negative) - zero - GAP / 2), R)}
                fill={negativeSeries?.color ?? "var(--chart-2)"}
                opacity={faded ? 0.55 : 1}
              />
            ) : null;
            const total = d.segments.reduce((s, v) => s + v, 0);
            return (
              <g key={`c-${d.key}`}>
                {drawn}
                {neg}
                {d.top && showTops && total > 0 ? (
                  <text x={x(i)} y={y(total) - 6} className={styles.top} textAnchor="middle">
                    {d.top}
                  </text>
                ) : null}
              </g>
            );
          })}

          {lineSeries && linePath ? (
            <path d={linePath} className={styles.line} style={{ stroke: lineSeries.color }} />
          ) : null}
          {lineSeries
            ? data.map((d, i) =>
                d.state === "missing" || d.line === null || d.line === undefined ? null : (
                  <circle key={`l-${d.key}`} cx={x(i)} cy={y(d.line)} r={i === active ? 5 : 3.5} className={styles.dot} style={{ fill: lineSeries.color }} />
                )
              )
            : null}

          {data.map((d, i) => {
            const last = i === data.length - 1;
            const shown = i % every === 0 || (last && i % every >= Math.ceil(every * 0.6));
            return shown ? (
              <text key={`x-${d.key}`} x={x(i)} y={height - bottom + 18} className={styles.xLabel} textAnchor="middle">
                {d.label}
              </text>
            ) : null;
          })}
          {xTitle ? (
            <text x={left + plotW / 2} y={height - 4} className={styles.xTitle} textAnchor="middle">
              {xTitle}
            </text>
          ) : null}
        </svg>

        {activeDatum ? (
          <div className={styles.tooltip} style={{ left: tipLeft }} role="status">
            <span className={styles.tipTitle}>{activeDatum.title}</span>
            {activeDatum.state === "missing" ? (
              <span className={styles.tipNote}>{missingLabel}</span>
            ) : (
              <>
                {series.map((s, idx) => (
                  <span key={s.label} className={styles.tipRow}>
                    <span className={styles.tipKey} style={{ background: s.color }} aria-hidden="true" />
                    <strong>{formatValue(unit, activeDatum.segments[idx] ?? 0)}</strong> {s.label}
                  </span>
                ))}
                {negativeSeries ? (
                  <span className={styles.tipRow}>
                    <span className={styles.tipKey} style={{ background: negativeSeries.color }} aria-hidden="true" />
                    <strong>{formatValue(unit, activeDatum.negative ?? 0)}</strong> {negativeSeries.label}
                  </span>
                ) : null}
                {lineSeries ? (
                  <span className={styles.tipRow}>
                    <span className={styles.tipKey} style={{ background: lineSeries.color }} aria-hidden="true" />
                    <strong>{signed(activeDatum.line ?? 0)}</strong> {lineSeries.label}
                  </span>
                ) : null}
                {activeDatum.note ? <span className={styles.tipNote}>{activeDatum.note}</span> : null}
                {activeDatum.state === "partial" ? <span className={styles.tipNote}>Period not complete</span> : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      <table className={styles.srOnly}>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {legend.map((s) => (
              <th key={s.label} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={`t-${d.key}`}>
              <th scope="row">{d.title}</th>
              {d.state === "missing" ? (
                <td colSpan={legend.length}>{missingLabel}</td>
              ) : (
                <>
                  {series.map((s, idx) => (
                    <td key={s.label}>{formatValue(unit, d.segments[idx] ?? 0)}</td>
                  ))}
                  {negativeSeries ? <td>{formatValue(unit, d.negative ?? 0)}</td> : null}
                  {lineSeries ? <td>{signed(d.line ?? 0)}</td> : null}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function roundedBottom(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y}H${x + w}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x + rr}Q${x},${y + h} ${x},${y + h - rr}Z`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value)).toLocaleString("en-GB")}`;
}

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  return (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
}
