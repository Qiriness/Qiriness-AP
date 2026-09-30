import { addWorkingDays as addWorkingDaysRaw } from "../../scripts/lib/working-days.mjs";

import type { SnoozeWaitingFor, TicketListItem } from "./types";

/**
 * Snooze in the browser: the one crossing point to the shared working-days
 * rule, so the « or Mon 6 Oct at the latest » the menu shows is the deadline
 * the server will write (scripts/lib/snooze-record.mjs, fallbackWakeAt).
 */

/** The shop's delay per party, in working days; null where unset. */
export type SnoozeDelays = Record<Exclude<SnoozeWaitingFor, "date">, number | null>;

export const NO_DELAYS: SnoozeDelays = { customer: null, colleague: null, partner: null };

export function fallbackFor(waitingFor: Exclude<SnoozeWaitingFor, "date">, delays: SnoozeDelays, now: Date = new Date()): Date | null {
  const count = delays[waitingFor];
  if (count === null || count < 1) return null;
  return addWorkingDaysRaw(now, count) as Date | null;
}

/** A few hours from now, for « later today ». */
export function laterToday(now: Date = new Date()): Date {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

/** 09:00 tomorrow in the browser's own time zone. */
export function tomorrowMorning(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** Out of Queue and Backlog until it wakes. */
export function isSnoozed(ticket: Pick<TicketListItem, "snooze">): boolean {
  return Boolean(ticket.snooze);
}

/** « Thu 2 Oct, 09:00 » in the reader's language. */
export function formatWake(iso: string | Date, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A value for `<input type="datetime-local">`, in local time. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
