/**
 * Isomorphic ticket reducers — same file used by the server on first paint and
 * by the client after a status change, so a card can never disagree with the
 * rows under it. Mirrors knowledge-mapper.ts's role for articles.
 *
 * Pure: no Supabase import, nothing server-only, so a client component can call
 * it directly. Keep it that way — tickets-service.ts is where the reads live.
 */

import type { TicketListItem, TicketStats } from "./types";

/** Statuses that mean "done" and belong in the closed section, not the queue. */
export const CLOSED_STATUSES = ["resolved", "closed"] as const;

export function isClosed(ticket: TicketListItem): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(ticket.status);
}

/**
 * Header-card totals.
 *
 * The volume windows are ROLLING (now minus 24h / 30d), not calendar day and
 * month. Ingestion runs in bursts, so on any day without a poll the calendar
 * figures would both read zero and the card would look broken rather than idle.
 *
 * `highPriority` is level 3 + 4 rather than the `priority` column: nothing in
 * the pipeline writes `priority` today, so every ticket sits at its default 3
 * and a card reading it would show zero for ever.
 */
export function summariseTickets(tickets: TicketListItem[], now: Date = new Date()): TicketStats {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const monthAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const stats: TicketStats = {
    total: tickets.length,
    open: 0,
    highPriority: 0,
    levelThree: 0,
    uncategorised: 0,
    last24h: 0,
    last30d: 0,
  };

  for (const ticket of tickets) {
    if (ticket.status === "open") stats.open += 1;
    if (ticket.level === 3 || ticket.level === 4) stats.highPriority += 1;
    if (ticket.level === 3) stats.levelThree += 1;
    if (ticket.category === null) stats.uncategorised += 1;

    // Volume counts when a ticket ARRIVED, so re-activating an old thread does
    // not inflate today's intake.
    const opened = ticket.firstMessageAt ? new Date(ticket.firstMessageAt).getTime() : null;
    if (opened !== null && !Number.isNaN(opened)) {
      if (opened >= dayAgo) stats.last24h += 1;
      if (opened >= monthAgo) stats.last30d += 1;
    }
  }

  return stats;
}
