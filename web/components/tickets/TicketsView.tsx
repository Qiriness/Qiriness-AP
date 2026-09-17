"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
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
  TicketPolicy,
  KnowledgeCategory,
  TicketAttachmentFile,
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
  /** The page's query string: which tab, filters and ticket to open on. */
  initialParams?: Record<string, string | string[] | undefined>;
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

/* The draft/conversation split. `null` means the CSS default (35% of the pane);
   a number is a height the reviewer dragged to, kept per browser. */
const DRAFT_HEIGHT_KEY = "tickets.draftPanelHeight";
const MIN_DRAFT_HEIGHT = 120;
const MIN_CONVERSATION_HEIGHT = 80;
const DRAFT_HANDLE_HEIGHT = 8;
const DRAFT_KEY_STEP = 32;

function readDraftHeight(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(DRAFT_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_DRAFT_HEIGHT ? stored : null;
  } catch {
    return null;
  }
}

function writeDraftHeight(height: number | null) {
  try {
    if (height === null) window.localStorage.removeItem(DRAFT_HEIGHT_KEY);
    else window.localStorage.setItem(DRAFT_HEIGHT_KEY, String(height));
  } catch {
    // Storage blocked: the split still works, it just is not remembered.
  }
}

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

/* Where the reviewer was — tab, filters, search and the open ticket — kept in the
   address so Back, refresh and a pasted link land on the same ticket, and in
   sessionStorage so the sidebar's bare /tickets link does too. */
const LEVEL_FILTERS: readonly LevelFilter[] = ["all", "4", "3", "2", "1", "uncategorised"];
const SENDER_FILTERS = ["all", "consumer", "business"] as const;
type SenderFilter = (typeof SENDER_FILTERS)[number];
const TICKET_VIEWS = Object.keys(VIEW_LABELS) as TicketView[];
const SORT_ORDERS = Object.keys(SORT_LABELS) as SortOrder[];
const CATEGORY_FILTERS: readonly (KnowledgeCategory | "all")[] = ["all", ...TICKET_CATEGORIES];
const STATE_PARAMS = ["view", "q", "level", "category", "sender", "sort", "ticket", "mail"];
const LAST_TICKETS_SEARCH_KEY = "tickets.lastSearch";
const EMPTY_QUERIES: Record<TicketView, string> = { queue: "", backlog: "", irrelevant: "", closed: "" };

interface TicketsPageState {
  view: TicketView;
  query: string;
  level: LevelFilter;
  category: KnowledgeCategory | "all";
  sender: SenderFilter;
  sort: SortOrder;
  ticketId: string | null;
  mailId: string | null;
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toSearchParams(record: Record<string, string | string[] | undefined> | undefined): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}

function hasPageState(params: URLSearchParams): boolean {
  return STATE_PARAMS.some((key) => params.has(key));
}

function parsePageState(params: URLSearchParams): TicketsPageState {
  return {
    view: pick(params.get("view"), TICKET_VIEWS, "queue"),
    query: params.get("q") ?? "",
    level: pick(params.get("level"), LEVEL_FILTERS, "all"),
    category: pick(params.get("category"), CATEGORY_FILTERS, "all"),
    sender: pick(params.get("sender"), SENDER_FILTERS, "all"),
    sort: pick(params.get("sort"), SORT_ORDERS, "priority"),
    ticketId: params.get("ticket") || null,
    mailId: params.get("mail") || null,
  };
}

/** Defaults are left out, so an untouched page is plain /tickets. */
function serialisePageState(state: TicketsPageState): string {
  const params = new URLSearchParams();
  if (state.view !== "queue") params.set("view", state.view);
  if (state.query.trim()) params.set("q", state.query);
  if (state.level !== "all") params.set("level", state.level);
  if (state.category !== "all") params.set("category", state.category);
  if (state.sender !== "all") params.set("sender", state.sender);
  if (state.sort !== "priority") params.set("sort", state.sort);
  if (state.ticketId) params.set("ticket", state.ticketId);
  if (state.mailId) params.set("mail", state.mailId);
  const search = params.toString();
  return search ? `?${search}` : "";
}

