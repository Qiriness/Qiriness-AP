"use client";

import { Button } from "@/components/ui/Button";
import type { TicketListItem } from "@/lib/types";
import {
  CATEGORY_LABELS,
  RESPONSIBLE_TEAM_LABELS,
  TICKET_STATUS_LABELS,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/relative-time";
import { HappinessFace } from "./HappinessFace";
import { LevelChip } from "./LevelChip";
import styles from "./TicketTable.module.css";

interface TicketTableProps {
  tickets: TicketListItem[];
  /** Label for the per-row action, e.g. "Close ticket" / "Reopen ticket". */
  actionLabel: string;
  onAction: (ticket: TicketListItem) => void;
  /** Ticket id currently being written, so only that row shows a spinner. */
  pendingId: string | null;
  emptyTitle: string;
  emptyBody: string;
  /** "tall" is for the queue — the main table, which gets the vertical room. */
  height?: "default" | "tall";
}

/**
 * The queue itself. A real table element, not a grid of divs: this is tabular
 * data, and screen readers get row/column semantics for free.
 *
 * The body scrolls inside a fixed height rather than growing with the data —
 * three of these are stacked on the page, and a table that ran to 565 rows
 * would bury the two sections beneath it.
 */
export function TicketTable({
  tickets,
  actionLabel,
  onAction,
  pendingId,
  emptyTitle,
  emptyBody,
  height = "default",
}: TicketTableProps) {
  if (tickets.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>{emptyTitle}</p>
        <p className={styles.emptyBody}>{emptyBody}</p>
      </div>
    );
  }

  return (
    <div className={`${styles.scroll} ${height === "tall" ? styles.tall : ""}`}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>
          {tickets.length.toLocaleString()} tickets, most recent activity first
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.moodCol}>
              <span className={styles.srOnly}>Customer mood</span>
            </th>
            <th scope="col" className={styles.subjectCol}>Subject</th>
            <th scope="col">Requester</th>
            <th scope="col">Category</th>
            <th scope="col">Level</th>
            <th scope="col">Team</th>
            <th scope="col" className={styles.numCol}>Messages</th>
            <th scope="col">Last activity</th>
            <th scope="col" className={styles.actionCol}>
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td className={styles.moodCol}>
                <HappinessFace happiness={ticket.happiness} />
              </td>

              <th scope="row" className={styles.subjectCell}>
                <span className={styles.subject} title={ticket.subject ?? undefined}>
                  {ticket.subject?.trim() || "(no subject)"}
                </span>
                <span className={styles.subMeta}>
                  {TICKET_STATUS_LABELS[ticket.status]}
                  {ticket.orderNumber ? ` · Order ${ticket.orderNumber}` : ""}
                </span>
              </th>

              <td className={styles.requester}>
                {ticket.requesterName?.trim() || <span className={styles.muted}>Unknown</span>}
              </td>

              <td>
                {ticket.category ? (
                  <>
                    <span className={styles.category}>{CATEGORY_LABELS[ticket.category]}</span>
                    {/* The second subject only exists on mail spanning two topics. */}
                    {ticket.secondaryCategory && (
                      <span className={styles.subMeta}>+ {CATEGORY_LABELS[ticket.secondaryCategory]}</span>
                    )}
                  </>
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </td>

              <td><LevelChip level={ticket.level} /></td>

              <td>
                {ticket.responsibleTeam ? (
                  RESPONSIBLE_TEAM_LABELS[ticket.responsibleTeam]
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </td>

              <td className={styles.numCol}>{ticket.messageCount}</td>

              <td className={styles.time}>
                <time dateTime={ticket.lastMessageAt ?? undefined}>
                  {formatRelativeTime(ticket.lastMessageAt) || "—"}
                </time>
              </td>

              <td className={styles.actionCol}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={pendingId === ticket.id}
                  disabled={pendingId !== null && pendingId !== ticket.id}
                  onClick={() => onAction(ticket)}
                >
                  {actionLabel}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
