"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ClockIcon,
  CrownIcon,
  SearchIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { TrackingText } from "@/components/ui/TrackingText";
import { promoteDroppedMail } from "@/lib/api/dropped-mail";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { decideOnDraft, fetchTicketDetail, fetchTicketThread, setTicketStatus } from "@/lib/api/tickets";
import { formatRelativeTime } from "@/lib/relative-time";
import { isBacklogTicket, isClosed, summariseTickets } from "@/lib/ticket-stats";
import type {
  DroppedMail,
  InvestigationVerdict,
  KnowledgeCategory,
  TicketDetail,
  TicketDraft,
  TicketListItem,
  TicketMessage,
  TicketOrderFacts,
  TicketThread,
  TicketTracking,
} from "@/lib/types";
import {
  CATEGORY_LABELS,
  RESPONSIBLE_TEAM_LABELS,
  SENDER_LABELS,
  TICKET_CATEGORIES,
  TICKET_LEVEL_MEANINGS,
  TICKET_STATUS_LABELS,
} from "@/lib/types";
import { HappinessFace } from "./HappinessFace";
import { LevelChip } from "./LevelChip";
import styles from "./TicketsView.module.css";

interface TicketsViewProps {
  initialTickets: TicketListItem[];
  droppedMail: DroppedMail[];
  loadError: string | null;
}

type LevelFilter = "all" | "4" | "3" | "2" | "1" | "uncategorised";
type SortOrder = "priority" | "recent" | "oldest" | "severity";
type TicketView = "queue" | "backlog" | "irrelevant" | "closed";

const SORT_LABELS: Record<SortOrder, string> = {
  priority: "Highest priority",
  recent: "Most recent activity",
  oldest: "Oldest activity",
  severity: "Highest level first",
};

const VIEW_LABELS: Record<TicketView, string> = {
  queue: "Queue",
  backlog: "Backlog",
  irrelevant: "Irrelevant",
  closed: "Closed",
};

const DRAFT_HEADINGS: Record<string, string> = {
  answerable: "AI draft",
  needs_customer_input: "AI draft question",
  needs_human: "AI draft acknowledgement",
};

const VERDICT_LABELS: Record<InvestigationVerdict, string> = {
  answerable: "Answerable",
  needs_customer_input: "Needs customer input",
  needs_human: "Needs human",
};

const NEWLINE = String.fromCharCode(10);

function matches(query: string, fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.filter(Boolean).join(" ").toLowerCase().includes(needle);
}

function matchesTicket(ticket: TicketListItem, query: string): boolean {
  return matches(query, [ticket.subject, ticket.requesterName, ticket.customerName, ticket.orderNumber]);
}

function matchesDroppedMail(mail: DroppedMail, query: string): boolean {
  return matches(query, [mail.subject, mail.fromEmail, mail.reason]);
}

function formatPriorityScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function ticketTitle(ticket: TicketListItem): string {
  return ticket.subject?.trim() || "(no subject)";
}

function requesterName(ticket: TicketListItem): string {
  return ticket.customerName?.trim() || ticket.requesterName?.trim() || "Unknown requester";
}

function ticketAge(ticket: TicketListItem): string {
  return formatRelativeTime(ticket.lastMessageAt ?? ticket.firstMessageAt) || "-";
}

function priorityLabel(ticket: TicketListItem): string {
  if (ticket.priorityBand === "high") return "High";
  if (ticket.priorityBand === "medium") return "Medium";
  return "Low";
}

function statusClass(ticket: TicketListItem): string {
  if (ticket.status === "awaiting_human") return styles.statusWarning;
  if (ticket.status === "awaiting_customer" || ticket.status === "forwarded") return styles.statusInfo;
  if (isClosed(ticket)) return styles.statusDone;
  return styles.statusNeutral;
}

