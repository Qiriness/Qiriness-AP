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

export const BACKLOG_AGE_DAYS = 14;
export const BACKLOG_AGE_MS = BACKLOG_AGE_DAYS * 24 * 60 * 60 * 1000;

export function isClosed(ticket: TicketListItem): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(ticket.status);
}

/**
 * Backlog is a dashboard section, not a stored status. It uses the same wait
 * anchor as priority scoring when available, then falls back to first receipt
 * for old rows where `waiting_since` cannot be established.
 */
export function isBacklogTicket(ticket: TicketListItem, now: Date = new Date()): boolean {
  const anchor = ticket.waitingSince ?? ticket.firstMessageAt;
  if (!anchor) return false;

  const since = Date.parse(anchor);
  if (Number.isNaN(since)) return false;

  return now.getTime() - since >= BACKLOG_AGE_MS;
}

/**
 * Header-card totals.
 *
 * THE FIRST THREE CARDS DESCRIBE THE LIVE SET — every ticket that is not
 * resolved or closed, which is exactly the rows Queue and Backlog render
 * between them. Two of them did not, and both disagreed visibly with the tables
 * underneath:
 *
 *   `open` counted `status === "open"` and nothing else, so the 20 tickets
 *   sitting at `awaiting_human` and the 2 at `awaiting_customer` were in neither
 *   the numerator nor the closed pile. Measured on the live book: the card read
 *   53 while Queue + Backlog rendered 75 rows. `awaiting_human` is the worst one
 *   to drop — the agent has explicitly said a person must act.
 *
 *   `highPriority` and `levelThree` counted CLOSED tickets too, so the high
 *   card read 84 against a live queue that could not hold more than 75.
 *
 * `highPriority` is now the red band — `priorityBand === "high"`, the score the
 * table sorts by and paints the left edge with — rather than the old level 3+4
 * stand-in. That stand-in existed because nothing wrote the `priority` column;
 * the band is derived at read time by `scorePriority`, so it needs no column and
 * the card now counts precisely the rows a reader sees marked red. Today it also
 * removes a coincidence that made the cards look broken: with no level 4 in the
 * book, "High priority" and "Level 3" were showing the same number.
 *
 * The volume windows are ROLLING (now minus 24h / 30d), not calendar day and
 * month. Ingestion runs in bursts, so on any day without a poll the calendar
 * figures would both read zero and the card would look broken rather than idle.
 * They count every arrival regardless of status — a ticket that arrived and was
 * closed the same day was still intake.
 */
export function summariseTickets(tickets: TicketListItem[], now: Date = new Date()): TicketStats {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const monthAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const stats: TicketStats = {
    total: tickets.length,
    open: 0,
    highPriority: 0,
    levelThree: 0,
    last24h: 0,
    last30d: 0,
  };

  for (const ticket of tickets) {
    if (!isClosed(ticket)) {
      stats.open += 1;
      if (ticket.priorityBand === "high") stats.highPriority += 1;
      if (ticket.level === 3) stats.levelThree += 1;
    }

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
