"use client";

import { useMemo, useState } from "react";
import { setTicketStatus } from "@/lib/api/tickets";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
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
  const t = useT();
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
        <h1 className={styles.title}>{t("nav.conversations")}</h1>
        <p className={styles.subtitle}>
          {t("tickets.dialogs.conversations.subtitle")}
        </p>
      </header>

      {actionError && <p className={styles.error}>{actionError}</p>}

      <TicketSection
        title={t("tickets.dialogs.conversations.open")}
        count={open.length}
        description={t("tickets.dialogs.conversations.openDescription")}
        search={{
          value: openQuery,
          onChange: setOpenQuery,
          placeholder: t("tickets.dialogs.conversations.searchOpenPlaceholder"),
          label: t("tickets.dialogs.conversations.searchOpen"),
        }}
      >
        <TicketTable
          tickets={open.filter((ticket) => matchesConversation(ticket, openQuery))}
          actionLabel={t("tickets.dialogs.conversations.close")}
          onAction={toggleStatus}
          pendingId={pendingId}
          emptyTitle={t("tickets.dialogs.conversations.nothingOpen")}
          emptyBody={t("tickets.dialogs.conversations.nothingOpenBody")}
        />
      </TicketSection>

      <TicketSection
        title={t("tickets.dialogs.conversations.closed")}
        count={closed.length}
        description={t("tickets.dialogs.conversations.closedDescription")}
        defaultCollapsed
        search={{
          value: closedQuery,
          onChange: setClosedQuery,
          placeholder: t("tickets.dialogs.conversations.searchClosedPlaceholder"),
          label: t("tickets.dialogs.conversations.searchClosed"),
        }}
      >
        <TicketTable
          tickets={closed.filter((ticket) => matchesConversation(ticket, closedQuery))}
          actionLabel={t("tickets.dialogs.conversations.reopen")}
          onAction={toggleStatus}
          pendingId={pendingId}
          emptyTitle={t("tickets.dialogs.conversations.nothingClosed")}
          emptyBody={t("tickets.dialogs.conversations.nothingClosedBody")}
        />
      </TicketSection>
    </div>
  );
}