export function TicketsView({ initialTickets, droppedMail, loadError }: TicketsViewProps) {
  const [tickets, setTickets] = useState(initialTickets);
  const [dropped, setDropped] = useState(droppedMail);
  const [activeView, setActiveView] = useState<TicketView>("queue");
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedDroppedId, setSelectedDroppedId] = useState<string | null>(null);
  const [queryByView, setQueryByView] = useState<Record<TicketView, string>>({
    queue: "",
    backlog: "",
    irrelevant: "",
    closed: "",
  });
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<KnowledgeCategory | "all">("all");
  const [sender, setSender] = useState<"all" | "consumer" | "business">("all");
  const [sort, setSort] = useState<SortOrder>("priority");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [thread, setThread] = useState<TicketThread | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  const stats = useMemo(() => summariseTickets(tickets), [tickets]);
  const openTickets = useMemo(() => tickets.filter((ticket) => !isClosed(ticket)), [tickets]);

  const levelCounts = useMemo(() => {
    const counts = { all: openTickets.length, "4": 0, "3": 0, "2": 0, "1": 0, uncategorised: 0 };
    for (const ticket of openTickets) {
      if (ticket.level === null) counts.uncategorised += 1;
      else counts[String(ticket.level) as "1" | "2" | "3" | "4"] += 1;
    }
    return counts;
  }, [openTickets]);

  const filteredOpenTickets = useMemo(() => {
    const filtered = openTickets.filter((ticket) => {
      if (level === "uncategorised" && ticket.level !== null) return false;
      if (level !== "all" && level !== "uncategorised" && String(ticket.level) !== level) return false;
      if (category !== "all" && ticket.category !== category) return false;
      if (sender === "consumer" && ticket.senderLabel) return false;
      if (sender === "business" && !ticket.senderLabel) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sort === "priority" && a.priorityScore !== b.priorityScore) {
        return b.priorityScore - a.priorityScore;
      }
      if (sort === "severity") {
        const al = a.level ?? -1;
        const bl = b.level ?? -1;
        if (al !== bl) return bl - al;
      }
      const at = Date.parse(a.lastMessageAt ?? a.firstMessageAt ?? "") || 0;
      const bt = Date.parse(b.lastMessageAt ?? b.firstMessageAt ?? "") || 0;
      return sort === "oldest" ? at - bt : bt - at;
    });
  }, [openTickets, level, category, sender, sort]);

  const queueBase = useMemo(
    () => filteredOpenTickets.filter((ticket) => !isBacklogTicket(ticket)),
    [filteredOpenTickets]
  );
  const backlogBase = useMemo(
    () => filteredOpenTickets.filter((ticket) => isBacklogTicket(ticket)),
    [filteredOpenTickets]
  );
  const closedBase = useMemo(() => tickets.filter(isClosed), [tickets]);
  const droppedBase = dropped;

  const query = queryByView[activeView];
  const queue = useMemo(() => queueBase.filter((ticket) => matchesTicket(ticket, queryByView.queue)), [queueBase, queryByView.queue]);
  const backlog = useMemo(
    () => backlogBase.filter((ticket) => matchesTicket(ticket, queryByView.backlog)),
    [backlogBase, queryByView.backlog]
  );
  const closed = useMemo(
    () => closedBase.filter((ticket) => matchesTicket(ticket, queryByView.closed)),
    [closedBase, queryByView.closed]
  );
  const visibleDropped = useMemo(
    () => droppedBase.filter((mail) => matchesDroppedMail(mail, queryByView.irrelevant)),
    [droppedBase, queryByView.irrelevant]
  );

  const activeTickets =
    activeView === "queue" ? queue : activeView === "backlog" ? backlog : activeView === "closed" ? closed : [];
  const selectedTicket = activeTickets.find((ticket) => ticket.id === selectedTicketId) ?? null;
  const selectedDropped = activeView === "irrelevant"
    ? visibleDropped.find((mail) => mail.id === selectedDroppedId) ?? null
    : null;

  useEffect(() => {
    if (!selectedTicket) {
      setDetail(null);
      setThread(null);
      setDetailError(null);
      setThreadError(null);
      return;
    }

    let live = true;
    setDetail(null);
    setThread(null);
    setDetailError(null);
    setThreadError(null);

    fetchTicketDetail(selectedTicket.id)
      .then((loaded) => {
        if (live) setDetail(loaded);
      })
      .catch((cause) => {
        if (live) setDetailError(knowledgeErrorMessage(cause));
      });

    fetchTicketThread(selectedTicket.id)
      .then((loaded) => {
        if (live) setThread(loaded);
      })
      .catch((cause) => {
        if (live) setThreadError(knowledgeErrorMessage(cause));
      });

    return () => {
      live = false;
    };
  }, [selectedTicket]);

  function updateQuery(value: string) {
    setQueryByView((current) => ({ ...current, [activeView]: value }));
  }

  async function promote(mail: DroppedMail) {
    setPendingId(mail.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const { ticket, ticketCreated } = await promoteDroppedMail(mail.id);
      setDropped((current) => current.filter((row) => row.id !== mail.id));
      setSelectedDroppedId((current) => (current === mail.id ? null : current));
      if (!ticket.isOwnSide) {
        setTickets((current) =>
          current.some((row) => row.id === ticket.id)
            ? current.map((row) => (row.id === ticket.id ? ticket : row))
            : [ticket, ...current]
        );
      }
      setActionNotice(
        ticketCreated
          ? ticket.isOwnSide
            ? `"${ticket.subject ?? "(no subject)"}" was added to Conversations. The agent reads it on its next poll.`
            : `"${ticket.subject ?? "(no subject)"}" is in the queue. The agent categorises and investigates it on its next poll.`
          : `Added to the existing ticket "${ticket.subject ?? "(no subject)"}", which is back in the agent's queue.`
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
      setTickets((current) => current.map((row) => (row.id === ticket.id ? saved : row)));
      setSelectedTicketId(null);
      setContextOpen(false);
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

  const tabCounts: Record<TicketView, number> = {
    queue: queueBase.length,
    backlog: backlogBase.length,
    irrelevant: droppedBase.length,
    closed: closedBase.length,
  };

  return (
    <section className={styles.section}>
      <header className={styles.pageHeader}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>Tickets</h1>
          <TicketsMetrics stats={stats} />
        </div>
      </header>

      {(actionError || actionNotice) && (
        <div className={actionError ? styles.error : styles.notice} role={actionError ? "alert" : "status"}>
          <p className={actionError ? styles.errorBody : styles.noticeBody}>{actionError ?? actionNotice}</p>
        </div>
      )}

      <div className={styles.navToolbar}>
        <div className={styles.viewTabs} role="tablist" aria-label="Ticket views">
          {(Object.keys(VIEW_LABELS) as TicketView[]).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={activeView === view}
              className={`${styles.viewTab} ${activeView === view ? styles.viewTabActive : ""}`}
              onClick={() => {
                setActiveView(view);
                setSelectedTicketId(null);
                setSelectedDroppedId(null);
                setContextOpen(false);
              }}
            >
              {VIEW_LABELS[view]}
              <span>{tabCounts[view].toLocaleString()}</span>
            </button>
          ))}
        </div>

        <TicketToolbar
          activeView={activeView}
          query={query}
          onQueryChange={updateQuery}
          level={level}
          levelCounts={levelCounts}
          onLevelChange={setLevel}
          category={category}
          onCategoryChange={setCategory}
          sender={sender}
          onSenderChange={setSender}
          sort={sort}
          onSortChange={setSort}
        />
      </div>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {activeView === "irrelevant"
          ? `${visibleDropped.length} dropped emails shown`
          : `${activeTickets.length} tickets shown in ${VIEW_LABELS[activeView]}`}
      </p>

      {activeView === "irrelevant" ? (
        <IrrelevantWorkspace
          mail={visibleDropped}
          selectedMail={selectedDropped}
          selectedId={selectedDroppedId}
          onSelect={setSelectedDroppedId}
          onPromote={promote}
          pendingId={pendingId}
        />
      ) : (
        <TicketWorkspace
          view={activeView}
          tickets={activeTickets}
          selectedTicket={selectedTicket}
          selectedId={selectedTicketId}
          onSelect={setSelectedTicketId}
          detail={detail}
          detailError={detailError}
          thread={thread}
          threadError={threadError}
          onDraftChange={(draft) => setThread((current) => (current ? { ...current, draft } : current))}
          onChangeStatus={changeStatus}
          pendingId={pendingId}
          contextOpen={contextOpen}
          onOpenContext={() => setContextOpen(true)}
          onCloseContext={() => setContextOpen(false)}
        />
      )}
    </section>
  );
}

