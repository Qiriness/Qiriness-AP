"use client";

import { useMemo, useState } from "react";
import { setTicketStatus } from "@/lib/api/tickets";
import { promoteDroppedMail } from "@/lib/api/dropped-mail";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { isBacklogTicket, isClosed, summariseTickets } from "@/lib/ticket-stats";
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
type SortOrder = "priority" | "recent" | "oldest" | "severity";

const SORT_LABELS: Record<SortOrder, string> = {
  priority: "Highest priority",
  recent: "Most recent activity",
  oldest: "Oldest activity",
  severity: "Highest level first",
};

/** Case-insensitive substring over the fields a row actually shows. */
function matches(query: string, fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return fields.filter(Boolean).join(" ").toLowerCase().includes(needle);
}

/**
 * BOTH NAMES, because the row shows whichever it has: searching for the Shopify
 * account name must find a ticket whose email was signed differently, and vice
 * versa. See the naming note in DECISIONS — nothing normalises either one.
 */
function matchesTicket(ticket: TicketListItem, query: string): boolean {
  return matches(query, [
    ticket.subject,
    ticket.requesterName,
    ticket.customerName,
    ticket.orderNumber,
  ]);
}

/** Dropped mail has no customer and no order — subject, sender and the gate's reason are all there is. */
function matchesDroppedMail(mail: DroppedMail, query: string): boolean {
  return matches(query, [mail.subject, mail.fromEmail, mail.reason]);
}

/**
 * Tickets, in four stacked sections: the live queue, older open backlog, the
 * mail the spam gate dropped, and everything closed.
 *
 * Tickets are held in state rather than read straight from the prop, because
 * closing or reopening one moves it between sections immediately — waiting on a
 * server round trip to see a row move would make the button feel broken. The
 * cards recompute from the same state, so they never disagree with the rows.
 *
 * The toolbar filters open tickets only. Queue and Backlog are the same ticket
 * set split by age, while closed tickets and dropped mail have different
 * meanings and stay outside the filter.
 */
