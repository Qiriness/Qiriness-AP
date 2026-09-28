/**
 * Whole working days from `from` to `now`, Saturdays and Sundays excluded.
 *
 * Public holidays are not modelled, which makes the count slightly high: a
 * deadline is reached a day early, never a day late (DECISIONS.md § *The
 * dispatch window is a state*). Null when either date cannot be read.
 */
export function workingDaysBetween(from, now) {
  const start = new Date(from);
  const end = new Date(now);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
  let working = 0;
  for (let i = 1; i <= days; i += 1) {
    const day = new Date(start.getTime() + i * 86400000).getUTCDay();
    if (day !== 0 && day !== 6) {
      working += 1;
    }
  }
  return working;
}
