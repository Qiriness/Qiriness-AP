import type { SeriesPoint } from "@/lib/types";

/**
 * "per day", "per hour" — read off the series itself, so a chart title can
 * never disagree with the buckets under it.
 */
export function perGrain(points: SeriesPoint[]): string {
  if (points.length < 2) return "per day";
  const gapHours = (Date.parse(`${points[1].key}Z`) - Date.parse(`${points[0].key}Z`)) / 3_600_000;
  if (gapHours <= 1) return "per hour";
  if (gapHours <= 24) return "per day";
  if (gapHours <= 24 * 7) return "per week";
  return "per month";
}