export function TicketsView({ initialTickets, droppedMail, loadError }: TicketsViewProps) {
  const [tickets, setTickets] = useState(initialTickets);
  // Dropped mail is held in state for the same reason tickets are: promoting one
  // moves it out of Irrelevant and into the queue, and both sections have to
  // agree about that in the same render.
  const [dropped, setDropped] = useState(droppedMail);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<KnowledgeCategory | "all">("all");
  // Who opened the thread: everyone, only consumers, or only the business
  // senders. A FILTER RATHER THAN A ROUTE — these threads were briefly moved to
  // a page of their own and that hid real customer work, so the queue keeps them
  // and this narrows the view on demand. See DECISIONS.md.
  const [sender, setSender] = useState<"all" | "consumer" | "business">("all");
  // One query per table, not one for the page: see TicketSection. Level,
  // category and sort stay in the toolbar — those genuinely describe the whole
  // open set, and Queue and Backlog are one set split by age.
  const [queueQuery, setQueueQuery] = useState("");
  const [backlogQuery, setBacklogQuery] = useState("");
  const [closedQuery, setClosedQuery] = useState("");
  const [droppedQuery, setDroppedQuery] = useState("");
  const [sort, setSort] = useState<SortOrder>("priority");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Promoting is the one action whose result leaves the screen — the row it was
  // taken on disappears from Irrelevant — so it is the one that has to say what
  // happened. Closing a ticket needs no notice: the row moves and you watch it.
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const stats = useMemo(() => summariseTickets(tickets), [tickets]);
  const openTickets = useMemo(() => tickets.filter((ticket) => !isClosed(ticket)), [tickets]);
  // Closed and dropped mail stay outside the toolbar's filters — they mean
  // different things from the open queue — but each now searches itself, which
  // is the first time either was searchable at all.
  const closed = useMemo(
    () => tickets.filter(isClosed).filter((ticket) => matchesTicket(ticket, closedQuery)),
    [tickets, closedQuery]
  );
  const visibleDroppedMail = useMemo(
    () => dropped.filter((mail) => matchesDroppedMail(mail, droppedQuery)),
    [dropped, droppedQuery]
  );

  // Tab counts come from the unfiltered open set, so a tab always says how many
  // it would show across Queue + Backlog. A count that moved with the search
  // would be useless.
  const levelCounts = useMemo(() => {
    const counts = { all: openTickets.length, "4": 0, "3": 0, "2": 0, "1": 0, uncategorised: 0 };
    for (const ticket of openTickets) {
      if (ticket.level === null) counts.uncategorised += 1;
      else counts[String(ticket.level) as "1" | "2" | "3" | "4"] += 1;
    }
    return counts;
  }, [openTickets]);

  const visibleOpenTickets = useMemo(() => {
    const filtered = openTickets.filter((ticket) => {
      if (level === "uncategorised" && ticket.level !== null) return false;
      if (level !== "all" && level !== "uncategorised" && String(ticket.level) !== level) return false;
      if (category !== "all" && ticket.category !== category) return false;
      if (sender === "consumer" && ticket.senderLabel) return false;
      if (sender === "business" && !ticket.senderLabel) return false;
      return true;
    });

    // Sorting a copy: the source array is what every other filter derives from.
    return [...filtered].sort((a, b) => {
      if (sort === "priority") {
        if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      }
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
  }, [openTickets, level, category, sender, sort]);

  const queue = useMemo(
    () =>
      visibleOpenTickets
        .filter((ticket) => !isBacklogTicket(ticket))
        .filter((ticket) => matchesTicket(ticket, queueQuery)),
    [visibleOpenTickets, queueQuery]
  );
  const backlog = useMemo(
    () =>
      visibleOpenTickets
        // Not a bare `.filter(isBacklogTicket)`: it takes an optional `now`, and
        // `filter` would pass the row index into it as a Date.
        .filter((ticket) => isBacklogTicket(ticket))
        .filter((ticket) => matchesTicket(ticket, backlogQuery)),
    [visibleOpenTickets, backlogQuery]
  );

  /**
   * Overturns the gate on one dropped email.
   *
   * The row leaves Irrelevant and the ticket joins the queue in the same render,
   * from the projection the API returned — the list's own, so the new row is not
   * a thinner version of the ones beside it.
   *
   * TWO OUTCOMES, AND THEY ARE SAID DIFFERENTLY. A first contact becomes a
   * ticket; a blocked reply joins the thread it belongs to, which is already in
   * one of these sections and does not need adding again. An own-side sender
   * goes to /conversations, so it is not added here either — that partition is
   * the server's and the client must not contradict it.
   */
  async function promote(mail: DroppedMail) {
    setPendingId(mail.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const { ticket, ticketCreated } = await promoteDroppedMail(mail.id);
      setDropped((current) => current.filter((row) => row.id !== mail.id));
      if (!ticket.isOwnSide) {
        // Replace rather than always prepend: a blocked reply lands on a ticket
        // already on screen, reopened and with a message more, and two rows for
        // one ticket would be a worse bug than a missing one.
        setTickets((current) =>
          current.some((row) => row.id === ticket.id)
            ? current.map((row) => (row.id === ticket.id ? ticket : row))
            : [ticket, ...current]
        );
      }
      setActionNotice(
        ticketCreated
          ? ticket.isOwnSide
            ? `“${ticket.subject ?? "(no subject)"}” was added to Conversations — the agent reads it on its next poll.`
            : `“${ticket.subject ?? "(no subject)"}” is in the queue. The agent categorises and investigates it on its next poll.`
          : `Added to the existing ticket “${ticket.subject ?? "(no subject)"}”, which is back in the agent's queue.`
      );
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function changeStatus(ticket: TicketListItem, status: "open" | "closed") {
    setPendingId(ticket.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const saved = await setTicketStatus(ticket.id, status);
      // The API returns the same queue projection as the list, including the
      // recomputed score after a status change.
      setTickets((current) =>
        current.map((row) =>
          row.id === ticket.id ? saved : row
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

      {/* `status`, not `alert`: this reports a result the operator asked for,
          and an assertive live region would cut across whatever they are
          reading next. */}
      {actionNotice && (
        <div className={styles.notice} role="status">
          <p className={styles.noticeBody}>{actionNotice}</p>
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
            <span className={styles.srOnly}>Filter by who sent it</span>
            <select
              className={styles.select}
              value={sender}
              onChange={(event) => setSender(event.target.value as "all" | "consumer" | "business")}
            >
              <option value="all">Anyone</option>
              <option value="consumer">Consumers only</option>
              <option value="business">Staff &amp; partners only</option>
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
        {visibleOpenTickets.length} of {openTickets.length} open tickets shown
      </p>

      <TicketSection
        title="Queue"
        count={queue.length}
        description="Open tickets waiting less than two weeks"
        search={{
          value: queueQuery,
          onChange: setQueueQuery,
          placeholder: "Search subject, requester or order…",
          label: "Search the queue",
        }}
      >
        <TicketTable
          tickets={queue}
          actionLabel="Close ticket"
          onAction={(ticket) => changeStatus(ticket, "closed")}
          pendingId={pendingId}
          emptyTitle="No tickets match these filters"
          emptyBody="Clear the search or pick a different level to widen the queue."
        />
      </TicketSection>

      <TicketSection
        title="Irrelevant"
        count={visibleDroppedMail.length}
        description="Mail the spam gate dropped — never stored as tickets"
        defaultCollapsed
        search={{
          value: droppedQuery,
          onChange: setDroppedQuery,
          placeholder: "Search subject, sender or reason…",
          label: "Search dropped mail",
        }}
      >
        <DroppedMailTable
          mail={visibleDroppedMail}
          onPromote={promote}
          pendingId={pendingId}
        />
      </TicketSection>

      <TicketSection
        title="Backlog"
        count={backlog.length}
        description="Open tickets waiting two weeks or more"
        defaultCollapsed
        search={{
          value: backlogQuery,
          onChange: setBacklogQuery,
          placeholder: "Search subject, requester or order…",
          label: "Search the backlog",
        }}
      >
        <TicketTable
          tickets={backlog}
          actionLabel="Close ticket"
          onAction={(ticket) => changeStatus(ticket, "closed")}
          pendingId={pendingId}
          emptyTitle="No backlog tickets match these filters"
          emptyBody="Older open tickets will collect here once they pass two weeks."
        />
      </TicketSection>

      <TicketSection
        title="Closed"
        count={closed.length}
        description="Resolved and closed tickets"
        defaultCollapsed
        search={{
          value: closedQuery,
          onChange: setClosedQuery,
          placeholder: "Search subject, requester or order…",
          label: "Search closed tickets",
        }}
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
