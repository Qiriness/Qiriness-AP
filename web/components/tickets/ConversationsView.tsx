"use client";

import { useMemo, useState } from "react";
import { setTicketStatus } from "@/lib/api/tickets";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { isClosed } from "@/lib/ticket-stats";
import type { TicketListItem } from "@/lib/types";
import { TicketSection } from "./TicketSection";
import { TicketTable } from "./TicketTable";
import styles from "./TicketsView.module.css";

interface ConversationsViewProps {
  conversations: TicketListItem[];
  loadError: string | null;
}

/** Case-insensitive substring over the fields a row actually shows. */
function matchesConversation(ticket: TicketListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [ticket.subject, ticket.requesterName, ticket.customerName, ticket.orderNumber]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * Threads one of our own addresses opened.
 *
 * TWO SECTIONS, AND OPEN IS NOT COLLAPSED. These threads are the back office
 * working real customer returns — the last time they were routed off the Tickets
 * queue, three sat open at L3 unseen. Anything unfinished therefore leads the
 * page, expanded, above the closed archive.
 *
 * No level tabs, no category filter, no stat cards: this is a small set (14 on
 * the current corpus) where the useful questions are "what is still open" and
 * "where did that forward go", and a toolbar built for 565 rows would be
 * furniture. Search is per-section, as it is on Tickets.
 */
export function ConversationsView({ conversations, loadError }: ConversationsViewProps) {
  const [rows, setRows] = useState(conversations);
  const [openQuery, setOpenQuery] = useState("");
  const [closedQuery, setClosedQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { open, closed } = useMemo(() => {
    return {
      open: rows.filter((ticket) => !isClosed(ticket)),
      closed: rows.filter((ticket) => isClosed(ticket)),
    };
  }, [rows]);

  async function toggleStatus(ticket: TicketListItem) {
    const next = isClosed(ticket) ? "open" : "closed";
    setPendingId(ticket.id);
    setActionError(null);
    try {
      const updated = await setTicketStatus(ticket.id, next);
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <p className={styles.error}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Conversations</h1>
        <p className={styles.subtitle}>
          Threads opened by our own side — a colleague forwarding a customer&apos;s problem in,
          the warehouse coordinating a return, a logged phone call. The agent gathers the
          facts on these but never drafts a reply, because the reply would be addressed to a
          colleague rather than a customer.
        </p>
      </header>

      {actionError && <p className={styles.error}>{actionError}</p>}

      <TicketSection
        title="Open"
        count={open.length}
        description="Still needs somebody. These are customer problems relayed by a colleague, not internal chatter."
        search={{
          value: openQuery,
          onChange: setOpenQuery,
          placeholder: "Search open conversations…",
          label: "Search open conversations",
        }}
      >
        <TicketTable
          tickets={open.filter((ticket) => matchesConversation(ticket, openQuery))}
          actionLabel="Close"
          onAction={toggleStatus}
          pendingId={pendingId}
          emptyTitle="Nothing open"
          emptyBody="Every internal thread has been dealt with."
        />
      </TicketSection>

      <TicketSection
        title="Closed"
        count={closed.length}
        description="Finished internal threads, kept because they are often the only record of what was done for a customer."
        defaultCollapsed
        search={{
          value: closedQuery,
          onChange: setClosedQuery,
          placeholder: "Search closed conversations…",
          label: "Search closed conversations",
        }}
      >
        <TicketTable
          tickets={closed.filter((ticket) => matchesConversation(ticket, closedQuery))}
          actionLabel="Reopen"
          onAction={toggleStatus}
          pendingId={pendingId}
          emptyTitle="Nothing closed yet"
          emptyBody="Internal threads appear here once they are finished."
        />
      </TicketSection>
    </div>
  );
}
