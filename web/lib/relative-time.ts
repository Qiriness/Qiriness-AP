/** Formats an ISO timestamp as a short relative label, e.g. "2h ago". */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";

  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 30) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;

  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear}y ago`;
}
