"use client";

import { useMemo, useState } from "react";
import { SearchIcon } from "@/components/icons";
import { setTicketStatus } from "@/lib/api/tickets";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { isClosed, summariseTickets } from "@/lib/ticket-stats";
import type { DroppedMail, KnowledgeCategory, TicketListItem } from "@/lib/types";
import { CATEGORY_LABELS, TICKET_CATEGORIES } from "@/lib/types";
import { DroppedMailTable } from "./DroppedMailTable";
import { TicketSection } from "./TicketSection";
import { TicketStatCards } from "./TicketStatCards";
import { TicketTable } from "./TicketTable";
import styles from "./TicketsView.module.css";

interface TicketsViewProps {
  initialTickets: TicketListItem[];
  droppedMail: DroppedMail[];
  loadError: string | null;
}

/** `null` level = the categoriser has not reached the ticket yet. */
type LevelFilter = "all" | "4" | "3" | "2" | "1" | "uncategorised";
type SortOrder = "recent" | "oldest" | "severity";

const SORT_LABELS: Record<SortOrder, string> = {
  recent: "Most recent activity",
  oldest: "Oldest activity",
  severity: "Highest level first",
};

/**
 * Tickets, in three stacked sections: the live queue, the mail the spam gate
 * dropped, and everything closed.
 *
 * Tickets are held in state rather than read straight from the prop, because
 * closing or reopening one moves it between sections immediately — waiting on a
 * server round trip to see a row move would make the button feel broken. The
 * cards recompute from the same state, so they never disagree with the rows.
 *
 * The toolbar filters the QUEUE only. Applying a level filter to closed tickets
 * and to dropped mail (which has no level at all) would mean three different
 * meanings for one control.
 */
