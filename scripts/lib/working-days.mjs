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

/**
 * `from` plus `count` working days, at the same time of day. A start on a
 * weekend counts from the next Monday's first step, so « 2 working days » from
 * Saturday lands on Tuesday. Null when `from` cannot be read or `count` is not
 * a whole number of days.
 */
export function addWorkingDays(from, count) {
  const start = new Date(from);
  if (!Number.isFinite(start.getTime()) || !Number.isInteger(count) || count < 0) return null;
  let at = start.getTime();
  let left = count;
  while (left > 0) {
    at += 86_400_000;
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return new Date(at);
}
