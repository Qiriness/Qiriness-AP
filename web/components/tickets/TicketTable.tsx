"use client";

import { Fragment, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons";
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
import { TicketDetailPanel } from "./TicketDetailPanel";
import styles from "./TicketTable.module.css";

/** Columns in the row above, so the detail cell spans the whole table. */
const COLUMN_COUNT = 9;

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
 *
 * Clicking a row reveals what the agent made of it underneath. ONE ROW AT A
 * TIME: the panel is several lines tall inside a 26rem scroller, so two open at
 * once would leave neither readable without scrolling.
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function toggle(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

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
          {tickets.map((ticket) => {
            const expanded = expandedId === ticket.id;
            const panelId = `ticket-detail-${ticket.id}`;

            return (
              <Fragment key={ticket.id}>
                <tr
                  className={`${styles.rowClickable} ${expanded ? styles.rowExpanded : ""}`}
                  onClick={() => toggle(ticket.id)}
                >
                  <td className={styles.moodCol}>
                    <HappinessFace happiness={ticket.happiness} />
                  </td>

                  <th scope="row" className={styles.subjectCell}>
                    {/* The row is clickable, but a `tr` cannot be tabbed to or
                        activated by keyboard — this button is that path, and it
                        carries the aria-expanded state the row cannot. */}
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={(event) => {
                        // Otherwise the click reaches the row handler too and the
                        // panel opens and closes in the same gesture.
                        event.stopPropagation();
                        toggle(ticket.id);
                      }}
                    >
                      <span className={styles.chevron} aria-hidden="true">
                        {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                      </span>
                      <span className={styles.subject} title={ticket.subject ?? undefined}>
                        {ticket.subject?.trim() || "(no subject)"}
                      </span>
                    </button>
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

                  {/* Closing a ticket is not "show me more about it": the cell
                      swallows the click so the row does not also toggle. */}
                  <td className={styles.actionCol} onClick={(event) => event.stopPropagation()}>
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

                {expanded && (
                  <tr className={styles.detailRow}>
                    <td colSpan={COLUMN_COUNT} className={styles.detailCell} id={panelId}>
                      <TicketDetailPanel ticket={ticket} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
