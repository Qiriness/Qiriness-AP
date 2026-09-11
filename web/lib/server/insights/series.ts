/**
 * Turning a sparse SQL series into the points a chart draws.
 *
 * SQL returns only the buckets that had something in them. Every other bucket
 * in the range is either a real zero or a hole in the source, and which one it
 * is depends on the source's coverage — decided by `bucketCoverage`, not here.
 * A bucket outside coverage gets a null value, so the chart draws a gap over a
 * hatch instead of a line along the floor.
 */

import {
  bucketCoverage,
  bucketLabel,
  bucketTitle,
  fillSeries,
  windowCovered,
} from "../../../../scripts/lib/insights-range.mjs";
import type { BucketState, InsightsRange, SeriesPoint } from "../../types";

export interface Coverage {
  from: string | null;
  through: string | null;
}

export function toSeries<R extends { bucket: unknown }>(
  range: InsightsRange,
  rows: R[],
  value: (row: R | null) => number | null,
  coverage: Coverage
): SeriesPoint[] {
  const states = bucketCoverage(range, coverage) as BucketState[];
  const filled = fillSeries(
    range.keys,
    rows,
    (row: R) => row.bucket as string,
    () => null
  ) as (R | null)[];

  return range.keys.map((key, i) => ({
    key,
    label: bucketLabel(key, range.grain),
    title: bucketTitle(key, range.grain),
    value: states[i] === "missing" ? null : value(filled[i]),
    state: states[i],
  }));
}

/** Whether the previous period is inside the source, so comparing with it means something. */
export function previousCovered(range: InsightsRange, coverage: Coverage): boolean {
  return windowCovered(range.previous, coverage, range.tz);
}
