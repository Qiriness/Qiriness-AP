import type { SeriesPoint } from "@/lib/types";

/**
 * "hour", "day" — read off the series itself, so a chart title can
 * never disagree with the buckets under it.
 */
export function perGrain(points: SeriesPoint[]): "hour" | "day" | "week" | "month" {
  if (points.length < 2) return "day";
  const gapHours = (Date.parse(`${points[1].key}Z`) - Date.parse(`${points[0].key}Z`)) / 3_600_000;
  if (gapHours <= 1) return "hour";
  if (gapHours <= 24) return "day";
  if (gapHours <= 24 * 7) return "week";
  return "month";
}