function passesFilters(
  ticket: TicketListItem,
  level: LevelFilter,
  category: KnowledgeCategory | "all",
  sender: SenderFilter
): boolean {
  if (level === "uncategorised" && ticket.level !== null) return false;
  if (level !== "all" && level !== "uncategorised" && String(ticket.level) !== level) return false;
  // Either axis: a ticket that is also about B2B belongs under B2B, and hiding it
  // there because the categoriser led with `order` is how it gets missed.
  if (category !== "all" && ticket.category !== category && ticket.secondaryCategory !== category) {
    return false;
  }
  if (sender === "consumer" && ticket.senderLabel) return false;
  if (sender === "business" && !ticket.senderLabel) return false;
  return true;
}

function viewOfTicket(ticket: TicketListItem): TicketView {
  if (isClosed(ticket)) return "closed";
  return isBacklogTicket(ticket) ? "backlog" : "queue";
}

/**
 * A saved ticket may have moved since it was saved: closed by someone, aged into
 * Backlog, or hidden by the filters it was saved with. Follow it to the tab that
 * holds it now and drop whichever filter would hide it, rather than restore an
 * empty panel. A ticket that is gone from this page altogether is let go.
 */
function reconcilePageState(
  state: TicketsPageState,
  tickets: TicketListItem[],
  dropped: DroppedMail[]
): TicketsPageState {
  const next = { ...state };

  if (next.ticketId) {
    const ticket = tickets.find((row) => row.id === next.ticketId);
    if (ticket) {
      next.view = viewOfTicket(ticket);
      next.mailId = null;
      // Level, category and sender filter Queue and Backlog only; Closed is unfiltered.
      if (next.view !== "closed" && !passesFilters(ticket, next.level, next.category, next.sender)) {
        next.level = "all";
        next.category = "all";
        next.sender = "all";
      }
      if (!matchesTicket(ticket, next.query)) next.query = "";
      return next;
    }
    next.ticketId = null;
  }

  if (next.mailId) {
    const mail = dropped.find((row) => row.id === next.mailId);
    if (mail) {
      next.view = "irrelevant";
      if (!matchesDroppedMail(mail, next.query)) next.query = "";
    } else {
      next.mailId = null;
    }
  }

  return next;
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

export function TicketsView({ initialTickets, droppedMail, loadError, initialParams }: TicketsViewProps) {
  const [initialState] = useState(() =>
    reconcilePageState(parsePageState(toSearchParams(initialParams)), initialTickets, droppedMail)
  );
  // False until a bare /tickets has had its chance to restore this tab's last
  // address, so the defaults cannot overwrite what was saved before it is read.
  const [restored, setRestored] = useState(() => hasPageState(toSearchParams(initialParams)));
  const [tickets, setTickets] = useState(initialTickets);
  const [dropped, setDropped] = useState(droppedMail);
  const [activeView, setActiveView] = useState<TicketView>(initialState.view);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(initialState.ticketId);
  const [selectedDroppedId, setSelectedDroppedId] = useState<string | null>(initialState.mailId);
  const [queryByView, setQueryByView] = useState<Record<TicketView, string>>({
    ...EMPTY_QUERIES,
    [initialState.view]: initialState.query,
  });
  const [level, setLevel] = useState<LevelFilter>(initialState.level);
  const [category, setCategory] = useState<KnowledgeCategory | "all">(initialState.category);
  const [sender, setSender] = useState<SenderFilter>(initialState.sender);
  const [sort, setSort] = useState<SortOrder>(initialState.sort);
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
    const filtered = openTickets.filter((ticket) => passesFilters(ticket, level, category, sender));

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

  // A bare /tickets — which is what the sidebar link opens — picks up where this
  // browser tab left off. Runs once: it answers how the page was opened.
  useEffect(() => {
    if (restored) return;
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(LAST_TICKETS_SEARCH_KEY);
    } catch {
      // Storage blocked: start from the defaults.
    }
    if (saved) {
      const next = reconcilePageState(parsePageState(new URLSearchParams(saved)), initialTickets, droppedMail);
      setActiveView(next.view);
      setQueryByView({ ...EMPTY_QUERIES, [next.view]: next.query });
      setLevel(next.level);
      setCategory(next.category);
      setSender(next.sender);
      setSort(next.sort);
      setSelectedTicketId(next.ticketId);
      setSelectedDroppedId(next.mailId);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The selection is written from what is actually shown, so a ticket a filter
  // has since hidden does not linger in the address.
  const pageSearch = restored
    ? serialisePageState({
        view: activeView,
        query: queryByView[activeView],
        level,
        category,
        sender,
        sort,
        ticketId: selectedTicket?.id ?? null,
        mailId: selectedDropped?.id ?? null,
      })
    : null;

  useEffect(() => {
    if (pageSearch === null) return;
    // replaceState, not a push: filtering should not fill the Back button.
    if (window.location.search !== pageSearch) {
      window.history.replaceState(null, "", `${window.location.pathname}${pageSearch}`);
    }
    try {
      window.sessionStorage.setItem(LAST_TICKETS_SEARCH_KEY, pageSearch);
    } catch {
      // Storage blocked: the address still holds the state, it is just not
      // restored from the sidebar link.
    }
  }, [pageSearch]);

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
                    <span className={styles.vipInline} title="VIP customer — by the rule set on Insights → Customers">
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
  const frameRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [draftHeight, setDraftHeight] = useState<number | null>(readDraftHeight);

  // The panel may take everything except the header and a strip of conversation,
  // so the thread can be squeezed but never pushed off screen entirely.
  function clampDraftHeight(height: number): number {
    const frame = frameRef.current;
    const header = headerRef.current;
    if (!frame) return height;
    const max = frame.clientHeight - (header?.offsetHeight ?? 0) - MIN_CONVERSATION_HEIGHT - DRAFT_HANDLE_HEIGHT;
    return Math.round(Math.max(MIN_DRAFT_HEIGHT, Math.min(height, max)));
  }

  function commitDraftHeight(height: number | null) {
    setDraftHeight(height);
    writeDraftHeight(height);
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const frame = frameRef.current;
    if (!frame || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const bottom = frame.getBoundingClientRect().bottom;
    let latest = draftHeight;

    const move = (moveEvent: PointerEvent) => {
      latest = clampDraftHeight(bottom - moveEvent.clientY - DRAFT_HANDLE_HEIGHT / 2);
      setDraftHeight(latest);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = "";
      writeDraftHeight(latest);
    };

    document.body.style.userSelect = "none";
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function nudgeDraftHeight(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = draftHeight ?? frameRef.current?.querySelector<HTMLElement>(`.${styles.draftPanel}`)?.offsetHeight ?? MIN_DRAFT_HEIGHT;
    if (event.key === "ArrowUp") commitDraftHeight(clampDraftHeight(current + DRAFT_KEY_STEP));
    else if (event.key === "ArrowDown") commitDraftHeight(clampDraftHeight(current - DRAFT_KEY_STEP));
    else if (event.key === "Home" || event.key === "Enter") commitDraftHeight(null);
    else return;
    event.preventDefault();
  }

  return (
    <div className={styles.detailFrame} ref={frameRef}>
      <header className={styles.ticketHeader} ref={headerRef}>
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

      {/* Drag up to read more of the draft, down to read more of the thread.
          Double-click (or Enter) returns to the default split. */}
      <div
        className={styles.draftHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the draft panel"
        aria-valuenow={draftHeight ?? undefined}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={() => commitDraftHeight(null)}
        onKeyDown={nudgeDraftHeight}
      />

      <DraftResponsePanel
        height={draftHeight}
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
  height,
  ticket,
  thread,
  error,
  onDraftChange,
  detail,
  detailError,
}: {
  height: number | null;
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
    <section
      className={`${styles.draftPanel} ${height !== null ? styles.draftPanelSized : ""}`}
      style={height !== null ? { height, maxHeight: "none" } : undefined}
      aria-label="AI draft"
    >
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
            <>
              <textarea
                className={styles.editor}
                value={edited}
                onChange={(event) => setEdited(event.target.value)}
                rows={Math.min(18, Math.max(7, edited.split(NEWLINE).length + 2))}
                aria-label="Edit the drafted reply"
              />
              {draft.replyLink && (
                <p className={styles.related}>
                  Keep the word in [[double brackets]] where the link to {draft.replyLink.label} goes — it
                  becomes the link.
                </p>
              )}
            </>
          ) : (
            <pre className={styles.draftBody}>
              <TrackingText text={draft.body} parcels={thread.parcels} link={draft.replyLink} />
            </pre>
          )}

          {draft.approvedBody && (
            <div className={styles.reviewerVersion}>
              <h4>Reviewer version</h4>
              <pre className={styles.draftBody}>
                <TrackingText text={draft.approvedBody} parcels={thread.parcels} link={draft.replyLink} />
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
            ["Shopify segment", ticket.rfmGroup],
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

      {/* ABSENT ON MOST TICKETS. 310 of 400 carry no attachment and no mention of
          one, so a permanent "Attachments — none" heading would push the
          sections above it off a pane that already scrolls. */}
      <AttachmentsSection detail={detail} error={error} />

      {/* LAST, because it answers "why does this say what it says" rather than
          "what does it say" — an operator reads the verdict and the action
          first, and comes here when one of them surprises them. */}
      <PolicySection policy={detail?.policy ?? null} />
    </div>
  );
}

/** How the situation was reached, in the reader's words rather than a number. */
const MATCH_WORDS: Record<string, (policy: TicketPolicy) => string> = {
  matched: (policy) => `matched ${score(policy.similarity)}`,
  near: (policy) => `near miss ${score(policy.similarity)}, chosen by the agent`,
  ambiguous: (policy) => `two situations too close to call ${score(policy.similarity)}`,
  none: (policy) => `nothing close enough ${score(policy.similarity)}`,
};

const score = (similarity: number | null) =>
  similarity === null ? "" : `(${similarity.toFixed(2)})`;

/**
 * Which situation the run settled on, and which rule its findings selected.
 *
 * NOTHING SHOWED THIS BEFORE. `exemplar_match` is written on every run and was
 * read by no screen a person opens, so a rule shaped somebody's mail with no
 * trace anywhere — and "answerable because a rule said so" looked exactly like
 * "answerable, and no rule matched at all".
 *
 * SHOWN EVEN WHEN NOTHING MATCHED, unlike the attachments block above it. A
 * ticket no rule answered is precisely the case worth seeing: it is a gap in the
 * rulebook, and it is otherwise invisible until somebody reads a transcript.
 *
 * THE KEYS ARE RAW (`PR-29`, `pr29_equivalent_partiel`) because they are what
 * the rulebook screen is searched by; a prettified label would have to be
 * translated back before anybody could act on it.
 */
function PolicySection({ policy }: { policy: TicketPolicy | null }) {
  // No investigation ran: there is no decision to explain, and an empty heading
  // would read as one that was made badly.
  if (!policy) {
    return null;
  }
  const matchWord = policy.match ? MATCH_WORDS[policy.match]?.(policy) : null;
  const asked = [
    policy.route ? `route to ${policy.route.replace(/_/g, " ")}` : null,
    policy.asks.length > 0 ? `ask for ${policy.asks.join(", ").replace(/_/g, " ")}` : null,
    policy.offerCode ? `offer ${policy.offerCode}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ContextSection title="Situation & rule">
      <InfoList
        rows={[
          [
            "Situation",
            [
              policy.situation ?? "None settled",
              matchWord,
              // The closest exemplar is worth seeing even when it lost: one that
              // keeps coming second is the situation missing from the corpus.
              !policy.situation && policy.closest ? `closest ${policy.closest}` : null,
            ]
              .filter(Boolean)
              .join(" — "),
          ],
          [
            "Rule",
            policy.rule
              ? [
                  policy.rule,
                  policy.changedVerdict ? "changed the verdict" : "verdict unchanged",
                  policy.ruleVerdict && policy.ruleVerdict !== "selected" ? policy.ruleVerdict : null,
                ]
                  .filter(Boolean)
                  .join(" — ")
              : "No rule matched",
          ],
          ["It asked for", asked || null],
        ]}
      />
    </ContextSection>
  );
}

/**
 * What the customer attached, at the bottom of the context rail.
 *
 * TWO THINGS WORTH SHOWING, and they are not the same thing. A ticket that
 * CARRIES a photo (15 in the corpus) is one where a person should look at it —
 * so the photo is shown, proxied from the mailbox and stored nowhere. A ticket
 * that MENTIONS one and carries nothing (74, nearly five times more) is
 * invisible today: the operator reads « vous trouverez la photo ci-jointe »,
 * goes looking in Outlook, and finds the same nothing.
 *
 * The images and the verdict both come from `detail.attachments`, derived by
 * `scripts/lib/photo-evidence-rules.mjs` — the same module the investigation
 * scores `photo_evidence` with, so the rail and the case file cannot disagree
 * about whether a photo arrived.
 */
function AttachmentsSection({
  detail,
  error,
}: {
  detail: TicketDetail | null;
  error: string | null;
}) {
  const attachments = detail?.attachments ?? null;
  if (error || !attachments) return null;

  const { images, others, furniture, known, mentioned, matchedTerm } = attachments;
  const missing = mentioned && images.length === 0;
  if (images.length === 0 && others.length === 0 && !missing && known) return null;

  return (
    <ContextSection title="Attachments">
      {missing && (
        <p className={styles.attachmentWarning}>
          The customer mentions a photo
          {matchedTerm ? <> (“{matchedTerm}”)</> : null} but nothing image-shaped arrived.
        </p>
      )}

      {!known && (
        /* The `attachments` column's null, surfaced. Saying "no photo" about a
           message whose own flag says otherwise is the one wrong answer here. */
        <p className={styles.muted}>
          Something is attached, but its type was never recorded — this thread was ingested
          before attachment metadata was fetched.
        </p>
      )}

      {images.length > 0 && (
        <ul className={styles.photoGrid}>
          {images.map((file, index) => (
            <li key={`${file.name ?? "image"}-${index}`}>
              <AttachmentPhoto file={file} />
              <span className={styles.photoCaption}>
                {file.name ?? "Unnamed image"} · {describeAttachment(file)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <ul className={styles.attachmentFiles}>
          {others.map((file, index) => (
            <li key={`${file.name ?? "file"}-${index}`}>
              {file.name ?? "Unnamed file"} · {describeAttachment(file)}
            </li>
          ))}
        </ul>
      )}

      {furniture > 0 && (
        <p className={styles.muted}>
          {furniture} inline image{furniture === 1 ? "" : "s"} ignored (signature logos and
          placeholders).
        </p>
      )}
    </ContextSection>
  );
}

/**
 * The photo, proxied from the mailbox.
 *
 * A PLAIN `<img>` AND NOT `next/image`: the optimiser would fetch this URL from
 * the Next server and cache the result on disk, putting customers' photos in
 * `.next/cache` with no retention rule attached — the exact property the proxy
 * exists to keep.
 *
 * THE ERROR STATE IS THE POINT. The bytes live in a mailbox this app does not
 * control, and mail leaves it: 2 of the 37 stored photo parts are already gone.
 * `onError` turns that into a sentence rather than a broken-image glyph, which
 * tells an operator nothing about whether Outlook is worth opening.
 */
function AttachmentPhoto({ file }: { file: TicketAttachmentFile }) {
  const [failed, setFailed] = useState(false);

  if (!file.src || failed) {
    return (
      <span className={styles.photoMissing}>
        Not available — the message may have left the mailbox.
      </span>
    );
  }

  return (
    <a href={file.src} target="_blank" rel="noreferrer" className={styles.photoLink}>
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        className={styles.photoThumb}
        src={file.src}
        alt={file.name ?? "Photo attached by the customer"}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

/** "JPEG · 820 KB" — the two things that separate a phone photo from a logo. */
function describeAttachment(file: TicketAttachmentFile): string {
  const subtype = file.contentType?.split("/")[1]?.toUpperCase() ?? null;
  const size = formatAttachmentBytes(file.size);
  return [subtype, size].filter(Boolean).join(" · ");
}

/** Bytes as a person reads them. 0 means Graph did not record a size. */
function formatAttachmentBytes(size: number): string | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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
      {!candidate && order.buyerUnverified && (
        <p className={styles.candidateNote}>
          {order.channel ?? "Marketplace"} order with an anonymous buyer: linked on the order number alone, the buyer could not be checked.
        </p>
      )}
      <InfoList
        rows={[
          [candidate ? "Last order" : "Order", order.orderName],
          // Named here as well as in the detail panel: this block is the one a
          // reviewer reads first, and a marketplace order changes how the
          // status and tracking lines under it should be read. Null on a web
          // order, and `InfoList` drops a null row.
          ["Sales channel", order.channel],
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