export function TicketsView({ initialTickets, droppedMail, loadError }: TicketsViewProps) {
  const [tickets, setTickets] = useState(initialTickets);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<KnowledgeCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortOrder>("recent");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const stats = useMemo(() => summariseTickets(tickets), [tickets]);
  const queue = useMemo(() => tickets.filter((ticket) => !isClosed(ticket)), [tickets]);
  const closed = useMemo(() => tickets.filter(isClosed), [tickets]);

  // Tab counts come from the unfiltered queue, so a tab always says how many it
  // would show — a count that moved with the search would be useless.
  const levelCounts = useMemo(() => {
    const counts = { all: queue.length, "4": 0, "3": 0, "2": 0, "1": 0, uncategorised: 0 };
    for (const ticket of queue) {
      if (ticket.level === null) counts.uncategorised += 1;
      else counts[String(ticket.level) as "1" | "2" | "3" | "4"] += 1;
    }
    return counts;
  }, [queue]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const filtered = queue.filter((ticket) => {
      if (level === "uncategorised" && ticket.level !== null) return false;
      if (level !== "all" && level !== "uncategorised" && String(ticket.level) !== level) return false;
      if (category !== "all" && ticket.category !== category) return false;

      if (needle) {
        const haystack = [ticket.subject, ticket.requesterName, ticket.orderNumber]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    // Sorting a copy: the source array is what every other filter derives from.
    return [...filtered].sort((a, b) => {
      if (sort === "severity") {
        // Nulls last — an uncategorised ticket is unknown severity, not low.
        const al = a.level ?? -1;
        const bl = b.level ?? -1;
        if (al !== bl) return bl - al;
      }
      const at = Date.parse(a.lastMessageAt ?? a.firstMessageAt ?? "") || 0;
      const bt = Date.parse(b.lastMessageAt ?? b.firstMessageAt ?? "") || 0;
      return sort === "oldest" ? at - bt : bt - at;
    });
  }, [queue, level, category, query, sort]);

  async function changeStatus(ticket: TicketListItem, status: "open" | "closed") {
    setPendingId(ticket.id);
    setActionError(null);
    try {
      const saved = await setTicketStatus(ticket.id, status);
      // The response drops message_count (a status flip cannot change it), so
      // the local count is kept rather than being overwritten with zero.
      setTickets((current) =>
        current.map((row) =>
          row.id === ticket.id ? { ...saved, messageCount: row.messageCount } : row
        )
      );
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  if (loadError) {
    return (
      <section className={styles.section}>
        <h1 className={styles.title}>Tickets</h1>
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>Could not load tickets</p>
          <p className={styles.errorBody}>{loadError}</p>
        </div>
      </section>
    );
  }

  const tabs: { key: LevelFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: levelCounts.all },
    { key: "4", label: "Level 4", count: levelCounts["4"] },
    { key: "3", label: "Level 3", count: levelCounts["3"] },
    { key: "2", label: "Level 2", count: levelCounts["2"] },
    { key: "1", label: "Level 1", count: levelCounts["1"] },
    { key: "uncategorised", label: "Uncategorised", count: levelCounts.uncategorised },
  ];

  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <h1 className={styles.title}>Tickets</h1>
        <p className={styles.intro}>
          The queue the agent produced from the support mailbox. Ingestion threads the mail,
          categorisation assigns the subject and level, and forwarding hands over anything that
          asks nothing of support.
        </p>
      </header>

      <TicketStatCards stats={stats} />

      {actionError && (
        <div className={styles.error} role="alert">
          <p className={styles.errorBody}>{actionError}</p>
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="group" aria-label="Filter the queue by level">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`${styles.tab} ${level === tab.key ? styles.tabActive : ""}`}
              aria-pressed={level === tab.key}
              onClick={() => setLevel(tab.key)}
            >
              {tab.label}
              <span className={styles.tabCount}>{tab.count.toLocaleString()}</span>
            </button>
          ))}
        </div>

        <div className={styles.controls}>
          <div className={styles.searchWrap}>
            <SearchIcon size={15} />
            <input
              type="search"
              className={styles.search}
              placeholder="Search subject, requester or order…"
              aria-label="Search the ticket queue"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <label className={styles.selectLabel}>
            <span className={styles.srOnly}>Filter by category</span>
            <select
              className={styles.select}
              value={category}
              onChange={(event) => setCategory(event.target.value as KnowledgeCategory | "all")}
            >
              <option value="all">All categories</option>
              {TICKET_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span className={styles.srOnly}>Sort tickets</span>
            <select
              className={styles.select}
              value={sort}
              onChange={(event) => setSort(event.target.value as SortOrder)}
            >
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Announced politely so a filter change reports its result to a screen
          reader without interrupting typing in the search box. */}
      <p className={styles.srOnly} role="status" aria-live="polite">
        {visible.length} of {queue.length} queued tickets shown
      </p>

      <TicketSection
        title="Queue"
        count={visible.length}
        description="Live tickets waiting on support"
      >
        <TicketTable
          tickets={visible}
          actionLabel="Close ticket"
          onAction={(ticket) => changeStatus(ticket, "closed")}
          pendingId={pendingId}
          emptyTitle="No tickets match these filters"
          emptyBody="Clear the search or pick a different level to widen the queue."
          height="tall"
        />
      </TicketSection>

      <TicketSection
        title="Irrelevant"
        count={droppedMail.length}
        description="Mail the spam gate dropped — never stored as tickets"
        defaultCollapsed
      >
        <DroppedMailTable mail={droppedMail} />
      </TicketSection>

      <TicketSection
        title="Closed"
        count={closed.length}
        description="Resolved and closed tickets"
        defaultCollapsed
      >
        <TicketTable
          tickets={closed}
          actionLabel="Reopen ticket"
          onAction={(ticket) => changeStatus(ticket, "open")}
          pendingId={pendingId}
          emptyTitle="Nothing closed yet"
          emptyBody="Tickets you close from the queue above will collect here."
        />
      </TicketSection>
    </section>
  );
}
