/**
 * Whole working days from `from` to `now`, Saturdays and Sundays excluded.
 * Public holidays are not modelled, so a threshold can be reached early rather
 * than late. Null means either date is unavailable or invalid.
 */
export function workingDaysBetween(from, now) {
  if (from === null || from === undefined || from === '' || now === null || now === undefined || now === '') {
    return null;
  }
  const start = new Date(from);
  const end = new Date(now);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;

  const elapsedDays = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
  let workingDays = 0;
  for (let index = 1; index <= elapsedDays; index += 1) {
    const day = new Date(start.getTime() + index * 86_400_000).getUTCDay();
    if (day !== 0 && day !== 6) workingDays += 1;
  }
  return workingDays;
}

/** `max(0, elapsed working days - threshold)`, preserving unknown as null. */
export function excessWorkingDays(from, now, threshold) {
  const elapsed = workingDaysBetween(from, now);
  if (threshold === null || threshold === undefined || threshold === '') return null;
  const limit = Number(threshold);
  if (elapsed === null || !Number.isFinite(limit) || limit < 0) return null;
  return Math.max(0, elapsed - limit);
}