function TicketsMetrics({ stats }: { stats: ReturnType<typeof summariseTickets> }) {
  const metrics = [
    ["Open", stats.open],
    ["Needs human", stats.levelThree],
    ["High priority", stats.highPriority],
    ["New today", stats.last24h],
    ["Last 30 days", stats.last30d],
  ];

  return (
    <dl className={styles.metrics} aria-label="Ticket summary">
      {metrics.map(([label, value]) => (
        <div className={styles.metric} key={label}>
          <dt>{label}</dt>
          <dd>{Number(value).toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

interface TicketToolbarProps {
  activeView: TicketView;
  query: string;
  onQueryChange: (value: string) => void;
  level: LevelFilter;
  levelCounts: Record<LevelFilter, number>;
  onLevelChange: (value: LevelFilter) => void;
  category: KnowledgeCategory | "all";
  onCategoryChange: (value: KnowledgeCategory | "all") => void;
  sender: "all" | "consumer" | "business";
  onSenderChange: (value: "all" | "consumer" | "business") => void;
  sort: SortOrder;
  onSortChange: (value: SortOrder) => void;
}

function TicketToolbar({
  activeView,
  query,
  onQueryChange,
  level,
  levelCounts,
  onLevelChange,
  category,
  onCategoryChange,
  sender,
  onSenderChange,
  sort,
  onSortChange,
}: TicketToolbarProps) {
  const ticketView = activeView === "queue" || activeView === "backlog";
  const placeholder =
    activeView === "irrelevant" ? "Search subject, sender or reason..." : "Search subject, requester or order...";

  return (
    <div className={styles.toolbar}>
      <label className={styles.searchWrap}>
        <span className={styles.srOnly}>Search {VIEW_LABELS[activeView]}</span>
        <SearchIcon size={15} />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className={styles.searchInput}
        />
      </label>

      {ticketView && (
        <>
          <label className={styles.selectLabel}>
            <span>Level</span>
            <select
              className={styles.select}
              value={level}
              onChange={(event) => onLevelChange(event.target.value as LevelFilter)}
            >
              <option value="all">All ({levelCounts.all})</option>
              <option value="4">Level 4 ({levelCounts["4"]})</option>
              <option value="3">Level 3 ({levelCounts["3"]})</option>
              <option value="2">Level 2 ({levelCounts["2"]})</option>
              <option value="1">Level 1 ({levelCounts["1"]})</option>
              <option value="uncategorised">Uncategorised ({levelCounts.uncategorised})</option>
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span>Category</span>
            <select
              className={styles.select}
              value={category}
              onChange={(event) => onCategoryChange(event.target.value as KnowledgeCategory | "all")}
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
            <span>Sender</span>
            <select
              className={styles.select}
              value={sender}
              onChange={(event) => onSenderChange(event.target.value as "all" | "consumer" | "business")}
            >
              <option value="all">Anyone</option>
              <option value="consumer">Consumers only</option>
              <option value="business">Staff & partners only</option>
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span>Sort</span>
            <select
              className={styles.select}
              value={sort}
              onChange={(event) => onSortChange(event.target.value as SortOrder)}
            >
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

interface TicketWorkspaceProps {
  view: TicketView;
  tickets: TicketListItem[];
  selectedTicket: TicketListItem | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: TicketDetail | null;
  detailError: string | null;
  thread: TicketThread | null;
  threadError: string | null;
  onDraftChange: (draft: TicketDraft) => void;
  onChangeStatus: (ticket: TicketListItem, status: "open" | "closed") => void;
  pendingId: string | null;
  contextOpen: boolean;
  onOpenContext: () => void;
  onCloseContext: () => void;
}

function TicketWorkspace({
  view,
  tickets,
  selectedTicket,
  selectedId,
  onSelect,
  detail,
  detailError,
  thread,
  threadError,
  onDraftChange,
  onChangeStatus,
  pendingId,
  contextOpen,
  onOpenContext,
  onCloseContext,
}: TicketWorkspaceProps) {
  return (
    <div className={`${styles.workspace} ${selectedTicket ? styles.hasSelection : ""}`}>
      <TicketListPane view={view} tickets={tickets} selectedId={selectedId} onSelect={onSelect} />

      <section className={styles.detailPane} aria-label="Selected ticket detail">
        {selectedTicket ? (
          <TicketDetailWorkspace
            ticket={selectedTicket}
            detail={detail}
            detailError={detailError}
            thread={thread}
            threadError={threadError}
            onDraftChange={onDraftChange}
            onChangeStatus={onChangeStatus}
            pendingId={pendingId}
            onOpenContext={onOpenContext}
            onBack={() => onSelect("")}
          />
        ) : (
          <EmptyDetail title="Select a ticket to view its conversation." body="The queue stays visible while the conversation, draft and investigation load here." />
        )}
      </section>

      <aside className={styles.contextPane} aria-label="Ticket context">
        {selectedTicket ? (
          <TicketContextPane ticket={selectedTicket} detail={detail} error={detailError} />
        ) : (
          <EmptyDetail title="No ticket selected" body="Customer, ticket, order and investigation context appears here." />
        )}
      </aside>

      {selectedTicket && (
        <div className={`${styles.contextSheet} ${contextOpen ? styles.contextSheetOpen : ""}`} aria-hidden={!contextOpen}>
          <button className={styles.sheetScrim} type="button" aria-label="Close context" onClick={onCloseContext} />
          <aside className={styles.sheetPanel} role="dialog" aria-modal="true" aria-labelledby="ticket-context-title">
            <header className={styles.sheetHeader}>
              <h2 id="ticket-context-title">Ticket context</h2>
              <Button size="sm" variant="tertiary" onClick={onCloseContext}>Close</Button>
            </header>
            <TicketContextPane ticket={selectedTicket} detail={detail} error={detailError} />
          </aside>
        </div>
      )}
    </div>
  );
}

function TicketListPane({
  view,
  tickets,
  selectedId,
  onSelect,
}: {
  view: TicketView;
  tickets: TicketListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className={styles.listPane} aria-label={`${VIEW_LABELS[view]} ticket list`}>
      <div className={styles.listHeader}>
        <div>
          <h2>{VIEW_LABELS[view]}</h2>
          <p>{tickets.length.toLocaleString()} ticket{tickets.length === 1 ? "" : "s"}</p>
        </div>
        <span>{view === "closed" ? "Recently closed" : "Highest priority first"}</span>
      </div>

      {tickets.length === 0 ? (
        <CompactEmpty title="No tickets match this view" body="Clear search or filters to widen the list." />
      ) : (
        <ol className={styles.ticketList} role="listbox" aria-label={`${VIEW_LABELS[view]} tickets`}>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                role="option"
                aria-selected={selectedId === ticket.id}
                className={[
                  styles.ticketItem,
                  selectedId === ticket.id ? styles.ticketItemSelected : "",
                  styles[`priority${ticket.priorityBand[0].toUpperCase()}${ticket.priorityBand.slice(1)}`],
                ].filter(Boolean).join(" ")}
                onClick={() => onSelect(ticket.id)}
              >
                <span className={styles.itemTop}>
                  <span className={styles.priorityGroup}>
                    <span className={styles.priorityScore}>{formatPriorityScore(ticket.priorityScore)}</span>
                    <span className={styles.priorityWord}>{priorityLabel(ticket)}</span>
                  </span>
                  <time dateTime={ticket.lastMessageAt ?? undefined}>{ticketAge(ticket)}</time>
                </span>
                <span className={styles.itemSubject} title={ticketTitle(ticket)}>
                  {ticketTitle(ticket)}
                </span>
                <span className={styles.itemRequester} title={`${requesterName(ticket)}${ticket.orderNumber ? ` - Order ${ticket.orderNumber}` : ""}`}>
                  {requesterName(ticket)}
                  {ticket.orderNumber ? ` - Order ${ticket.orderNumber}` : ""}
                  {ticket.isVip && (
                    <span className={styles.vipInline} title={`VIP - RFM segment: ${ticket.rfmGroup ?? "unknown"}`}>
                      <CrownIcon size={12} />
                      <span className={styles.srOnly}>VIP customer</span>
                    </span>
                  )}
                </span>
                <span className={styles.itemMeta}>
                  <span>{ticket.category ? CATEGORY_LABELS[ticket.category] : "Uncategorised"}</span>
                  <TicketLevelBadge ticket={ticket} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function TicketDetailWorkspace({
  ticket,
  detail,
  detailError,
  thread,
  threadError,
  onDraftChange,
  onChangeStatus,
  pendingId,
  onOpenContext,
  onBack,
}: {
  ticket: TicketListItem;
  detail: TicketDetail | null;
  detailError: string | null;
  thread: TicketThread | null;
  threadError: string | null;
  onDraftChange: (draft: TicketDraft) => void;
  onChangeStatus: (ticket: TicketListItem, status: "open" | "closed") => void;
  pendingId: string | null;
  onOpenContext: () => void;
  onBack: () => void;
}) {
  const closed = isClosed(ticket);

  return (
    <div className={styles.detailFrame}>
      <header className={styles.ticketHeader}>
        <button type="button" className={styles.mobileBack} onClick={onBack}>
          <ChevronLeftIcon size={15} />
          Back to tickets
        </button>
        <div className={styles.ticketHeaderText}>
          <h2 title={ticketTitle(ticket)}>{ticketTitle(ticket)}</h2>
          <p>
            {requesterName(ticket)}
            {ticket.orderNumber ? ` - Order ${ticket.orderNumber}` : ""}
            {ticket.category ? ` - ${CATEGORY_LABELS[ticket.category]}` : ""}
            {ticket.lastMessageAt ? ` - Last activity ${formatRelativeTime(ticket.lastMessageAt)}` : ""}
          </p>
        </div>
        <div className={styles.ticketHeaderActions}>
          <TicketLevelBadge ticket={ticket} />
          {ticket.responsibleTeam && (
            <span className={styles.assignment}>Team: {RESPONSIBLE_TEAM_LABELS[ticket.responsibleTeam]}</span>
          )}
          <Button size="sm" variant="secondary" className={styles.contextButton} onClick={onOpenContext}>
            Context
          </Button>
          <Button
            size="sm"
            variant={closed ? "secondary" : "danger"}
            loading={pendingId === ticket.id}
            disabled={pendingId !== null && pendingId !== ticket.id}
            onClick={() => onChangeStatus(ticket, closed ? "open" : "closed")}
          >
            {closed ? "Reopen ticket" : "Close ticket"}
          </Button>
        </div>
      </header>

      <div className={styles.conversationArea}>
        <ConversationThread thread={thread} error={threadError} />
      </div>

      <DraftResponsePanel
        ticket={ticket}
        thread={thread}
        error={threadError}
        onDraftChange={onDraftChange}
        detail={detail}
        detailError={detailError}
      />
    </div>
  );
}

function ConversationThread({ thread, error }: { thread: TicketThread | null; error: string | null }) {
  if (error) {
    return <p className={styles.inlineError} role="alert">{error}</p>;
  }
  if (!thread) {
    return <ThreadSkeleton />;
  }
  if (thread.messages.length === 0) {
    return <CompactEmpty title="This ticket holds no stored messages" body="The detail and draft can still be reviewed if available." />;
  }

  return (
    <section className={styles.threadSection} aria-label="Conversation thread">
      <div className={styles.sectionHead}>
        <h3>Conversation thread</h3>
        <span>{thread.messages.length} message{thread.messages.length === 1 ? "" : "s"}</span>
      </div>
      <ol className={styles.messages}>
        {thread.messages.map((message) => (
          <MessageBlock key={message.id} message={message} parcels={thread.parcels} />
        ))}
      </ol>
    </section>
  );
}

function DraftResponsePanel({
  ticket,
  thread,
  error,
  onDraftChange,
  detail,
  detailError,
}: {
  ticket: TicketListItem;
  thread: TicketThread | null;
  error: string | null;
  onDraftChange: (draft: TicketDraft) => void;
  detail: TicketDetail | null;
  detailError: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  const [saving, setSaving] = useState<null | "approved" | "edited" | "rejected">(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const draft = thread?.draft ?? null;

  useEffect(() => {
    setEditing(false);
    setEdited("");
    setSaving(null);
    setDecideError(null);
  }, [ticket.id]);

  async function decide(status: "approved" | "edited" | "rejected") {
    if (!draft) return;
    setSaving(status);
    setDecideError(null);
    try {
      const updated = await decideOnDraft(ticket.id, {
        status,
        approvedBody: status === "edited" ? edited : null,
      });
      onDraftChange(updated);
      setEditing(false);
    } catch (cause) {
      setDecideError(knowledgeErrorMessage(cause));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={styles.draftPanel} aria-label="AI draft">
      <div className={styles.draftHead}>
        <div>
          <h3>{DRAFT_HEADINGS[draft?.sourceVerdict ?? "answerable"]}</h3>
          {draft && <p>{draftStatusText(draft)}</p>}
        </div>
        {draft && <span className={styles.draftStatus}>{draft.status}</span>}
      </div>

      {thread?.duplicateOf && (
        <p className={styles.duplicate} role="alert">
          Duplicate of another ticket. The agent will not draft here; answer on the original instead.
        </p>
      )}

      {thread?.relatedTo && !thread.duplicateOf && (
        <p className={styles.related}>This customer wrote before about the same thing. The reply below takes that into account.</p>
      )}

      {error ? (
        <p className={styles.inlineError} role="alert">{error}</p>
      ) : !thread ? (
        <DraftSkeleton />
      ) : draft ? (
        <>
          {!draft.checksPassed && (
            <p className={styles.blocked} role="alert">
              Not sendable - {draft.failedChecks.length || "some"} mechanical {draft.failedChecks.length === 1 ? "check" : "checks"} failed:{" "}
              {draft.failedChecks.join("; ") || "see the draft record"}.
            </p>
          )}

          {editing ? (
            <textarea
              className={styles.editor}
              value={edited}
              onChange={(event) => setEdited(event.target.value)}
              rows={Math.min(18, Math.max(7, edited.split(NEWLINE).length + 2))}
              aria-label="Edit the drafted reply"
            />
          ) : (
            <pre className={styles.draftBody}>
              <TrackingText text={draft.body} parcels={thread.parcels} />
            </pre>
          )}

          {draft.approvedBody && (
            <div className={styles.reviewerVersion}>
              <h4>Reviewer version</h4>
              <pre className={styles.draftBody}>
                <TrackingText text={draft.approvedBody} parcels={thread.parcels} />
              </pre>
            </div>
          )}

          <div className={styles.draftFoot}>
            <div className={styles.draftActions}>
              {editing ? (
                <>
                  <Button size="sm" variant="primary" loading={saving === "edited"} disabled={saving !== null || edited.trim() === ""} onClick={() => decide("edited")}>
                    Save edit
                  </Button>
                  <Button size="sm" variant="secondary" disabled={saving !== null} onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving !== null}
                    onClick={() => {
                      setEdited(draft.approvedBody ?? draft.body);
                      setEditing(true);
                    }}
                  >
                    Edit draft
                  </Button>
                  <Button size="sm" variant="secondary" loading={saving === "rejected"} disabled={saving !== null} onClick={() => decide("rejected")}>
                    Reject
                  </Button>
                  <Button size="sm" variant="primary" loading={saving === "approved"} disabled={saving !== null} onClick={() => decide("approved")}>
                    Approve
                  </Button>
                </>
              )}
            </div>
            {draft.draftedAt && (
              <p className={styles.stamp}>
                Drafted <time dateTime={draft.draftedAt}>{formatRelativeTime(draft.draftedAt)}</time>
              </p>
            )}
          </div>

          {decideError && <p className={styles.inlineError} role="alert">{decideError}</p>}
        </>
      ) : (
        <p className={styles.placeholder}>
          No draft - this ticket has no case file yet, or it is level 4, where the agent stays silent on purpose.
        </p>
      )}

      {detailError && <p className={styles.inlineError} role="alert">{detailError}</p>}
      {!detailError && detail?.results?.action && (
        <p className={styles.draftContext}>Required action: {detail.results.action}</p>
      )}
    </section>
  );
}

function draftStatusText(draft: TicketDraft): string {
  if (draft.disposition === "terminal") return "Terminal - sending this closes the ticket.";
  if (draft.sourceVerdict === "needs_customer_input") return "Intermediary - sending this waits on the customer.";
  return "Intermediary - a colleague still owes this customer an answer.";
}

function TicketContextPane({
  ticket,
  detail,
  error,
}: {
  ticket: TicketListItem;
  detail: TicketDetail | null;
  error: string | null;
}) {
  const results = detail?.results ?? null;
  const order = detail?.order ?? results?.candidateOrder ?? null;
  const isCandidate = !detail?.order && Boolean(results?.candidateOrder);

  return (
    <div className={styles.contextScroll}>
      <ContextSection title="Customer">
        <InfoList
          rows={[
            ["Name", requesterName(ticket)],
            ["RFM segment", ticket.rfmGroup],
            ["VIP", ticket.isVip ? "Yes" : null],
            ["Sender", ticket.senderLabel ? SENDER_LABELS[ticket.senderLabel] : "Consumer"],
          ]}
        />
      </ContextSection>

      <ContextSection title="Ticket">
        <InfoList
          rows={[
            ["Category", ticket.category ? CATEGORY_LABELS[ticket.category] : "Uncategorised"],
            ["Secondary", ticket.secondaryCategory ? CATEGORY_LABELS[ticket.secondaryCategory] : null],
            ["Level", ticket.level ? `${TICKET_LEVEL_MEANINGS[ticket.level]} (L${ticket.level})` : "Uncategorised"],
            ["State", TICKET_STATUS_LABELS[ticket.status]],
            ["Team", ticket.responsibleTeam ? RESPONSIBLE_TEAM_LABELS[ticket.responsibleTeam] : null],
            ["Messages", String(ticket.messageCount)],
            ["Last activity", ticketAge(ticket)],
            ["Priority", `${formatPriorityScore(ticket.priorityScore)} (${priorityLabel(ticket)})`],
          ]}
        />
      </ContextSection>

      <ContextSection title="Order">
        {error ? (
          <p className={styles.inlineError} role="alert">{error}</p>
        ) : !detail ? (
          <ContextSkeleton />
        ) : order ? (
          <OrderFactsBlock order={order} candidate={isCandidate} />
        ) : (
          <p className={styles.muted}>No order number confirmed for this ticket.</p>
        )}
      </ContextSection>

      <ContextSection title="Investigation">
        {error ? (
          <p className={styles.inlineError} role="alert">{error}</p>
        ) : !detail ? (
          <ContextSkeleton />
        ) : results ? (
          <InvestigationBlock detail={detail} />
        ) : (
          <p className={styles.muted}>
            The agent has not investigated this ticket. It may still be queued, uncategorised, or outside the enabled subjects.
          </p>
        )}
      </ContextSection>

      <ContextSection title="Required action">
        {error ? (
          <p className={styles.inlineError} role="alert">{error}</p>
        ) : !detail ? (
          <ContextSkeleton />
        ) : results ? (
          <>
            <p className={styles.actionText}>{results.action}</p>
            {results.actionReason && <p className={styles.reason}>{results.actionReason}</p>}
          </>
        ) : (
          <p className={styles.actionText}>Triage this one by hand.</p>
        )}
      </ContextSection>
    </div>
  );
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.contextSection}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function InfoList({ rows }: { rows: [string, string | null | undefined][] }) {
  return (
    <dl className={styles.infoList}>
      {rows.filter(([, value]) => Boolean(value)).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OrderFactsBlock({ order, candidate }: { order: TicketOrderFacts; candidate: boolean }) {
  return (
    <div className={styles.orderFacts}>
      {candidate && <p className={styles.candidateNote}>Candidate last order only - not confirmed as the order they mean.</p>}
      <InfoList
        rows={[
          [candidate ? "Last order" : "Order", order.orderName],
          ["Name on order", order.customerName],
          ["Order contact", order.contactEmail],
          ["Order status", order.orderStatus],
          ["Tracking status", order.trackingStatus],
          ["Items", candidate && order.items.length > 0 ? order.items.join(", ") : null],
        ]}
      />
      {order.tracking.length > 0 && (
        <div className={styles.trackingList}>
          <span>Tracking</span>
          {order.tracking.map((parcel) => (
            <span key={parcel.number} className={styles.parcel}>
              {parcel.url ? (
                <a href={parcel.url} target="_blank" rel="noreferrer">{parcel.number}</a>
              ) : (
                <span>{parcel.number}</span>
              )}
              {parcel.carrier && <small>{parcel.carrier}</small>}
            </span>
          ))}
        </div>
      )}
      {order.resolvedAt && (
        <p className={styles.stamp}>Shopify data read <time dateTime={order.resolvedAt}>{formatRelativeTime(order.resolvedAt)}</time></p>
      )}
    </div>
  );
}

function InvestigationBlock({ detail }: { detail: TicketDetail }) {
  const results = detail.results;
  if (!results) return null;

  return (
    <div className={styles.investigation}>
      <p className={`${styles.verdict} ${styles[`verdict_${results.verdict}`]}`}>{VERDICT_LABELS[results.verdict]}</p>
      <p className={styles.resultHeadline}>{results.headline}</p>
      {results.investigatedAt && (
        <p className={styles.stamp}>Investigated <time dateTime={results.investigatedAt}>{formatRelativeTime(results.investigatedAt)}</time></p>
      )}
      {results.findings.length > 0 && (
        <ul className={styles.evidenceList}>
          {results.findings.map((finding, index) => (
            <li key={`finding-${index}`}>
              <CheckCircleIcon size={14} />
              <span>{finding}</span>
            </li>
          ))}
        </ul>
      )}
      {results.unresolved.length > 0 && (
        <ul className={styles.evidenceList}>
          {results.unresolved.map((entry, index) => (
            <li key={`unresolved-${index}`} className={styles.unresolvedItem}>
              <AlertIcon size={14} />
              <span>{entry.claim}{entry.why ? ` - ${entry.why}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {detail.facts.length > 0 && (
        <dl className={styles.factList}>
          {detail.facts.map((fact) => (
            <div key={fact.need}>
              <dt>{fact.label}{fact.outcome ? ` - ${fact.outcome}` : ""}</dt>
              <dd>{fact.lines.join("; ")}</dd>
            </div>
          ))}
        </dl>
      )}
      {results.findings.length === 0 && results.unresolved.length === 0 && detail.facts.length === 0 && (
        <p className={styles.muted}>Nothing could be established from the tools available.</p>
      )}
    </div>
  );
}

function TicketLevelBadge({ ticket }: { ticket: TicketListItem }) {
  const status = TICKET_STATUS_LABELS[ticket.status];
  return (
    <span className={`${styles.levelBadge} ${statusClass(ticket)}`}>
      {ticket.level ? `L${ticket.level} ${TICKET_LEVEL_MEANINGS[ticket.level]}` : "Uncategorised"}
      {ticket.status !== "open" ? ` - ${status}` : ""}
    </span>
  );
}

function MessageBlock({ message, parcels }: { message: TicketMessage; parcels: TicketTracking[] }) {
  const outbound = message.direction === "outbound";
  const sender = senderIdentity(message, outbound);

  return (
    <li className={`${styles.message} ${outbound ? styles.outbound : styles.inbound}`}>
      <div className={styles.messageHead}>
        <span className={styles.sender}>{sender.name}</span>
        {sender.email && <span className={styles.senderEmail}>{sender.email}</span>}
        <span className={styles.direction}>{outbound ? "Sent" : "Received"}</span>
        {message.at && <time className={styles.when} dateTime={message.at}>{formatRelativeTime(message.at)}</time>}
        {message.hasAttachments && <span className={styles.attachment}>Has attachments</span>}
      </div>
      {message.body?.trim() ? (
        <pre className={styles.messageBody}>
          <TrackingText text={message.body} parcels={parcels} />
        </pre>
      ) : (
        <p className={styles.placeholder}>No body stored for this message.</p>
      )}
    </li>
  );
}

function senderIdentity(message: TicketMessage, outbound: boolean): { name: string; email: string | null } {
  const name = message.fromName?.trim() ?? "";
  const email = message.fromEmail?.trim() ?? "";

  if (!name && !email) return { name: outbound ? "Qiriness" : "Unknown sender", email: null };
  if (!name) return { name: email, email: null };
  if (!email) return { name, email: null };
  return { name, email: name.toLowerCase() === email.toLowerCase() ? null : email };
}

function IrrelevantWorkspace({
  mail,
  selectedMail,
  selectedId,
  onSelect,
  onPromote,
  pendingId,
}: {
  mail: DroppedMail[];
  selectedMail: DroppedMail | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPromote: (mail: DroppedMail) => void;
  pendingId: string | null;
}) {
  return (
    <div className={`${styles.workspace} ${styles.irrelevantWorkspace} ${selectedMail ? styles.hasSelection : ""}`}>
      <aside className={styles.listPane} aria-label="Irrelevant email list">
        <div className={styles.listHeader}>
          <div>
            <h2>Irrelevant</h2>
            <p>{mail.length.toLocaleString()} dropped email{mail.length === 1 ? "" : "s"}</p>
          </div>
          <span>Most recent decision first</span>
        </div>
        {mail.length === 0 ? (
          <CompactEmpty title="Nothing has been dropped" body="Mail blocked by the blocklist or classifier will appear here." />
        ) : (
          <ol className={styles.ticketList} role="listbox" aria-label="Dropped emails">
            {mail.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedId === item.id}
                  className={`${styles.ticketItem} ${selectedId === item.id ? styles.ticketItemSelected : ""}`}
                  onClick={() => onSelect(item.id)}
                >
                  <span className={styles.itemTop}>
                    <span className={styles.priorityWord}>{item.label ?? "Blocklisted"}</span>
                    <time dateTime={item.decidedAt ?? undefined}>{formatRelativeTime(item.decidedAt) || "-"}</time>
                  </span>
                  <span className={styles.itemSubject} title={item.subject ?? undefined}>{item.subject?.trim() || "(no subject)"}</span>
                  <span className={styles.itemRequester} title={item.fromEmail ?? undefined}>{item.fromEmail?.trim() || "Unknown sender"}</span>
                  <span className={styles.itemMeta}>{item.decidedBy === "llm" ? "Classifier" : "Blocklist"}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <section className={styles.detailPane} aria-label="Dropped email preview">
        {selectedMail ? (
          <DroppedMailPreview mail={selectedMail} />
        ) : (
          <EmptyDetail title="Select an email to review the message." body="Dropped mail is not a ticket until Add as ticket is used." />
        )}
      </section>

      <aside className={styles.contextPane} aria-label="Classification context">
        {selectedMail ? (
          <DroppedMailContext mail={selectedMail} onPromote={onPromote} pendingId={pendingId} />
        ) : (
          <EmptyDetail title="No email selected" body="Verdict, reason and the Add as ticket action appear here." />
        )}
      </aside>
    </div>
  );
}

function DroppedMailPreview({ mail }: { mail: DroppedMail }) {
  const expired = !mail.body && Boolean(mail.bodyCapturedAt);
  return (
    <div className={styles.detailFrame}>
      <header className={styles.ticketHeader}>
        <div className={styles.ticketHeaderText}>
          <h2 title={mail.subject ?? undefined}>{mail.subject?.trim() || "(no subject)"}</h2>
          <p>{mail.fromEmail?.trim() || "Unknown sender"}{mail.decidedAt ? ` - dropped ${formatRelativeTime(mail.decidedAt)}` : ""}</p>
        </div>
      </header>
      <div className={styles.conversationArea}>
        {mail.failedOpen && (
          <p className={styles.blocked} role="note">
            The classifier failed on this email. The fallback decision should be read as fallback, not as a judgement about the message.
          </p>
        )}
        {mail.body ? (
          <pre className={styles.messageBody}>
            <TrackingText text={mail.body} parcels={mail.parcels} />
          </pre>
        ) : expired ? (
          <p className={styles.placeholder}>The text has passed its retention window and was deleted. The decision record is kept.</p>
        ) : (
          <p className={styles.placeholder}>No text was captured for this email. The decision record is all that can be shown here.</p>
        )}
      </div>
    </div>
  );
}

function DroppedMailContext({
  mail,
  onPromote,
  pendingId,
}: {
  mail: DroppedMail;
  onPromote: (mail: DroppedMail) => void;
  pendingId: string | null;
}) {
  return (
    <div className={styles.contextScroll}>
      <ContextSection title="Verdict">
        <InfoList
          rows={[
            ["Verdict", mail.label ?? "Blocklisted"],
            ["Decided by", mail.decidedBy === "llm" ? "Classifier" : "Blocklist"],
            ["Decided", formatRelativeTime(mail.decidedAt) || null],
          ]}
        />
      </ContextSection>
      <ContextSection title="Reason">
        <p className={styles.actionText}>{mail.reason}</p>
      </ContextSection>
      <ContextSection title="Required action">
        <Button
          size="sm"
          variant="primary"
          block
          disabled={!mail.body}
          loading={pendingId === mail.id}
          onClick={() => onPromote(mail)}
          title={
            mail.body
              ? "Thread this email into a ticket and let the agent read it."
              : "The text of this email is not stored, so there is nothing for the agent to read into a ticket."
          }
        >
          Add as ticket
        </Button>
        <p className={styles.stamp}>Threads this email into the queue. The gate decision record is kept.</p>
      </ContextSection>
    </div>
  );
}

function EmptyDetail({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.emptyDetail}>
      <ClockIcon size={18} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function CompactEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.compactEmpty}>
      <p className={styles.emptyTitle}>{title}</p>
      <p>{body}</p>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label="Loading conversation">
      <span className={styles.skeletonLine} />
      <span className={styles.skeletonBlock} />
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonBlock} />
    </div>
  );
}

function DraftSkeleton() {
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label="Loading draft">
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonBlockSmall} />
    </div>
  );
}

function ContextSkeleton() {
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label="Loading context">
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonLine} />
      <span className={styles.skeletonLineShort} />
    </div>
  );
}
