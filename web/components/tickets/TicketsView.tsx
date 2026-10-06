"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  CrownIcon,
  MailInIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SparkleIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatNumber } from "@/lib/i18n/format";
import { intlTag, type Locale } from "@/lib/i18n/locales";
import type { Translate } from "@/lib/i18n/translate";
import { TrackingText } from "@/components/ui/TrackingText";
import { ATTACHMENT_REASON_KEYS, fetchAttachmentReasonKey } from "@/lib/attachment-reasons";
import { promoteDroppedMail } from "@/lib/api/dropped-mail";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import {
  awaitingDelivery,
  autoSendHoldLines,
  awaitingWorker,
  canComposeReply,
  decisionLabel,
  deliveredLine,
  handedOffNotice,
  manualReplyLine,
  outboundLine,
  replyDelivered,
  replyInFlight,
} from "@/lib/draft-outbound";
import { actOnObligation, decideOnDraft, fetchTicketDetail, fetchTicketThread, saveTicketOverrides, sendManualReply, setTicketStatus } from "@/lib/api/tickets";
import { replyHtmlIsEmpty, textToReplyHtml } from "@/lib/reply-html";
import { ReplyEditor, ReplyHtmlView } from "./ReplyEditor";
import { SnoozeBanner, SnoozeChip, SnoozeControl, type SnoozeChange } from "./SnoozeControl";
import { ForwardingBanner, ForwardingChip } from "./ForwardingTag";
import { NO_DELAYS, isSnoozed, type SnoozeDelays } from "@/lib/snooze";
import { formatRelativeTime } from "@/lib/relative-time";
import { isBacklogTicket, isClosed, summariseTickets } from "@/lib/ticket-stats";
import type {
  CaseActor,
  TicketCaseChange,
  TicketCaseState,
  TicketObligation,
  DroppedMail,
  InvestigationVerdict,
  TicketPolicy,
  KnowledgeCategory,
  TicketAttachmentFile,
  TicketDetail,
  TicketDraft,
  TicketManualReply,
  TicketListItem,
  TicketMessage,
  TicketOrderChange,
  TicketOrderFacts,
  TicketOrderLinkSource,
  TicketOverride,
  TicketOverrideChanges,
  TicketOverrideField,
  TicketOverrideResult,
  TicketPriorityBand,
  TicketSituationOption,
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
import { OrderLinkDialog } from "./OrderLinkDialog";
import { LevelChip } from "./LevelChip";
import styles from "./TicketsView.module.css";

interface TicketsViewProps {
  initialTickets: TicketListItem[];
  droppedMail: DroppedMail[];
  /** Every row of the Irrelevant list, of which `droppedMail` is the first page. */
  droppedTotal?: number;
  /** Blocked emails cleared shop-wide: what « restore » brings back. */
  clearedMailCount?: number;
  /**
   * Closed threads the page did not load. Given, the Closed tab reads them when
   * first opened; absent, `initialTickets` already holds them.
   */
  closedCount?: number;
  loadError: string | null;
  /** Rendered on the server at the header's right: the freshness pills. */
  headerAside?: ReactNode;
  /** The shop's delay per party, for « Snooze until the customer replies ». */
  snoozeDelays?: SnoozeDelays;
  /** The page's query string: which tab, filters and ticket to open on. */
  initialParams?: Record<string, string | string[] | undefined>;
}

type LevelFilter = "all" | "4" | "3" | "2" | "1" | "uncategorised";
type SortOrder = "priority" | "recent" | "oldest" | "severity";
type TicketView = "queue" | "backlog" | "snoozed" | "irrelevant" | "closed";

// Labels come from the dictionary: `tickets.view.sort.<key>`, `tickets.view.tab.<key>`
// and `tickets.view.verdict.<key>`.


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
const TICKET_VIEWS: TicketView[] = ["queue", "backlog", "snoozed", "irrelevant", "closed"];
const SORT_ORDERS: SortOrder[] = ["priority", "recent", "oldest", "severity"];
const CATEGORY_FILTERS: readonly (KnowledgeCategory | "all")[] = ["all", ...TICKET_CATEGORIES];
const STATE_PARAMS = ["view", "q", "level", "category", "sender", "sort", "ticket", "mail"];
const LAST_TICKETS_SEARCH_KEY = "tickets.lastSearch";
/**
 * Dropped mail somebody has finished with, hidden from the Irrelevant list.
 *
 * IN THE BROWSER, NOT THE DATABASE. `spam_audit` records what the gate decided
 * and is never written to from the dashboard — promotion is derived rather than
 * stamped for that reason (see dropped-mail-service). Clearing is a weaker
 * statement still: not "this decision was wrong" but "I have read this one", so
 * it has no business editing the audit trail. The rows themselves age out on
 * their own clock, so this list is hiding what is already on its way out.
 *
 * The cost is stated rather than hidden: this is per browser. Another machine,
 * another profile, or cleared site data shows the full list again, and nothing
 * here is visible to the worker or to anybody else.
 */
const CLEARED_MAIL_KEY = "tickets.clearedMail";
const EMPTY_QUERIES: Record<TicketView, string> = { queue: "", backlog: "", snoozed: "", irrelevant: "", closed: "" };

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
  if (isSnoozed(ticket)) return "snoozed";
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
      // Level, category and sender filter Queue and Backlog only; Snoozed and Closed are unfiltered.
      if (next.view !== "closed" && next.view !== "snoozed" && !passesFilters(ticket, next.level, next.category, next.sender)) {
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

function ticketTitle(ticket: TicketListItem, t: Translate): string {
  return ticket.subject?.trim() || t("tickets.view.noSubject");
}

function requesterName(ticket: TicketListItem, t: Translate): string {
  return ticket.customerName?.trim() || ticket.requesterName?.trim() || t("tickets.view.unknownRequester");
}

function ticketAge(ticket: TicketListItem, t: Translate): string {
  return formatRelativeTime(ticket.lastMessageAt ?? ticket.firstMessageAt, t) || "-";
}

function priorityLabel(ticket: TicketListItem, t: Translate): string {
  return t(`tickets.view.priority.${ticket.priorityBand === "high" || ticket.priorityBand === "medium" ? ticket.priorityBand : "low"}`);
}

function statusClass(ticket: TicketListItem): string {
  if (ticket.status === "awaiting_human") return styles.statusWarning;
  if (ticket.status === "awaiting_customer" || ticket.status === "forwarded") return styles.statusInfo;
  if (isClosed(ticket)) return styles.statusDone;
  return styles.statusNeutral;
}

export function TicketsView({
  initialTickets,
  droppedMail,
  droppedTotal: initialDroppedTotal,
  clearedMailCount = 0,
  closedCount,
  loadError,
  initialParams,
  headerAside,
  snoozeDelays = NO_DELAYS,
}: TicketsViewProps) {
  const t = useT();
  const locale = useLocale();
  const [initialState] = useState(() =>
    reconcilePageState(parsePageState(toSearchParams(initialParams)), initialTickets, droppedMail)
  );
  // False until a bare /tickets has had its chance to restore this tab's last
  // address, so the defaults cannot overwrite what was saved before it is read.
  const [restored, setRestored] = useState(() => hasPageState(toSearchParams(initialParams)));
  const [tickets, setTickets] = useState(initialTickets);
  const [dropped, setDropped] = useState(droppedMail);
  // THE IRRELEVANT LIST IS PAGED IN THE DATABASE (78_dropped_mail_list.sql):
  // `dropped` holds the pages loaded so far, the total is the server's.
  const [droppedTotal, setDroppedTotal] = useState(initialDroppedTotal ?? droppedMail.length);
  const [clearedTotal, setClearedTotal] = useState(clearedMailCount);
  const [moreLoading, setMoreLoading] = useState(false);
  // CLOSED THREADS ARE READ WHEN THE TAB OPENS. "loaded" from the start when the
  // page gave every row, as it did before 2026-10-06.
  const [closedState, setClosedState] = useState<"idle" | "loading" | "loaded" | "failed">(
    closedCount === undefined ? "loaded" : "idle"
  );
  const [initialClosedIds] = useState(() => new Set(initialTickets.filter(isClosed).map((ticket) => ticket.id)));
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
  // One row per case (61_cases.sql): another thread of a case is hidden behind
  // its lead unless asked for. Off by default, never stored.
  const [showLinkedThreads, setShowLinkedThreads] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [thread, setThread] = useState<TicketThread | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  // Irrelevant only: which dropped mail is hidden, and the select-and-clear
  // mode that hides it. Starts empty on both the server and the first client
  // render — `localStorage` is read in an effect below, because this component
  // renders on the server too and reading storage there throws.
  const [selectingMail, setSelectingMail] = useState(false);
  const [pickedMailIds, setPickedMailIds] = useState<string[]>([]);

  const stats = useMemo(() => summariseTickets(tickets), [tickets]);
  // Queue and Backlog: live and not snoozed. A snoozed ticket waits in its own tab.
  const openTickets = useMemo(
    () => tickets.filter((ticket) => !isClosed(ticket) && !isSnoozed(ticket) && (showLinkedThreads || ticket.isCaseLead !== false)),
    [tickets, showLinkedThreads]
  );

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
  // Earliest closure first. A row with no close time (closed before the column
  // was kept) sorts by its last message.
  const closedBase = useMemo(() => {
    const closedAt = (ticket: TicketListItem) => Date.parse(ticket.closedAt ?? ticket.lastMessageAt ?? "") || 0;
    return tickets.filter(isClosed).sort((a, b) => closedAt(a) - closedAt(b));
  }, [tickets]);
  // Soonest back first: the top of the tab is what returns next.
  const snoozedBase = useMemo(
    () =>
      tickets
        .filter((ticket) => !isClosed(ticket) && isSnoozed(ticket))
        .sort((a, b) => Date.parse(a.snooze?.wakeAt ?? "") - Date.parse(b.snooze?.wakeAt ?? "")),
    [tickets]
  );
  const pickedMail = useMemo(() => new Set(pickedMailIds), [pickedMailIds]);
  // Cleared and promoted mail never reaches the page: the database view leaves
  // it out, and a search is run there too, so what is loaded is what is shown.
  const droppedBase = dropped;
  const clearedCount = clearedTotal;

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
  const snoozed = useMemo(
    () => snoozedBase.filter((ticket) => matchesTicket(ticket, queryByView.snoozed)),
    [snoozedBase, queryByView.snoozed]
  );
  const visibleDropped = droppedBase;

  const activeTickets =
    activeView === "queue"
      ? queue
      : activeView === "backlog"
        ? backlog
        : activeView === "snoozed"
          ? snoozed
          : activeView === "closed"
            ? closed
            : [];
  const selectedTicket = activeTickets.find((ticket) => ticket.id === selectedTicketId) ?? null;
  const selectedDropped = activeView === "irrelevant"
    ? visibleDropped.find((mail) => mail.id === selectedDroppedId) ?? null
    : null;

  // KEYED ON THE ID, not the row. Linking an order, acting on the case or
  // snoozing replaces the row object, and each of those handlers already sets
  // what changed; reloading on the object threw that away and read the whole
  // detail and thread again for the same ticket.
  const selectedTicketKey = selectedTicket?.id ?? null;
  useEffect(() => {
    if (!selectedTicketKey) {
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

    fetchTicketDetail(selectedTicketKey)
      .then((loaded) => {
        if (live) setDetail(loaded);
      })
      .catch((cause) => {
        if (live) setDetailError(knowledgeErrorMessage(cause));
      });

    fetchTicketThread(selectedTicketKey)
      .then((loaded) => {
        if (live) setThread(loaded);
      })
      .catch((cause) => {
        if (live) setThreadError(knowledgeErrorMessage(cause));
      });

    return () => {
      live = false;
    };
  }, [selectedTicketKey]);

  // GREY UNTIL IT LANDS. An approved draft, or a person's own reply, waits on
  // the worker; the page looks again until it has reached the mailbox, so the
  // draft steps aside (and « Create draft » appears) without a reload. One
  // thread read, and only while something is actually waiting: 15 s apart at
  // first, then further apart up to a minute, and never while the browser tab is
  // hidden. A reply left waiting in a background tab used to read the whole
  // thread four times a minute until somebody came back.
  const waiting = awaitingWorker(thread);
  const waitingTicketId = waiting ? thread?.ticketId ?? null : null;
  useEffect(() => {
    if (!waitingTicketId) return;
    let live = true;
    let delay = 15_000;
    let timer: number | undefined;
    const look = () => {
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(look, delay);
        return;
      }
      fetchTicketThread(waitingTicketId)
        .then((loaded) => {
          if (live) setThread((current) => (current?.ticketId === loaded.ticketId ? loaded : current));
        })
        .catch(() => {
          // A missed look is harmless; the next one tries again.
        })
        .finally(() => {
          if (!live) return;
          delay = Math.min(delay * 2, 60_000);
          timer = window.setTimeout(look, delay);
        });
    };
    timer = window.setTimeout(look, delay);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [waitingTicketId]);

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
      const parsed = parsePageState(new URLSearchParams(saved));
      const apply = (rows: TicketListItem[]) => {
        const next = reconcilePageState(parsed, rows, droppedMail);
        setActiveView(next.view);
        setQueryByView({ ...EMPTY_QUERIES, [next.view]: next.query });
        setLevel(next.level);
        setCategory(next.category);
        setSender(next.sender);
        setSort(next.sort);
        setSelectedTicketId(next.ticketId);
        setSelectedDroppedId(next.mailId);
      };
      // A saved ticket this page did not load is probably closed: read the
      // Closed tab's threads, then restore against them.
      if (parsed.ticketId && !initialTickets.some((ticket) => ticket.id === parsed.ticketId) && closedState !== "loaded") {
        void loadClosed().then((rows) => apply(rows.length ? rows : initialTickets));
        setRestored(true);
        return;
      }
      const next = reconcilePageState(parsed, initialTickets, droppedMail);
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

  // CLEARS USED TO LIVE IN THIS BROWSER (localStorage), so the server sent every
  // cleared row anyway. Whatever an older version of the page left there is
  // moved to the shop's record once, then the key is removed.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(CLEARED_MAIL_KEY);
    } catch {
      return;
    }
    if (!saved) return;
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      // Unparseable: nothing to move.
    }
    const forget = () => {
      try {
        window.localStorage.removeItem(CLEARED_MAIL_KEY);
      } catch {
        // Storage blocked: tried again on the next visit.
      }
    };
    if (ids.length === 0) {
      forget();
      return;
    }
    fetch("/api/dropped-mail/clears", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
      .then((response) => {
        if (!response.ok) return;
        forget();
        return reloadDropped(queryByView.irrelevant);
      })
      .catch(() => {
        // Kept in storage and tried again on the next visit.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One page of the Irrelevant list from the server, for this search. */
  async function fetchDroppedPage(offset: number, q: string) {
    const response = await fetch(`/api/dropped-mail?offset=${offset}&q=${encodeURIComponent(q)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as { items: DroppedMail[]; total: number; cleared: number };
  }

  /** The list again from its first page: after a search, a clear or a restore. */
  async function reloadDropped(q: string) {
    const page = await fetchDroppedPage(0, q);
    setDropped(page.items);
    setDroppedTotal(page.total);
    setClearedTotal(page.cleared);
  }

  async function loadMoreDropped() {
    if (moreLoading) return;
    setMoreLoading(true);
    try {
      const page = await fetchDroppedPage(dropped.length, queryByView.irrelevant);
      setDropped((current) => {
        const have = new Set(current.map((mail) => mail.id));
        return [...current, ...page.items.filter((mail) => !have.has(mail.id))];
      });
      setDroppedTotal(page.total);
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
    } finally {
      setMoreLoading(false);
    }
  }

  // THE SEARCH RUNS ON THE SERVER, a moment after the typing stops: the page
  // holds only the pages it loaded, so filtering them would miss the rest.
  // Empty to start: the first page the server rendered was not searched.
  const searchedDropped = useRef("");
  useEffect(() => {
    const q = queryByView.irrelevant;
    if (q === searchedDropped.current) return;
    const timer = window.setTimeout(() => {
      searchedDropped.current = q;
      reloadDropped(q).catch((error) => setActionError(knowledgeErrorMessage(error)));
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryByView.irrelevant]);

  /** The Closed tab's threads, merged into what the page holds. */
  async function loadClosed(): Promise<TicketListItem[]> {
    setClosedState("loading");
    try {
      const response = await fetch("/api/tickets/closed");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { tickets: closedRows } = (await response.json()) as { tickets: TicketListItem[] };
      let merged: TicketListItem[] = [];
      setTickets((current) => {
        // A row the page already holds wins: it may have been closed or reopened here.
        const have = new Set(current.map((ticket) => ticket.id));
        merged = [...current, ...closedRows.filter((ticket) => !have.has(ticket.id))];
        return merged;
      });
      setClosedState("loaded");
      return merged.length ? merged : closedRows;
    } catch {
      setClosedState("failed");
      return [];
    }
  }

  useEffect(() => {
    if (activeView === "closed" && (closedState === "idle" || closedState === "failed")) {
      void loadClosed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

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

  function startSelectingMail() {
    setSelectingMail(true);
    setPickedMailIds([]);
  }

  function stopSelectingMail() {
    setSelectingMail(false);
    setPickedMailIds([]);
  }

  function toggleMailPick(id: string) {
    setPickedMailIds((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id]
    );
  }

  // A CLEAR IS THE SHOP'S, recorded on the server (dropped_mail_clears): a
  // cleared email is never sent to any page again until someone restores it.
  async function clearPickedMail() {
    if (pickedMailIds.length === 0) return;
    const picked = pickedMailIds;
    setActionError(null);
    try {
      const response = await fetch("/api/dropped-mail/clears", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: picked }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
      return;
    }
    const gone = new Set(picked);
    setDropped((current) => current.filter((mail) => !gone.has(mail.id)));
    setDroppedTotal((current) => Math.max(0, current - picked.length));
    setClearedTotal((current) => current + picked.length);
    // The preview pane is looking at one of these if it was picked.
    setSelectedDroppedId((current) => (current && gone.has(current) ? null : current));
    setActionNotice(t("tickets.view.notice.cleared", { count: picked.length }));
    stopSelectingMail();
  }

  async function restoreClearedMail() {
    setActionError(null);
    try {
      const response = await fetch("/api/dropped-mail/clears", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await reloadDropped(queryByView.irrelevant);
    } catch (error) {
      setActionError(knowledgeErrorMessage(error));
      return;
    }
    setActionNotice(t("tickets.view.notice.restored"));
  }

  async function promote(mail: DroppedMail) {
    setPendingId(mail.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const { ticket, ticketCreated } = await promoteDroppedMail(mail.id);
      setDropped((current) => current.filter((row) => row.id !== mail.id));
      setDroppedTotal((current) => Math.max(0, current - 1));
      setSelectedDroppedId((current) => (current === mail.id ? null : current));
      if (!ticket.isOwnSide) {
        setTickets((current) =>
          current.some((row) => row.id === ticket.id)
            ? current.map((row) => (row.id === ticket.id ? ticket : row))
            : [ticket, ...current]
        );
      }
      const subject = ticket.subject ?? t("tickets.view.noSubject");
      setActionNotice(
        ticketCreated
          ? ticket.isOwnSide
            ? t("tickets.view.notice.promotedOwn", { subject })
            : t("tickets.view.notice.promotedQueue", { subject })
          : t("tickets.view.notice.promotedExisting", { subject })
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

  /**
   * An approval (or a saved edit) hands the reply to the worker, so the
   * reviewer moves on: the next ticket in this list opens and the banner says
   * what was handed off. The ticket itself stays in the list — it is open until
   * a send is confirmed, and the worker may still refuse. A rejection keeps the
   * ticket on screen: somebody still has to answer it.
   */
  /**
   * A person snoozed or woke the open ticket. Snoozing moves it to the Snoozed
   * tab, so the next ticket in this list opens, as after an approval; waking it
   * from the Snoozed tab sends it back to the queue.
   */
  function snoozeChanged(ticketId: string, change: SnoozeChange) {
    const ticket = tickets.find((row) => row.id === ticketId);
    setTickets((current) => current.map((row) => (row.id === ticketId ? { ...row, ...change } : row)));
    if (!ticket) return;
    const leaves = change.snooze ? activeView !== "snoozed" : activeView === "snoozed";
    if (leaves) {
      const index = activeTickets.findIndex((row) => row.id === ticketId);
      const next = activeTickets[index + 1] ?? (index > 0 ? activeTickets[index - 1] : null) ?? null;
      setSelectedTicketId(next?.id ?? null);
    }
    setActionError(null);
    const subject = ticketTitle(ticket, t);
    setActionNotice(change.snooze ? t("tickets.view.notice.snoozed", { subject }) : t("tickets.view.notice.woken", { subject }));
  }

  /** A person queued a reply of their own: it joins the thread's list, newest first. */
  function manualReplySent(reply: TicketManualReply) {
    setThread((current) =>
      current
        ? { ...current, reply: { ...current.reply, manual: [reply, ...current.reply.manual.filter((r) => r.id !== reply.id)] } }
        : current
    );
  }

  function draftChanged(draft: TicketDraft, decided?: "approved" | "edited" | "rejected") {
    setThread((current) => (current ? { ...current, draft } : current));
    if ((decided !== "approved" && decided !== "edited") || !selectedTicket) return;
    const index = activeTickets.findIndex((ticket) => ticket.id === selectedTicket.id);
    const next = activeTickets[index + 1] ?? (index > 0 ? activeTickets[index - 1] : null) ?? null;
    setSelectedTicketId(next?.id ?? null);
    setActionError(null);
    setActionNotice(handedOffNotice(draft, requesterName(selectedTicket, t), t));
  }

  if (loadError) {
    return (
      <section className={styles.section}>
        <h1 className={styles.title}>{t("nav.tickets")}</h1>
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{t("tickets.view.loadFailed")}</p>
          <p className={styles.errorBody}>{loadError}</p>
        </div>
      </section>
    );
  }

  const tabCounts: Record<TicketView, number> = {
    queue: queueBase.length,
    backlog: backlogBase.length,
    snoozed: snoozedBase.length,
    irrelevant: droppedTotal,
    // Until the tab has loaded its threads: the server's count, moved by what
    // was closed or reopened here since.
    closed:
      closedState === "loaded"
        ? closedBase.length
        : (closedCount ?? 0) +
          closedBase.filter((ticket) => !initialClosedIds.has(ticket.id)).length -
          [...initialClosedIds].filter((id) => !closedBase.some((ticket) => ticket.id === id)).length,
  };

  return (
    <section className={styles.section}>
      <header className={styles.pageHeader}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>{t("nav.tickets")}</h1>
          <TicketsMetrics stats={stats} />
        </div>
        {headerAside ? <div className={styles.headerAside}>{headerAside}</div> : null}
      </header>

      {(actionError || actionNotice) && (
        <div className={actionError ? styles.error : styles.notice} role={actionError ? "alert" : "status"}>
          <p className={actionError ? styles.errorBody : styles.noticeBody}>{actionError ?? actionNotice}</p>
        </div>
      )}

      <div className={styles.navToolbar}>
        <div className={styles.viewTabs} role="tablist" aria-label={t("tickets.view.viewsLabel")}>
          {TICKET_VIEWS.map((view) => (
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
                // Leaving the tab ends the select mode: coming back to a list
                // still holding ticks from before would be a trap.
                stopSelectingMail();
              }}
            >
              {t(`tickets.view.tab.${view}`)}
              <span>{formatNumber(tabCounts[view], locale)}</span>
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
          showLinkedThreads={showLinkedThreads}
          onShowLinkedThreadsChange={setShowLinkedThreads}
        />
      </div>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {activeView === "irrelevant"
          ? t("tickets.view.shownDropped", { count: visibleDropped.length })
          : t("tickets.view.shownTickets", { count: activeTickets.length, view: t(`tickets.view.tab.${activeView}`) })}
      </p>

      {activeView === "irrelevant" ? (
        <IrrelevantWorkspace
          mail={visibleDropped}
          selectedMail={selectedDropped}
          selectedId={selectedDroppedId}
          onSelect={setSelectedDroppedId}
          onPromote={promote}
          pendingId={pendingId}
          selecting={selectingMail}
          picked={pickedMail}
          clearedCount={clearedCount}
          total={droppedTotal}
          loadingMore={moreLoading}
          onLoadMore={loadMoreDropped}
          onStartSelecting={startSelectingMail}
          onCancelSelecting={stopSelectingMail}
          onTogglePick={toggleMailPick}
          onClearPicked={clearPickedMail}
          onPickAll={setPickedMailIds}
          onRestoreCleared={restoreClearedMail}
        />
      ) : (
        <TicketWorkspace
          view={activeView}
          tickets={activeTickets}
          listNotice={
            activeView === "closed" && closedState === "loading"
              ? t("tickets.panels.list.loadingClosed")
              : activeView === "closed" && closedState === "failed"
                ? t("tickets.panels.list.loadClosedFailed")
                : null
          }
          selectedTicket={selectedTicket}
          selectedId={selectedTicketId}
          onSelect={setSelectedTicketId}
          detail={detail}
          detailError={detailError}
          thread={thread}
          threadError={threadError}
          onDraftChange={draftChanged}
          onManualReply={manualReplySent}
          onChangeStatus={changeStatus}
          snoozeDelays={snoozeDelays}
          onSnoozeChanged={snoozeChanged}
          pendingId={pendingId}
          contextOpen={contextOpen}
          onOpenContext={() => setContextOpen(true)}
          onCloseContext={() => setContextOpen(false)}
          onOrderChanged={(change) => {
            setTickets((current) => current.map((row) => (row.id === change.ticket.id ? change.ticket : row)));
            setDetail(change.detail);
          }}
          onCaseStateChanged={(change) => {
            setTickets((current) => current.map((row) => (row.id === change.ticket.id ? change.ticket : row)));
            setDetail((current) => (current ? { ...current, caseState: change.caseState } : current));
          }}
        />
      )}
    </section>
  );
}

function TicketsMetrics({ stats }: { stats: ReturnType<typeof summariseTickets> }) {
  const t = useT();
  const locale = useLocale();
  const metrics = [
    [t("tickets.view.metric.open"), stats.open],
    [t("tickets.view.metric.needsHuman"), stats.levelThree],
    [t("tickets.view.metric.highPriority"), stats.highPriority],
    [t("tickets.view.metric.newToday"), stats.last24h],
    [t("tickets.view.metric.last30d"), stats.last30d],
  ];

  return (
    <dl className={styles.metrics} aria-label={t("tickets.view.metric.label")}>
      {metrics.map(([label, value]) => (
        <div className={styles.metric} key={label}>
          <dt>{label}</dt>
          <dd>{formatNumber(Number(value), locale)}</dd>
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
  showLinkedThreads: boolean;
  onShowLinkedThreadsChange: (value: boolean) => void;
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
  showLinkedThreads,
  onShowLinkedThreadsChange,
}: TicketToolbarProps) {
  const t = useT();
  const ticketView = activeView === "queue" || activeView === "backlog";
  const placeholder =
    activeView === "irrelevant" ? t("tickets.view.search.irrelevant") : t("tickets.view.search.tickets");

  return (
    <div className={styles.toolbar}>
      <label className={styles.searchWrap}>
        <span className={styles.srOnly}>{t("tickets.view.search.in", { view: t(`tickets.view.tab.${activeView}`) })}</span>
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
            <span>{t("tickets.view.filter.level")}</span>
            <select
              className={styles.select}
              value={level}
              onChange={(event) => onLevelChange(event.target.value as LevelFilter)}
            >
              <option value="all">{t("tickets.view.filter.all", { n: levelCounts.all })}</option>
              <option value="4">{t("level.4")} ({levelCounts["4"]})</option>
              <option value="3">{t("level.3")} ({levelCounts["3"]})</option>
              <option value="2">{t("level.2")} ({levelCounts["2"]})</option>
              <option value="1">{t("level.1")} ({levelCounts["1"]})</option>
              <option value="uncategorised">{t("tickets.view.filter.uncategorised", { n: levelCounts.uncategorised })}</option>
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span>{t("tickets.view.filter.category")}</span>
            <select
              className={styles.select}
              value={category}
              onChange={(event) => onCategoryChange(event.target.value as KnowledgeCategory | "all")}
            >
              <option value="all">{t("tickets.view.filter.allCategories")}</option>
              {TICKET_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(`category.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span>{t("tickets.view.filter.sender")}</span>
            <select
              className={styles.select}
              value={sender}
              onChange={(event) => onSenderChange(event.target.value as "all" | "consumer" | "business")}
            >
              <option value="all">{t("tickets.view.filter.anyone")}</option>
              <option value="consumer">{t("tickets.view.filter.consumers")}</option>
              <option value="business">{t("tickets.view.filter.business")}</option>
            </select>
          </label>

          <label className={styles.selectLabel}>
            <span>{t("tickets.view.filter.sort")}</span>
            <select
              className={styles.select}
              value={sort}
              onChange={(event) => onSortChange(event.target.value as SortOrder)}
            >
              {SORT_ORDERS.map((value) => (
                <option key={value} value={value}>
                  {t(`tickets.view.sort.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.selectLabel}>
            <input
              type="checkbox"
              checked={showLinkedThreads}
              onChange={(event) => onShowLinkedThreadsChange(event.target.checked)}
            />
            <span>{t("tickets.view.filter.linkedThreads")}</span>
          </label>
        </>
      )}
    </div>
  );
}

/** A draft came back from the server; `decided` says which button produced it. */
type DraftChangeHandler = (draft: TicketDraft, decided?: "approved" | "edited" | "rejected") => void;
type ManualReplyHandler = (reply: TicketManualReply) => void;

interface TicketWorkspaceProps {
  view: TicketView;
  tickets: TicketListItem[];
  /** Said in place of the empty list while it is being read, or failed to be. */
  listNotice?: string | null;
  selectedTicket: TicketListItem | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: TicketDetail | null;
  detailError: string | null;
  thread: TicketThread | null;
  threadError: string | null;
  onDraftChange: DraftChangeHandler;
  onManualReply: ManualReplyHandler;
  onChangeStatus: (ticket: TicketListItem, status: "open" | "closed") => void;
  snoozeDelays: SnoozeDelays;
  onSnoozeChanged: (ticketId: string, change: SnoozeChange) => void;
  pendingId: string | null;
  contextOpen: boolean;
  onOpenContext: () => void;
  onCloseContext: () => void;
  onOrderChanged: (change: TicketChange) => void;
  onCaseStateChanged: (change: TicketCaseChange) => void;
}

function TicketWorkspace({
  view,
  tickets,
  listNotice = null,
  selectedTicket,
  selectedId,
  onSelect,
  detail,
  detailError,
  thread,
  threadError,
  onDraftChange,
  onManualReply,
  onChangeStatus,
  snoozeDelays,
  onSnoozeChanged,
  pendingId,
  contextOpen,
  onOpenContext,
  onCloseContext,
  onOrderChanged,
  onCaseStateChanged,
}: TicketWorkspaceProps) {
  const t = useT();
  return (
    <div className={`${styles.workspace} ${selectedTicket ? styles.hasSelection : ""}`}>
      <TicketListPane view={view} tickets={tickets} selectedId={selectedId} onSelect={onSelect} notice={listNotice} />

      <section className={styles.detailPane} aria-label={t("tickets.view.detailLabel")}>
        {selectedTicket ? (
          <TicketDetailWorkspace
            ticket={selectedTicket}
            detail={detail}
            detailError={detailError}
            thread={thread}
            threadError={threadError}
            onDraftChange={onDraftChange}
            onManualReply={onManualReply}
            onChangeStatus={onChangeStatus}
            snoozeDelays={snoozeDelays}
            onSnoozeChanged={onSnoozeChanged}
            pendingId={pendingId}
            onOpenContext={onOpenContext}
            onBack={() => onSelect("")}
          />
        ) : (
          <EmptyDetail title={t("tickets.view.emptyDetail.title")} body={t("tickets.view.emptyDetail.body")} />
        )}
      </section>

      <aside className={styles.contextPane} aria-label={t("tickets.view.contextLabel")}>
        {selectedTicket ? (
          <TicketContextPane ticket={selectedTicket} detail={detail} thread={thread} error={detailError} onOrderChanged={onOrderChanged} onCaseStateChanged={onCaseStateChanged} />
        ) : (
          <EmptyDetail title={t("tickets.view.emptyContext.title")} body={t("tickets.view.emptyContext.body")} />
        )}
      </aside>

      {selectedTicket && (
        <div className={`${styles.contextSheet} ${contextOpen ? styles.contextSheetOpen : ""}`} aria-hidden={!contextOpen}>
          <button className={styles.sheetScrim} type="button" aria-label={t("tickets.view.closeContext")} onClick={onCloseContext} />
          <aside className={styles.sheetPanel} role="dialog" aria-modal="true" aria-labelledby="ticket-context-title">
            <header className={styles.sheetHeader}>
              <h2 id="ticket-context-title">{t("tickets.view.contextLabel")}</h2>
              <Button size="sm" variant="tertiary" onClick={onCloseContext}>{t("tickets.view.close")}</Button>
            </header>
            <TicketContextPane ticket={selectedTicket} detail={detail} thread={thread} error={detailError} onOrderChanged={onOrderChanged} onCaseStateChanged={onCaseStateChanged} />
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
  notice = null,
}: {
  view: TicketView;
  tickets: TicketListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  notice?: string | null;
}) {
  const t = useT();
  return (
    <aside className={styles.listPane} aria-label={t("tickets.view.listLabel", { view: t(`tickets.view.tab.${view}`) })}>
      <div className={styles.listHeader}>
        <div>
          <h2>{t(`tickets.view.tab.${view}`)}</h2>
          <p>{t("tickets.panels.list.count", { count: tickets.length })}</p>
        </div>
        <span>
          {view === "closed"
            ? t("tickets.panels.list.recentlyClosed")
            : view === "snoozed"
              ? t("tickets.panels.list.soonestBack")
              : t("tickets.panels.list.priorityFirst")}
        </span>
      </div>

      {tickets.length === 0 && notice ? (
        <p className={styles.placeholder}>{notice}</p>
      ) : tickets.length === 0 ? (
        <CompactEmpty title={t("tickets.panels.list.emptyTitle")} body={t("tickets.panels.list.emptyBody")} />
      ) : (
        <ol className={styles.ticketList} role="listbox" aria-label={t("tickets.panels.list.ticketsLabel", { view: t(`tickets.view.tab.${view}`) })}>
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
                    <span className={styles.priorityWord}>{priorityLabel(ticket, t)}</span>
                  </span>
                  <time dateTime={ticket.lastMessageAt ?? undefined}>{ticketAge(ticket, t)}</time>
                </span>
                <span className={styles.itemSubject} title={ticketTitle(ticket, t)}>
                  {ticketTitle(ticket, t)}
                </span>
                <span className={styles.itemRequester} title={`${requesterName(ticket, t)}${ticket.orderNumber ? ` - ${t("tickets.panels.orderNumber", { number: ticket.orderNumber })}` : ""}`}>
                  {requesterName(ticket, t)}
                  {ticket.orderNumber ? ` - ${t("tickets.panels.orderNumber", { number: ticket.orderNumber })}` : ""}
                  {ticket.isVip && (
                    <span className={styles.vipInline} title={t("tickets.panels.vipTitle")}>
                      <CrownIcon size={12} />
                      <span className={styles.srOnly}>{t("tickets.panels.vip")}</span>
                    </span>
                  )}
                </span>
                <span className={styles.itemMeta}>
                  <span>{ticket.category ? t(`category.${ticket.category}`) : t("tickets.panels.uncategorised")}</span>
                  <SnoozeChip ticket={ticket} />
                  <ForwardingChip forwarding={ticket.forwarding} />
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
  onManualReply,
  onChangeStatus,
  snoozeDelays,
  onSnoozeChanged,
  pendingId,
  onOpenContext,
  onBack,
}: {
  ticket: TicketListItem;
  detail: TicketDetail | null;
  detailError: string | null;
  thread: TicketThread | null;
  threadError: string | null;
  onDraftChange: DraftChangeHandler;
  onManualReply: ManualReplyHandler;
  onChangeStatus: (ticket: TicketListItem, status: "open" | "closed") => void;
  snoozeDelays: SnoozeDelays;
  onSnoozeChanged: (ticketId: string, change: SnoozeChange) => void;
  pendingId: string | null;
  onOpenContext: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const closed = isClosed(ticket);
  const frameRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [draftHeight, setDraftHeight] = useState<number | null>(readDraftHeight);
  const [middleTab, setMiddleTab] = useState<"conversation" | "activity" | "linked">("conversation");
  // The case's other threads, when this thread is one of several (61_cases.sql).
  const linkedThreads = thread?.case?.threads.filter((row) => !row.isThisThread) ?? [];

  useEffect(() => {
    setMiddleTab("conversation");
  }, [ticket.id]);

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

  // THE DRAG WRITES THE PANEL'S STYLE, NOT STATE. Setting state on every
  // pointermove re-rendered the conversation, the draft and its explanation
  // dozens of times a second, which is what made the handle lag. React learns
  // the height once, on release. Moves are coalesced to one per frame.
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const frame = frameRef.current;
    const panel = frame?.querySelector<HTMLElement>(`.${styles.draftPanel}`);
    if (!frame || !panel || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const bottom = frame.getBoundingClientRect().bottom;
    let latest = draftHeight;
    let frameRequest = 0;
    let pointerY = event.clientY;

    // Only once the pointer actually moves: a plain click must leave the panel
    // exactly as React rendered it, since nothing is committed then.
    const apply = () => {
      frameRequest = 0;
      latest = clampDraftHeight(bottom - pointerY - DRAFT_HANDLE_HEIGHT / 2);
      panel.classList.add(styles.draftPanelSized);
      panel.style.maxHeight = "none";
      panel.style.height = `${latest}px`;
    };
    const move = (moveEvent: PointerEvent) => {
      pointerY = moveEvent.clientY;
      if (!frameRequest) frameRequest = window.requestAnimationFrame(apply);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      if (frameRequest) {
        window.cancelAnimationFrame(frameRequest);
        apply();
      }
      document.body.style.userSelect = "";
      if (latest !== draftHeight) commitDraftHeight(latest);
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
      {/* One block: title row, what has to happen next, and the tabs as its
          bottom edge — three stacked bands read as three unrelated things. */}
      <header className={styles.ticketHeaderBlock} ref={headerRef}>
      <div className={styles.ticketHeader}>
        <button type="button" className={styles.mobileBack} onClick={onBack}>
          <ChevronLeftIcon size={15} />
          {t("tickets.panels.backToTickets")}
        </button>
        <div className={styles.ticketHeaderText}>
          <h2 title={ticketTitle(ticket, t)}>{ticketTitle(ticket, t)}</h2>
          <p>
            {requesterName(ticket, t)}
            {ticket.orderNumber ? ` - ${t("tickets.panels.orderNumber", { number: ticket.orderNumber })}` : ""}
            {ticket.category ? ` - ${t(`category.${ticket.category}`)}` : ""}
            {ticket.lastMessageAt ? ` - ${t("tickets.panels.lastActivity", { when: formatRelativeTime(ticket.lastMessageAt, t) })}` : ""}
          </p>
        </div>
        <div className={styles.ticketHeaderActions}>
          <TicketLevelBadge ticket={ticket} />
          {ticket.responsibleTeam && (
            <span className={styles.assignment}>{t("tickets.panels.team", { team: t(`team.${ticket.responsibleTeam}`) })}</span>
          )}
          <Button size="sm" variant="secondary" className={styles.contextButton} onClick={onOpenContext}>
            {t("tickets.panels.context")}
          </Button>
          {!closed && (
            <SnoozeControl
              ticket={ticket}
              delays={snoozeDelays}
              disabled={pendingId !== null && pendingId !== ticket.id}
              onChanged={onSnoozeChanged}
            />
          )}
          <Button
            size="sm"
            variant={closed ? "secondary" : "danger"}
            loading={pendingId === ticket.id}
            disabled={pendingId !== null && pendingId !== ticket.id}
            onClick={() => onChangeStatus(ticket, closed ? "open" : "closed")}
          >
            {closed ? t("tickets.panels.reopenTicket") : t("tickets.panels.closeTicket")}
          </Button>
        </div>
      </div>

      {ticket.snooze && !isClosed(ticket) && <SnoozeBanner snooze={ticket.snooze} />}
      {ticket.forwarding && <ForwardingBanner forwarding={ticket.forwarding} />}

      {detail?.results?.action && (
        <p className={styles.nextAction} title={detail.results.action}>
          <span>{t("tickets.panels.nextAction")}</span>
          {detail.results.action}
        </p>
      )}

      <div className={styles.middleTabs} role="tablist" aria-label={t("tickets.panels.historyLabel")}>
        <button
          type="button"
          role="tab"
          aria-selected={middleTab === "conversation"}
          className={middleTab === "conversation" ? styles.middleTabActive : undefined}
          onClick={() => setMiddleTab("conversation")}
        >
          {t("tickets.panels.conversation")}
          {thread && <span>{thread.messages.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={middleTab === "activity"}
          className={middleTab === "activity" ? styles.middleTabActive : undefined}
          onClick={() => setMiddleTab("activity")}
        >
          {t("tickets.panels.activity")}
          {detail && thread && <span>{activityItems(detail, thread, t).length}</span>}
        </button>
        {linkedThreads.length > 0 && (
          <button
            type="button"
            role="tab"
            aria-selected={middleTab === "linked"}
            className={middleTab === "linked" ? `${styles.middleTabActive} ${styles.linkedTabActive}` : undefined}
            onClick={() => setMiddleTab("linked")}
          >
            {t("tickets.panels.linked.tab")}
            <span>{linkedThreads.length}</span>
          </button>
        )}
      </div>
      </header>

      <div className={styles.conversationArea}>
        {middleTab === "conversation" ? (
          <ConversationThread thread={thread} error={threadError} />
        ) : middleTab === "linked" && thread && linkedThreads.length > 0 ? (
          <LinkedThreads threads={linkedThreads} parcels={thread.parcels} />
        ) : (
          <ActivityTimeline detail={detail} thread={thread} error={detailError || threadError} />
        )}
      </div>

      {/* Drag up to read more of the draft, down to read more of the thread.
          Double-click (or Enter) returns to the default split. */}
      <div
        className={styles.draftHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("tickets.panels.resizeDraft")}
        aria-valuenow={draftHeight ?? undefined}
        tabIndex={0}
        title={t("tickets.panels.resizeHint")}
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
        onManualReply={onManualReply}
        detail={detail}
        detailError={detailError}
      />
    </div>
  );
}

/**
 * THE CASE'S OTHER THREADS, read from the thread being worked. The queue shows
 * one row per case, so a thread linked into it (often an older one, or a
 * duplicate the customer sent again) is not in the list; this is where its
 * mail is read. Read-only: the reply goes on the case's reply thread.
 */
function LinkedThreads({
  threads,
  parcels,
}: {
  threads: NonNullable<TicketThread["case"]>["threads"];
  parcels: TicketTracking[];
}) {
  const t = useT();
  const locale = useLocale();
  // Newest first: the thread most likely to matter is the latest one.
  const ordered = [...threads].sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")));
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "—");

  return (
    <section className={`${styles.threadSection} ${styles.linkedSection}`} aria-label={t("tickets.panels.linked.label")}>
      <div className={styles.sectionHead}>
        <h3>{t("tickets.panels.linked.tab")}</h3>
        <span>{t("tickets.panels.linked.hint")}</span>
      </div>
      {ordered.map((row) => (
        <section key={row.ticketId} className={styles.linkedThread} aria-label={row.subject ?? t("tickets.panels.linked.noSubject")}>
          <header className={styles.linkedThreadHead}>
            <strong>{row.subject ?? t("tickets.panels.linked.noSubject")}</strong>
            <span>
              {t(`status.${row.status}`)} · {day(row.firstMessageAt)}
              {row.lastMessageAt && row.lastMessageAt.slice(0, 10) !== row.firstMessageAt?.slice(0, 10) ? ` → ${day(row.lastMessageAt)}` : ""}
              {row.linkedBy ? ` · ${t(`tickets.panels.linked.method.${row.linkedBy}`)}` : ""}
            </span>
            {row.isReplyThread && <em>{t("tickets.panels.linked.replyHere")}</em>}
          </header>
          {row.messages.length === 0 ? (
            <p className={styles.linkedThreadEmpty}>{t("tickets.panels.thread.emptyTitle")}</p>
          ) : (
            <ol className={styles.messages}>
              {row.messages.map((message) => (
                <MessageBlock key={message.id} message={message} parcels={parcels} />
              ))}
            </ol>
          )}
        </section>
      ))}
    </section>
  );
}

function ConversationThread({ thread, error }: { thread: TicketThread | null; error: string | null }) {
  const t = useT();
  const locale = useLocale();
  const latestRef = useRef<HTMLLIElement>(null);
  if (error) {
    return <p className={styles.inlineError} role="alert">{error}</p>;
  }
  if (!thread) {
    return <ThreadSkeleton />;
  }
  if (thread.messages.length === 0) {
    return <CompactEmpty title={t("tickets.panels.thread.emptyTitle")} body={t("tickets.panels.thread.emptyBody")} />;
  }

  return (
    <section className={styles.threadSection} aria-label={t("tickets.panels.thread.label")}>
      <div className={styles.sectionHead}>
        <h3>{t("tickets.panels.conversation")}</h3>
        <button type="button" className={styles.jumpLatest} onClick={() => latestRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}>
          {t("tickets.panels.thread.jumpLatest")}
        </button>
      </div>
      <div className={styles.dateGroups}>
        {groupMessagesByDate(thread.messages, t, locale).map((group) => (
          <section className={styles.dateGroup} key={group.key} aria-label={group.label}>
            <div className={styles.dateDivider}>
              <time dateTime={group.key}>{group.label}</time>
            </div>
            <ol className={styles.messages}>
              {group.messages.map((message, index) => (
                <MessageBlock
                  key={message.id}
                  message={message}
                  parcels={thread.parcels}
                  itemRef={group.isLast && index === group.messages.length - 1 ? latestRef : undefined}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}

// `linked`: an email on another thread of the same case (61_cases.sql), in the
// feed so the case reads as one story, in its own colour so it is never taken
// for this thread's mail.
type ActivityKind = "inbound" | "outbound" | "linked" | "lookup" | "investigation" | "draft" | "warning";

type ActivityItem = {
  id: string;
  at: string | null;
  title: string;
  detail: string | null;
  kind: ActivityKind;
};

const ACTIVITY_ICONS: Record<ActivityKind, (props: { size?: number }) => ReactNode> = {
  inbound: MailInIcon,
  outbound: SendIcon,
  linked: MailInIcon,
  lookup: SearchIcon,
  investigation: SparkleIcon,
  draft: PencilIcon,
  warning: AlertIcon,
};

function ActivityTimeline({
  detail,
  thread,
  error,
}: {
  detail: TicketDetail | null;
  thread: TicketThread | null;
  error: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  if (error) return <p className={styles.inlineError} role="alert">{error}</p>;
  if (!detail || !thread) return <ThreadSkeleton />;

  const events = activityItems(detail, thread, t);

  if (events.length === 0) {
    return <CompactEmpty title={t("tickets.panels.activityFeed.emptyTitle")} body={t("tickets.panels.activityFeed.emptyBody")} />;
  }

  return (
    <section className={styles.activitySection} aria-label={t("tickets.panels.activityFeed.label")}>
      <div className={styles.sectionHead}>
        <div>
          <h3>{t("tickets.panels.activity")}</h3>
          <p>{t("tickets.panels.activityFeed.intro")}</p>
        </div>
      </div>
      <ol className={styles.activityList}>
        {events.map((event) => {
          const Icon = ACTIVITY_ICONS[event.kind];
          return (
            <li key={event.id} className={styles[`activity_${event.kind}`]}>
              <time dateTime={event.at ?? undefined}>{formatEventTime(event.at, locale)}</time>
              <span className={styles.activityIcon} title={t(`tickets.panels.activityKind.${event.kind}`)}>
                <Icon size={14} />
                <span className="sr-only">{t(`tickets.panels.activityKind.${event.kind}`)}</span>
              </span>
              <div className={styles.activityText}>
                <strong>{event.title}</strong>
                {event.detail && <p>{event.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The tool names the server records, grouped under the label the Activity feed shows. */
const TOOL_ACTIVITY_KEYS: Record<string, string> = {
  getOrderContext: "order",
  lookupOrder: "order",
  lookupShipment: "shipment",
  lookupTracking: "shipment",
  lookupCustomer: "customer",
  lookupPromotion: "promotion",
  lookupProduct: "product",
  searchKnowledge: "knowledge",
  recommendProducts: "recommendation",
  lookupAbandonedCheckout: "checkout",
  checkPhotoEvidence: "photo",
};

/** A need's label in the reader's language; the server's English stands when the key is unknown. */
function needText(t: Translate, need: string, fallback: string): string {
  const key = `need.${need}`;
  const text = t(key);
  return text === key ? fallback : text;
}

/** What the customer still owes, by the field's key (`field.<key>`), else the server's words. */
function questionText(t: Translate, key: string, fallback: string): string {
  const path = `field.${key}`;
  const text = t(path);
  return text === path ? fallback : text;
}

/**
 * The conversation's emails and the agent's persisted actions on one clock,
 * oldest first. The sort is stable, and the server lists the lookups before
 * the analysis that used them — they share the investigation's timestamp, as
 * the tool-call ledger keeps no time of its own.
 */
function activityItems(detail: TicketDetail, thread: TicketThread, t: Translate): ActivityItem[] {
  const messages: ActivityItem[] = thread.messages.map((message) => {
    const inbound = message.direction === "inbound";
    const name = senderDisplayName(message, t);
    const role = t(`tickets.panels.role.${message.role}`);
    const who = inbound && message.role !== "customer" ? `${name} (${role})` : name;
    return {
      id: `message-${message.id}`,
      at: message.at,
      title: inbound
        ? t(message.isForward ? "tickets.panels.activityFeed.forwardedFrom" : "tickets.panels.activityFeed.receivedFrom", { who })
        : t("tickets.panels.activityFeed.sentBy", { who }),
      detail: messageSnippet(message, t),
      kind: inbound ? "inbound" : "outbound",
    };
  });

  // The case's other threads, both directions, named by their subject.
  const linked: ActivityItem[] = (thread.case?.threads ?? [])
    .filter((row) => !row.isThisThread)
    .flatMap((row) =>
      row.messages.map((message) => {
        const inbound = message.direction === "inbound";
        const name = senderDisplayName(message, t);
        const subject = row.subject ?? t("tickets.panels.linked.noSubject");
        return {
          id: `linked-${message.id}`,
          at: message.at,
          title: inbound
            ? t("tickets.panels.activityFeed.linkedReceived", { who: name, subject })
            : t("tickets.panels.activityFeed.linkedSent", { who: name, subject }),
          detail: messageSnippet(message, t),
          kind: "linked" as const,
        };
      })
    );

  const draft: ActivityItem[] = thread.draft
    ? [{
        id: `draft-${thread.draft.id}`,
        at: thread.draft.draftedAt,
        title: t("tickets.panels.activityFeed.draftGenerated"),
        detail: draftStatusText(thread.draft, t),
        kind: "draft",
      },
      // Each warning beside the draft it is about, at the same time: worth a
      // look, never blocking (draft-checks.mjs `warningChecks`).
      ...(thread.draft.warnings ?? []).map((warning, index) => ({
        id: `draft-warning-${thread.draft!.id}-${index}`,
        at: thread.draft!.draftedAt,
        title: t("tickets.panels.activityFeed.draftWarning"),
        detail: warning,
        kind: "warning" as const,
      }))]
    : [];

  const agentEvents: ActivityItem[] = detail.activity.map((event) => {
    if (event.kind === "investigation") {
      const verdictKnown = event.verdict && ["answerable", "needs_customer_input", "needs_human"].includes(event.verdict);
      return {
        ...event,
        title: t("tickets.panels.activityFeed.analysisDone"),
        detail: verdictKnown ? t(`tickets.panels.activityFeed.verdict.${event.verdict}`) : event.detail,
      };
    }
    const toolKey = event.tool ? TOOL_ACTIVITY_KEYS[event.tool] : null;
    return toolKey
      ? { ...event, title: t("tickets.panels.activityFeed.lookupDone", { tool: t(`tickets.panels.tool.${toolKey}`) }) }
      : event;
  });

  return [...messages, ...linked, ...agentEvents, ...draft].sort(
    (a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0)
  );
}

function messageSnippet(message: TicketMessage, t: Translate): string | null {
  const text = (message.bodyClean ?? "").replace(/\s+/g, " ").trim();
  const attachment = message.hasAttachments ? ` · ${t("tickets.panels.attachment")}` : "";
  if (!text) return message.hasAttachments ? t("tickets.panels.attachment") : null;
  return `${text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text}${attachment}`;
}

function DraftResponsePanel({
  height,
  ticket,
  thread,
  error,
  onDraftChange,
  onManualReply,
  detail,
  detailError,
}: {
  height: number | null;
  ticket: TicketListItem;
  thread: TicketThread | null;
  error: string | null;
  onDraftChange: DraftChangeHandler;
  onManualReply: ManualReplyHandler;
  detail: TicketDetail | null;
  detailError: string | null;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  // The editor's HTML; the server sanitises it and derives the text.
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
        approvedBody: null,
        approvedBodyHtml: status === "edited" ? edited : null,
      });
      onDraftChange(updated, status);
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
      aria-label={t("tickets.panels.draft.aiDraft")}
    >
      <div className={styles.draftHead}>
        <div>
          <h3>{t("tickets.panels.draft.replyTo", { name: requesterName(ticket, t) })}</h3>
          {draft && !replyDelivered(draft) && <p>{draftStatusText(draft, t)}</p>}
        </div>
        {draft && !replyDelivered(draft) && (
          <div className={styles.draftLabels}>
            <span className={styles.aiDraftLabel}>{t("tickets.panels.draft.aiDraft")}</span>
            <span className={styles.draftStatus}>{t(`tickets.panels.draft.status.${draft.status}`)}</span>
          </div>
        )}
      </div>

      {thread?.duplicateOf && (
        <p className={styles.duplicate} role="alert">
          {t("tickets.panels.draft.duplicate")}
        </p>
      )}

      {/* A CASE OF SEVERAL THREADS (61_cases.sql) replaces the related line:
          it says the agent read every thread, and where the reply goes. */}
      {thread?.case && !thread.duplicateOf && (
        <p className={styles.related}>
          {thread.reply.replyElsewhere
            ? t("tickets.panels.draft.caseElsewhere", { n: thread.case.threads.length, subject: thread.reply.replyElsewhere.subject ?? "—" })
            : t("tickets.panels.draft.caseThreads", { n: thread.case.threads.length })}
        </p>
      )}
      {thread?.relatedTo && !thread.case && !thread.duplicateOf && (
        <p className={styles.related}>{t("tickets.panels.draft.related")}</p>
      )}

      {error ? (
        <p className={styles.inlineError} role="alert">{error}</p>
      ) : !thread ? (
        <DraftSkeleton />
      ) : draft && replyDelivered(draft) ? (
        // IN THE MAILBOX NOW. The approved reply is Outlook's from here (in
        // Drafts, or sent), so it is no longer shown as a draft: one line says
        // where it went, and « Create draft » below lets a person add to it.
        <p className={styles.related} role="status">{deliveredLine(draft, t)}</p>
      ) : draft ? (
        <div className={awaitingDelivery(draft) ? styles.draftAwaiting : styles.draftLive} aria-busy={awaitingDelivery(draft) || undefined}>
          {detail?.results?.action && !awaitingDelivery(draft) && (
            <div className={styles.requiredAction}>
              <span>{t("tickets.panels.draft.requiredBeforeSending")}</span>
              <p><span aria-hidden="true">●</span> {detail.results.action}</p>
            </div>
          )}

          {draft.status === "stale" && (
            <p className={styles.blocked} role="status">
              {draft.staleReason === "superseded_by_outbound"
                ? t("tickets.panels.draft.staleSent")
                : t("tickets.panels.draft.staleMoved")}
            </p>
          )}

          {outboundLine(draft.outbound, t) && (
            <p className={draft.outbound?.state === "cancelled" || draft.outbound?.state === "failed" ? styles.blocked : styles.related} role="status">
              {outboundLine(draft.outbound, t)}
            </p>
          )}

          {draft.status !== "stale" && !draft.checksPassed && (
            <p className={styles.blocked} role="alert">
              {t("tickets.panels.draft.notSendable", { count: draft.failedChecks.length })}{" "}
              {draft.failedChecks.join("; ") || t("tickets.panels.draft.seeRecord")}.
            </p>
          )}

          {draft.status !== "stale" &&
            (draft.warnings ?? []).map((detail) => (
              <p key={detail} className={styles.caution} role="status">
                {t("tickets.panels.draft.warning", { detail })}
              </p>
            ))}

          {draft.status !== "stale" &&
            autoSendHoldLines(draft, t).map((line) => (
              <p key={line} className={styles.blocked} role="status">
                {line}
              </p>
            ))}

          {editing ? (
            // The draft's [[marker]] opens as the real link, so a reviewer
            // edits what the customer will see rather than a placeholder.
            <ReplyEditor
              key={draft.id}
              initialHtml={edited}
              onChange={setEdited}
              label={t("tickets.panels.draft.editLabel")}
            />
          ) : (
            <pre className={styles.draftBody}>
              <TrackingText text={draft.body} parcels={thread.parcels} link={draft.replyLink} />
            </pre>
          )}

          {draft.approvedBody && (
            <div className={styles.reviewerVersion}>
              <h4>{t("tickets.panels.draft.reviewerVersion")}</h4>
              {draft.approvedBodyHtml ? (
                <ReplyHtmlView html={draft.approvedBodyHtml} />
              ) : (
                <pre className={styles.draftBody}>
                  <TrackingText text={draft.approvedBody} parcels={thread.parcels} link={draft.replyLink} />
                </pre>
              )}
            </div>
          )}

          <div className={styles.draftFoot}>
            <div className={styles.draftActions}>
              {draft.status === "stale" || replyInFlight(draft) || awaitingDelivery(draft) ? null : editing ? (
                <>
                  <Button size="sm" variant="primary" loading={saving === "edited"} disabled={saving !== null || replyHtmlIsEmpty(edited)} onClick={() => decide("edited")}>
                    {decisionLabel(draft, "save", t)}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={saving !== null} onClick={() => setEditing(false)}>
                    {t("tickets.panels.draft.cancel")}
                  </Button>
                </>
              ) : (
                <>
                  <span className={styles.draftActionsStart}>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={saving !== null}
                      onClick={() => {
                        setEdited(draft.approvedBodyHtml ?? textToReplyHtml(draft.approvedBody ?? draft.body, draft.replyLink));
                        setEditing(true);
                      }}
                    >
                      {t("tickets.panels.draft.edit")}
                    </Button>
                  </span>
                  <span className={styles.draftActionsEnd}>
                    <Button size="sm" variant="secondary" loading={saving === "rejected"} disabled={saving !== null} onClick={() => decide("rejected")}>
                      {t("tickets.panels.draft.reject")}
                    </Button>
                    <Button size="sm" variant="primary" loading={saving === "approved"} disabled={saving !== null} onClick={() => decide("approved")}>
                      {decisionLabel(draft, "approve", t)}
                    </Button>
                  </span>
                </>
              )}
            </div>
            {draft.draftedAt && (
              <p className={styles.stamp}>
                {t("tickets.panels.draft.drafted")} <time dateTime={draft.draftedAt}>{formatRelativeTime(draft.draftedAt, t)}</time>
              </p>
            )}
          </div>

          <DraftExplanation detail={detail} draft={draft} />

          {decideError && <p className={styles.inlineError} role="alert">{decideError}</p>}
        </div>
      ) : (
        <p className={styles.placeholder}>
          {t("tickets.panels.draft.none")}
        </p>
      )}

      {thread && !error && (
        <>
          <ManualReplyStatus replies={thread.reply.manual} />
          {canComposeReply(draft) && (
            <ReplyComposer ticket={ticket} thread={thread} onSent={onManualReply} />
          )}
        </>
      )}

      {detailError && <p className={styles.inlineError} role="alert">{detailError}</p>}
    </section>
  );
}

/**
 * The newest reply a person wrote here, while it matters: greyed with its text
 * until the worker has put it in the mailbox, then one line. A refused one
 * keeps its text, so it can be reused rather than typed again.
 */
function ManualReplyStatus({ replies }: { replies: TicketManualReply[] }) {
  const t = useT();
  const newest = replies[0];
  if (!newest) return null;
  const refused = newest.state === "cancelled" || newest.state === "failed";
  const queued = newest.state === "approved";
  return (
    <div className={styles.manualReply}>
      <p className={refused ? styles.blocked : styles.related} role="status">
        {manualReplyLine(newest, t)}
      </p>
      {(queued || refused) && (
        <div className={queued ? styles.draftAwaiting : undefined}>
          {newest.bodyHtml ? <ReplyHtmlView html={newest.bodyHtml} /> : <pre className={styles.draftBody}>{newest.bodyText}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * « Create draft »: a reply a person writes themselves, typically to add what
 * the agent missed. It goes out through the same worker as an approved draft
 * (an outbound action; nothing is sent from the browser) and is threaded under
 * the customer's latest message.
 *
 * IT STARTS NO AGENT WORK. Once sent it comes back from Sent Items like any
 * reply of ours, and the next investigation — on the customer's next message —
 * reads it in the thread. Often it is the reply that settles the case; the
 * person then ticks off the checks and closes the ticket.
 */
function ReplyComposer({
  ticket,
  thread,
  onSent,
}: {
  ticket: TicketListItem;
  thread: TicketThread;
  onSent: ManualReplyHandler;
}) {
  const t = useT();
  // The idempotency key is minted when the box opens: a double click or a
  // retried request sends one email, and a fresh box is a fresh reply.
  const [open, setOpen] = useState<null | { key: string; seed: string }>(null);
  const [html, setHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const { sendingEnabled, holdsInDrafts, targetMessageId, manual } = thread.reply;
  const newest = manual[0];

  useEffect(() => {
    setOpen(null);
    setHtml("");
    setSendError(null);
  }, [ticket.id]);

  // A reply still on its way: one at a time, so nobody sends the same addition twice.
  if (newest && (newest.state === "approved" || newest.state === "send_requested")) return null;

  function start(seed = "") {
    setHtml(seed);
    setSendError(null);
    setOpen({ key: crypto.randomUUID(), seed });
  }

  async function send() {
    if (!open || !targetMessageId) return;
    setSending(true);
    setSendError(null);
    try {
      const reply = await sendManualReply(ticket.id, { bodyHtml: html, replyToMessageId: targetMessageId, clientKey: open.key });
      onSent(reply);
      setOpen(null);
      setHtml("");
    } catch (cause) {
      setSendError(knowledgeErrorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    const blockedBy = !sendingEnabled
      ? t("tickets.panels.compose.off")
      : thread.reply.replyElsewhere
        ? t("tickets.panels.compose.replyElsewhere", { subject: thread.reply.replyElsewhere.subject ?? "—" })
        : !targetMessageId
          ? t("tickets.panels.compose.noTarget")
          : null;
    const refused = newest && (newest.state === "cancelled" || newest.state === "failed") ? newest : null;
    return (
      <div className={styles.composeStart}>
        <span className={styles.draftActionsStart}>
          <Button size="sm" variant="secondary" leadingIcon={<PencilIcon size={15} />} disabled={Boolean(blockedBy)} onClick={() => start()}>
            {t("tickets.panels.compose.create")}
          </Button>
          {refused && !blockedBy && (
            <Button size="sm" variant="tertiary" onClick={() => start(refused.bodyHtml ?? textToReplyHtml(refused.bodyText, null))}>
              {t("tickets.panels.compose.copyBack")}
            </Button>
          )}
        </span>
        <p className={styles.stamp}>{blockedBy ?? t("tickets.panels.compose.createHint")}</p>
      </div>
    );
  }

  return (
    <div className={styles.composer}>
      <h4>{t("tickets.panels.compose.title", { name: requesterName(ticket, t) })}</h4>
      <ReplyEditor key={open.key} initialHtml={open.seed} onChange={setHtml} label={t("tickets.panels.compose.label")} disabled={sending} />
      <div className={styles.draftActions}>
        <span className={styles.draftActionsStart}>
          <Button size="sm" variant="secondary" disabled={sending} onClick={() => setOpen(null)}>
            {t("tickets.panels.draft.cancel")}
          </Button>
        </span>
        <span className={styles.draftActionsEnd}>
          <Button size="sm" variant="primary" leadingIcon={<SendIcon size={15} />} loading={sending} disabled={sending || replyHtmlIsEmpty(html)} onClick={send}>
            {holdsInDrafts ? t("tickets.panels.compose.sendDraft") : t("tickets.panels.compose.send")}
          </Button>
        </span>
      </div>
      <p className={styles.stamp}>{t("tickets.panels.compose.afterNote")}</p>
      {sendError && <p className={styles.inlineError} role="alert">{sendError}</p>}
    </div>
  );
}

function DraftExplanation({ detail, draft }: { detail: TicketDetail | null; draft: TicketDraft }) {
  const t = useT();
  const sources = [
    detail?.order?.orderName ? t("tickets.panels.orderNumber", { number: detail.order.orderName }) : null,
    ...(detail?.order?.tracking ?? []).map((parcel) => t("tickets.panels.tracking", { number: parcel.number })),
    detail?.results ? t("tickets.panels.draft.caseInvestigation") : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <details className={styles.draftExplanation}>
      <summary>ⓘ {t("tickets.panels.draft.whyTitle")}</summary>
      <dl>
        <div>
          <dt>{t("tickets.panels.draft.situation")}</dt>
          <dd>{detail?.results?.headline ?? t("tickets.panels.draft.noAnalysis")}</dd>
        </div>
        <div>
          <dt>{t("tickets.panels.draft.state")}</dt>
          <dd>{t(`tickets.view.verdict.${draft.sourceVerdict}`)}</dd>
        </div>
        {detail?.results?.action && (
          <div>
            <dt>{t("tickets.panels.draft.missingAction")}</dt>
            <dd>{detail.results.action}</dd>
          </div>
        )}
        {sources.length > 0 && (
          <div>
            <dt>{t("tickets.panels.draft.sources")}</dt>
            <dd>{sources.join(" · ")}</dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function draftStatusText(draft: TicketDraft, t: Translate): string {
  if (draft.disposition === "terminal") return t("tickets.panels.draft.terminal");
  if (draft.sourceVerdict === "needs_customer_input") return t("tickets.panels.draft.intermediaryCustomer");
  return t("tickets.panels.draft.intermediaryColleague");
}

function TicketContextPane({
  ticket,
  detail,
  thread,
  error,
  onOrderChanged,
  onCaseStateChanged,
}: {
  ticket: TicketListItem;
  detail: TicketDetail | null;
  thread: TicketThread | null;
  error: string | null;
  onOrderChanged: (change: TicketChange) => void;
  onCaseStateChanged: (change: TicketCaseChange) => void;
}) {
  const t = useT();
  const results = detail?.results ?? null;
  const order = detail?.order ?? results?.candidateOrder ?? null;
  const isCandidate = !detail?.order && Boolean(results?.candidateOrder);
  // The stored number, which a change must still match. It can exist before its
  // bundle does, so it is read off the ticket rather than off `order`.
  const currentOrder = detail?.orderNumber ?? null;

  // Which control opened the popup. Kept per pane: the rail and the mobile sheet
  // each render one, and only the one clicked opens.
  const [orderDialog, setOrderDialog] = useState<{ source: TicketOrderLinkSource; initialNumber: string | null } | null>(null);
  // Tied to the ticket it describes, so moving to another ticket does not carry it over.
  const [orderNotice, setOrderNotice] = useState<{ ticketId: string; text: string } | null>(null);

  const openAdd = () => setOrderDialog({ source: "add", initialNumber: null });
  const openEdit = () => setOrderDialog({ source: "edit", initialNumber: null });

  // « EDIT CASE »: one mode for the whole rail, one Save. Everything the agent
  // derived (investigation, case, required action, rule) stays read-only; only
  // the fields a person may correct turn into pickers where they stand.
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<TicketOverrideChanges>({});
  // WHICH action is saving, not only whether one is: the spinner goes on the
  // button that was clicked (« Save », or the one « Apply » row), and the rail
  // says what it is doing while the request is out.
  const [savingAction, setSavingAction] = useState<{ kind: "edit" } | { kind: "apply"; key: string } | null>(null);
  const saving = savingAction !== null;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ ticketId: string; text: string } | null>(null);
  // Another ticket opened: whatever was being edited belonged to the last one.
  useEffect(() => {
    setEditing(false);
    setPending({});
    setSaveError(null);
  }, [ticket.id]);

  const overrides = ticket.overrides ?? {};
  const situationOverride = detail?.situationOverride ?? null;
  const overrideOf = (name: TicketOverrideField): TicketOverride | null =>
    name === "situation" ? situationOverride : overrides[name] ?? null;
  const setField = (name: TicketOverrideField, value: string | number | null) =>
    setPending((current) => ({ ...current, [name]: value }));
  const keepField = (name: TicketOverrideField) =>
    setPending((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  const cancelEdit = () => {
    setEditing(false);
    setPending({});
    setSaveError(null);
  };

  const save = async (changes: TicketOverrideChanges, source: "edit_case" | "closest_situation") => {
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    setSavingAction(source === "closest_situation" && typeof changes.situation === "string"
      ? { kind: "apply", key: changes.situation }
      : { kind: "edit" });
    setSaveError(null);
    // The previous result no longer describes the ticket once a new save is out.
    setSaveNotice(null);
    try {
      const result = await saveTicketOverrides(ticket.id, { changes, expected: { status: ticket.status }, source });
      onOrderChanged(result);
      setSaveNotice({ ticketId: ticket.id, text: overrideNotice(result, t) });
      setEditing(false);
      setPending({});
    } catch (cause) {
      setSaveError(knowledgeErrorMessage(cause));
    } finally {
      setSavingAction(null);
    }
  };

  /** A picker in edit mode; the value with its override mark otherwise. */
  const field = (
    name: TicketOverrideField,
    shown: ReactNode,
    options: { value: string; label: string; disabled?: boolean }[],
    current: string
  ): ReactNode => {
    const override = overrideOf(name);
    if (!editing) {
      if (!shown) return null;
      return (
        <>
          {shown}
          {override && <OverrideMark override={override} field={name} />}
        </>
      );
    }
    const chosen = name in pending ? pending[name] : undefined;
    const resetting = chosen === null;
    return (
      <span className={styles.editField}>
        <select
          className={styles.fieldSelect}
          aria-label={t(`tickets.panels.field.${name}`)}
          value={chosen !== undefined && chosen !== null ? String(chosen) : current}
          disabled={saving || resetting}
          onChange={(event) => setField(name, event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        {override && (
          <button
            type="button"
            className={styles.resetLink}
            disabled={saving}
            onClick={() => (resetting ? keepField(name) : setField(name, null))}
          >
            {resetting ? t("tickets.panels.keepMine") : t("tickets.panels.resetAuto")}
          </button>
        )}
      </span>
    );
  };

  return (
    <div className={styles.contextScroll} aria-busy={saving || undefined}>
      <div className={styles.editBar}>
        {editing ? (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={savingAction?.kind === "edit"}
              disabled={saving}
              onClick={() => save(pending, "edit_case")}
            >
              {savingAction?.kind === "edit" ? t("tickets.panels.saving") : t("tickets.panels.save")}
            </Button>
            <Button size="sm" variant="tertiary" disabled={saving} onClick={cancelEdit}>
              {t("tickets.panels.draft.cancel")}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" leadingIcon={<PencilIcon size={14} />} onClick={() => setEditing(true)}>
            {t("tickets.panels.editCase")}
          </Button>
        )}
      </div>
      {editing && (
        <p className={styles.reason}>
          {t("tickets.panels.editNote")}
        </p>
      )}
      {savingAction && (
        <p className={styles.savingStatus} role="status">
          <span className={styles.savingSpinner} aria-hidden="true" />
          {savingAction.kind === "apply"
            ? t("tickets.panels.applyingStatus", { situation: savingAction.key })
            : t("tickets.panels.savingStatus")}
        </p>
      )}
      {saveError && <p className={styles.inlineError} role="alert">{saveError}</p>}
      {saveNotice?.ticketId === ticket.id && !editing && (
        <p className={styles.orderNotice} role="status">{saveNotice.text}</p>
      )}

      <ContextSection title={t("tickets.panels.section.customer")}>
        <InfoList
          rows={[
            [t("tickets.panels.row.name"), requesterName(ticket, t)],
            [t("tickets.panels.row.email"), thread ? contactingAddress(thread) : null],
            [t("tickets.panels.row.segment"), ticket.rfmGroup],
            [t("tickets.panels.row.vip"), ticket.isVip ? t("tickets.panels.yes") : null],
            [t("tickets.panels.row.sender"), ticket.senderLabel ? t(`sender.${ticket.senderLabel}`) : t("tickets.panels.consumer")],
          ]}
        />
      </ContextSection>

      <ContextSection title={t("tickets.panels.section.ticket")}>
        <InfoList
          rows={[
            [
              t("tickets.panels.row.category"),
              field(
                "category",
                ticket.category ? t(`category.${ticket.category}`) : t("tickets.panels.uncategorised"),
                [
                  ...(ticket.category ? [] : [{ value: "", label: t("tickets.panels.uncategorised"), disabled: true }]),
                  ...TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) })),
                ],
                ticket.category ?? ""
              ),
            ],
            [t("tickets.panels.row.secondary"), ticket.secondaryCategory ? t(`category.${ticket.secondaryCategory}`) : null],
            [
              t("tickets.panels.row.level"),
              field(
                "level",
                ticket.level ? `${t(`levelMeaning.${ticket.level}`)} (L${ticket.level})` : t("tickets.panels.uncategorised"),
                [
                  ...(ticket.level ? [] : [{ value: "", label: t("tickets.panels.uncategorised"), disabled: true }]),
                  ...([1, 2, 3, 4] as const).map((level) => ({
                    value: String(level),
                    label: `${t(`levelMeaning.${level}`)} (L${level})`,
                  })),
                ],
                ticket.level ? String(ticket.level) : ""
              ),
            ],
            [
              t("tickets.panels.row.state"),
              field(
                "status",
                t(`status.${ticket.status}`),
                [
                  // An agent-set state is shown, never offered: a person sets these three.
                  ...(PERSON_STATUSES.includes(ticket.status)
                    ? []
                    : [{ value: ticket.status, label: t(`status.${ticket.status}`), disabled: true }]),
                  ...PERSON_STATUSES.map((status) => ({ value: status, label: t(`status.${status}`) })),
                ],
                ticket.status
              ),
            ],
            [
              t("tickets.panels.row.team"),
              field(
                "responsible_team",
                ticket.responsibleTeam ? t(`team.${ticket.responsibleTeam}`) : null,
                [
                  ...(ticket.responsibleTeam ? [] : [{ value: "", label: t("tickets.panels.none"), disabled: true }]),
                  ...TEAMS.map((team) => ({ value: team, label: t(`team.${team}`) })),
                ],
                ticket.responsibleTeam ?? ""
              ),
            ],
            [t("tickets.panels.row.messages"), String(ticket.messageCount)],
            [t("tickets.panels.row.lastActivity"), ticketAge(ticket, t)],
            [
              t("tickets.panels.row.priority"),
              field(
                "priority",
                `${formatPriorityScore(ticket.priorityScore)} (${priorityLabel(ticket, t)})`,
                PRIORITY_BANDS.map((band) => ({ value: band, label: t(`tickets.view.priority.${band}`) })),
                ticket.priorityBand
              ),
            ],
          ]}
        />
      </ContextSection>

      <ContextSection title={t("tickets.panels.section.order")}>
        {error ? (
          <p className={styles.inlineError} role="alert">{error}</p>
        ) : !detail ? (
          <ContextSkeleton />
        ) : order ? (
          <>
            <OrderFactsBlock
              order={order}
              candidate={isCandidate}
              onEdit={isCandidate ? undefined : openEdit}
              // The order page opens with a way back to this ticket.
              orderHref={!isCandidate && detail?.orderId ? `/orders/${detail.orderId}?ticket=${ticket.id}` : null}
            />
            {isCandidate && (
              <div className={styles.orderActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!order.orderName}
                  onClick={() => setOrderDialog({ source: "candidate", initialNumber: order.orderName })}
                >
                  {t("tickets.panels.order.confirm")}
                </Button>
                <Button size="sm" variant="tertiary" leadingIcon={<PlusIcon size={14} />} onClick={openAdd}>
                  {t("tickets.panels.order.add")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className={styles.muted}>
              {currentOrder
                ? t("tickets.panels.order.linkedUnread", { number: currentOrder })
                : t("tickets.panels.order.none")}
            </p>
            <div className={styles.orderActions}>
              {currentOrder ? (
                <Button size="sm" variant="secondary" leadingIcon={<PencilIcon size={14} />} onClick={openEdit}>
                  {t("tickets.panels.order.change")}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" leadingIcon={<PlusIcon size={14} />} onClick={openAdd}>
                  {t("tickets.panels.order.add")}
                </Button>
              )}
            </div>
          </>
        )}
        {orderNotice?.ticketId === ticket.id && (
          <p className={styles.orderNotice} role="status">{orderNotice.text}</p>
        )}
        {orderDialog && (
          <OrderLinkDialog
            ticketId={ticket.id}
            currentOrder={currentOrder}
            source={orderDialog.source}
            initialNumber={orderDialog.initialNumber}
            onClose={() => setOrderDialog(null)}
            onChanged={(change) => {
              setOrderDialog(null);
              setOrderNotice({
                ticketId: ticket.id,
                text:
                  change.reinvestigation === "queued"
                    ? t("tickets.panels.order.linkedQueued", { order: change.detail.orderNumber ?? t("tickets.panels.order.theOrder") })
                    : t("tickets.panels.order.linkedClosed", { order: change.detail.orderNumber ?? t("tickets.panels.order.theOrder") }),
              });
              onOrderChanged(change);
            }}
          />
        )}
      </ContextSection>

      <ContextSection title={t("tickets.panels.section.investigation")}>
        {error ? (
          <p className={styles.inlineError} role="alert">{error}</p>
        ) : !detail ? (
          <ContextSkeleton />
        ) : results ? (
          <InvestigationBlock detail={detail} />
        ) : (
          <p className={styles.muted}>
            {t("tickets.panels.investigation.none")}
          </p>
        )}
      </ContextSection>

      {detail && (
        <CaseSection ticketId={ticket.id} caseState={detail.caseState ?? null} onChanged={onCaseStateChanged} />
      )}

      <ContextSection title={t("tickets.panels.section.requiredAction")}>
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
          <p className={styles.actionText}>{t("tickets.panels.triageByHand")}</p>
        )}
      </ContextSection>

      {/* ABSENT ON MOST TICKETS. 310 of 400 carry no attachment and no mention of
          one, so a permanent "Attachments — none" heading would push the
          sections above it off a pane that already scrolls. */}
      <AttachmentsSection detail={detail} error={error} />

      {/* LAST, because it answers "why does this say what it says" rather than
          "what does it say" — an operator reads the verdict and the action
          first, and comes here when one of them surprises them. */}
      <PolicySection
        policy={detail?.policy ?? null}
        situationOverride={situationOverride}
        situations={detail?.situations ?? []}
        editing={editing}
        picked={"situation" in pending ? (pending.situation === null ? null : String(pending.situation)) : undefined}
        saving={saving}
        applying={savingAction?.kind === "apply" ? savingAction.key : null}
        onPick={(key) => setField("situation", key)}
        onReset={() => setField("situation", null)}
        onKeep={() => keepField("situation")}
        onApply={(key) => save({ situation: key }, "closest_situation")}
      />
    </div>
  );
}

/** Any change the rail makes to one ticket: the queue row and the detail, replaced together. */
type TicketChange = { ticket: TicketListItem; detail: TicketDetail };

const PERSON_STATUSES: TicketListItem["status"][] = ["open", "resolved", "closed"];

const TEAMS = Object.keys(RESPONSIBLE_TEAM_LABELS) as (keyof typeof RESPONSIBLE_TEAM_LABELS)[];
// Team, status, category and level words come from the shared `team.*`, `status.*`,
// `category.*` and `levelMeaning.*` keys.

const PRIORITY_BANDS: TicketPriorityBand[] = ["high", "medium", "low"];

/** What a Save did, in one line: a re-run, withdrawn drafts, or nothing else. */
function overrideNotice(result: TicketOverrideResult, t: Translate): string {
  const parts: string[] = [];
  if (result.requeued) parts.push(t("tickets.panels.override.requeued"));
  if (result.notInvestigable) parts.push(t("tickets.panels.override.notInvestigable"));
  if (result.draftsStaled > 0) parts.push(t("tickets.panels.override.withdrawn", { count: result.draftsStaled }));
  return parts.length > 0 ? t("tickets.panels.override.saved", { details: parts.join(" ") }) : t("tickets.panels.override.savedNothing");
}

/** « Human override », with what the pipeline says on hover. */
function OverrideMark({ override, field }: { override: TicketOverride; field: TicketOverrideField }) {
  const t = useT();
  const automatic = override.aiValue === null ? t("tickets.panels.none").toLowerCase() : automaticWords(field, override.aiValue, t);
  return (
    <span className={styles.overrideMark} title={t("tickets.panels.override.automatic", { value: automatic })}>
      {t("tickets.panels.override.mark")}
    </span>
  );
}

function automaticWords(field: TicketOverrideField, value: string | number, t: Translate): string {
  if (field === "category") return t(`category.${value}`);
  if (field === "level") return `L${value}`;
  if (field === "status") return t(`status.${value}`);
  if (field === "responsible_team") return t(`team.${value}`);
  if (field === "priority") return t(`tickets.view.priority.${value}`);
  return String(value);
}

/**
 * The case as it stands (stage 5 of the case-state plan): who acts next, the
 * checks our side owes, and what the customer still owes us.
 *
 * READ-ONLY EXCEPT FOR ONE ACTION. A check settled outside email (by phone, in
 * Shopify, by Deret) is marked done here, or cancelled when it no longer
 * matters. That writes one row and re-folds the case; it changes no status and
 * sends nothing. Overdue is an alert only, from the shop's parameters.
 *
 * SHOWN BESIDE THE STATUS, NOT INSTEAD OF IT: the status still follows the
 * investigation until « who acts next » has proved itself on real tickets.
 */
function CaseSection({
  ticketId,
  caseState,
  onChanged,
}: {
  ticketId: string;
  caseState: TicketCaseState | null;
  onChanged: (change: TicketCaseChange) => void;
}) {
  const t = useT();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!caseState) {
    return (
      <ContextSection title={t("tickets.panels.section.case")}>
        <p className={styles.muted}>{t("tickets.panels.case.notRead")}</p>
      </ContextSection>
    );
  }

  const open = caseState.obligations.filter((o) => o.status === "pending");
  // A rule's later steps, in order: owed by nobody yet, shown so the next move is known.
  const queued = caseState.obligations
    .filter((o) => o.status === "queued")
    .sort((a, b) => (a.ruleStep?.step ?? 0) - (b.ruleStep?.step ?? 0));
  const act = async (obligation: TicketObligation, action: "fulfilled" | "cancelled") => {
    setPending(obligation.id);
    setFailure(null);
    try {
      onChanged(await actOnObligation(ticketId, obligation.id, action));
    } catch (cause) {
      setFailure(knowledgeErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <ContextSection title={t("tickets.panels.section.case")}>
      <InfoList rows={[[t("tickets.panels.case.next"), caseState.nextActor ? t(`tickets.panels.case.actor.${caseState.nextActor}`) : t("tickets.panels.case.unknown")]]} />
      {open.length > 0 && (
        <ul className={styles.caseChecks} aria-label={t("tickets.panels.case.openChecks")}>
          {open.map((obligation) => (
            <li key={obligation.id} className={obligation.overdue ? styles.caseCheckOverdue : styles.caseCheck}>
              <p className={styles.actionText}>
                {t(`tickets.panels.case.owner.${obligation.owner}`)}: {needText(t, obligation.need, obligation.needLabel)}
              </p>
              <p className={styles.reason}>
                {obligation.workingDaysOpen === null
                  ? t("tickets.panels.case.open")
                  : t("tickets.panels.case.openDays", { count: obligation.workingDaysOpen })}
                {obligation.overdue ? ` · ${t("tickets.panels.case.overdue")}` : ""}
                {obligation.ruleStep
                  ? ` · ${t("tickets.panels.case.step", { step: obligation.ruleStep.step, steps: obligation.ruleStep.steps, rule: obligation.ruleStep.rule })}`
                  : ""}
              </p>
              <div className={styles.orderActions}>
                <Button size="sm" variant="secondary" disabled={pending !== null} onClick={() => act(obligation, "fulfilled")}>
                  {t("tickets.panels.case.markDone")}
                </Button>
                <Button size="sm" variant="tertiary" disabled={pending !== null} onClick={() => act(obligation, "cancelled")}>
                  {t("tickets.panels.case.noLongerNeeded")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {queued.length > 0 && (
        <p className={styles.reason}>
          {t("tickets.panels.case.then", { steps: queued.map((step) => `${t(`tickets.panels.case.owner.${step.owner}`)}: ${needText(t, step.need, step.needLabel)}`).join(t("tickets.panels.case.thenSeparator")) })}
        </p>
      )}
      {caseState.pendingQuestions.length > 0 && (
        <p className={styles.reason}>
          {t("tickets.panels.case.waiting", { items: caseState.pendingQuestions.map((q) => questionText(t, q.key, q.label)).join(", ") })}
        </p>
      )}
      {open.length === 0 && caseState.pendingQuestions.length === 0 && (
        <p className={styles.muted}>{t("tickets.panels.case.nothing")}</p>
      )}
      {failure && <p className={styles.inlineError} role="alert">{failure}</p>}
    </ContextSection>
  );
}

/** « Name (KEY) »: the name is what a person reads, the key what the rulebook is searched by. */
function situationLabel(key: string, name: string | null | undefined): ReactNode {
  return (
    <>
      {name ?? key}
      {name && <span className={styles.situationKey}> {key}</span>}
    </>
  );
}

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
 * THE NAME LEADS AND THE RAW KEY FOLLOWS (`PR-29`, `pr29_equivalent_partiel`):
 * the key is still what the rulebook screen is searched by, so it stays on
 * screen, small, rather than being translated away.
 *
 * THE SITUATION IS THE ONE FIELD HERE A PERSON MAY CORRECT. In « Edit case » it
 * becomes a picker; when the match was not settled, the nearest three are
 * offered with « Apply », which saves at once. The rule is never picked: it is
 * re-derived by the investigation from the corrected situation.
 */
function PolicySection({
  policy,
  situationOverride,
  situations,
  editing,
  picked,
  saving,
  applying,
  onPick,
  onReset,
  onKeep,
  onApply,
}: {
  policy: TicketPolicy | null;
  situationOverride: TicketOverride | null;
  situations: TicketSituationOption[];
  editing: boolean;
  /** The situation chosen in this edit: a key, null to reset, undefined when untouched. */
  picked: string | null | undefined;
  saving: boolean;
  /** The situation whose « Apply » is out, for its spinner. */
  applying: string | null;
  onPick: (key: string) => void;
  onReset: () => void;
  onKeep: () => void;
  onApply: (key: string) => void;
}) {
  const t = useT();
  // No investigation ran and nobody chose a situation: there is no decision to
  // explain, and an empty heading would read as one that was made badly.
  if (!policy && !situationOverride && !editing) {
    return null;
  }
  const names = new Map(situations.map((row) => [row.key, row.question]));
  const overrideKey = situationOverride ? String(situationOverride.value) : null;
  // The correction is saved but the next run has not used it yet.
  const awaitingRun = Boolean(overrideKey && overrideKey !== policy?.situation);
  const current = overrideKey ?? policy?.situation ?? null;

  const asked = policy
    ? [
        policy.route ? t("tickets.panels.policy.route", { to: policy.route.replace(/_/g, " ") }) : null,
        policy.asks.length > 0 ? t("tickets.panels.policy.ask", { items: policy.asks.join(", ").replace(/_/g, " ") }) : null,
        policy.offerCode ? t("tickets.panels.policy.offer", { code: policy.offerCode }) : null,
        // Which company policies the case read, and why (linked or fetched).
        policy.companyPolicies.length > 0
          ? t("tickets.panels.policy.companyPolicies", {
              items: policy.companyPolicies
                .map((p) => `${p.key}${p.version ? ` v${p.version}` : ""} (${t(`tickets.panels.policy.policySource.${p.source}`)})`)
                .join(", "),
            })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const shownSituation: ReactNode = current ? (
    <>
      {situationLabel(current, names.get(current) ?? policy?.situationName)}
      {situationOverride ? (
        <OverrideMark override={situationOverride} field="situation" />
      ) : policy?.match ? (
        <span className={styles.situationKey}> · {["matched", "near", "ambiguous", "none"].includes(policy.match) ? t(`tickets.panels.policy.match.${policy.match}`) : policy.match}</span>
      ) : null}
    </>
  ) : (
    t("tickets.panels.policy.noneSettled")
  );

  const resetting = picked === null;
  const situationCell: ReactNode = editing ? (
    <span className={styles.editField}>
      <select
        className={styles.fieldSelect}
        aria-label={t("tickets.panels.field.situation")}
        value={typeof picked === "string" ? picked : current ?? ""}
        disabled={saving || resetting}
        onChange={(event) => onPick(event.target.value)}
      >
        {!current && <option value="" disabled>{t("tickets.panels.policy.noneSettled")}</option>}
        {situations.map((row) => (
          <option key={row.key} value={row.key}>
            {row.question} ({row.key})
          </option>
        ))}
      </select>
      {situationOverride && (
        <button type="button" className={styles.resetLink} disabled={saving} onClick={resetting ? onKeep : onReset}>
          {resetting ? t("tickets.panels.keepMine") : t("tickets.panels.resetAuto")}
        </button>
      )}
    </span>
  ) : (
    shownSituation
  );

  // THE NEAREST THREE, offered only while the situation is unsettled and nobody
  // has chosen one: on a clean match they would be noise.
  const offerNearest = !editing && !situationOverride && policy && policy.match !== "matched" && policy.nearest.length > 0;

  return (
    <ContextSection title={t("tickets.panels.section.policy")}>
      <InfoList
        rows={[
          [t("tickets.panels.field.situation"), situationCell],
          [
            t("tickets.panels.policy.rule"),
            awaitingRun
              ? t("tickets.panels.policy.rederived")
              : policy?.rule
                ? [
                    policy.rule,
                    policy.changedVerdict ? t("tickets.panels.policy.changed") : t("tickets.panels.policy.unchanged"),
                    policy.ruleVerdict && policy.ruleVerdict !== "selected" ? policy.ruleVerdict : null,
                  ]
                    .filter(Boolean)
                    .join(" — ")
                : t("tickets.panels.policy.noRule"),
          ],
          [t("tickets.panels.policy.askedFor"), awaitingRun ? null : asked || null],
        ]}
      />
      {offerNearest && (
        <div className={styles.nearest}>
          <p className={styles.reason}>{t("tickets.panels.policy.closest")}</p>
          <ul className={styles.nearestList}>
            {policy.nearest.map((row) => (
              <li key={row.key}>
                <span className={styles.nearestName}>{situationLabel(row.key, row.name ?? names.get(row.key))}</span>
                <Button
                  size="sm"
                  variant="tertiary"
                  loading={applying === row.key}
                  disabled={saving}
                  onClick={() => onApply(row.key)}
                >
                  {applying === row.key ? t("tickets.panels.policy.applying") : t("tickets.panels.policy.apply")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  const t = useT();
  const locale = useLocale();
  const attachments = detail?.attachments ?? null;
  if (error || !attachments) return null;

  const { images, others, furniture, known, mentioned, matchedTerm } = attachments;
  const missing = mentioned && images.length === 0;
  if (images.length === 0 && others.length === 0 && !missing && known) return null;

  return (
    <ContextSection title={t("tickets.panels.section.attachments")}>
      {missing && (
        <p className={styles.attachmentWarning}>
          {t("tickets.panels.attach.mentions")}
          {matchedTerm ? <> (“{matchedTerm}”)</> : null} {t("tickets.panels.attach.butNone")}
        </p>
      )}

      {!known && (
        /* The `attachments` column's null, surfaced. Saying "no photo" about a
           message whose own flag says otherwise is the one wrong answer here. */
        <p className={styles.muted}>
          {t("tickets.panels.attach.unknownType")}
        </p>
      )}

      {images.length > 0 && (
        <ul className={styles.photoGrid}>
          {images.map((file, index) => (
            <li key={`${file.name ?? "image"}-${index}`}>
              <AttachmentPhoto file={file} />
              <span className={styles.photoCaption}>
                {file.name ?? t("tickets.panels.attach.unnamedImage")} · {describeAttachment(file, t, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <ul className={styles.attachmentFiles}>
          {others.map((file, index) => (
            <li key={`${file.name ?? "file"}-${index}`}>
              {file.name ?? t("tickets.panels.attach.unnamedFile")} · {describeAttachment(file, t, locale)}
            </li>
          ))}
        </ul>
      )}

      {furniture > 0 && (
        <p className={styles.muted}>
          {t("tickets.panels.attach.ignored", { count: furniture })}
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
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  if (!file.src || failed) {
    return (
      <span className={styles.photoMissing}>
        {t(`tickets.panels.attachReason.${reason && ATTACHMENT_REASON_KEYS.includes(reason) ? reason : "fallback"}`)}
      </span>
    );
  }

  return (
    <a href={file.src} target="_blank" rel="noreferrer" className={styles.photoLink}>
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        className={styles.photoThumb}
        src={file.src}
        alt={file.name ?? t("tickets.panels.attach.photoAlt")}
        loading="lazy"
        // The reason travels as a response header and an `<img>` cannot read
        // one, so the failure path asks the route directly. Until it answers,
        // the neutral sentence stands rather than a guess at the cause.
        onError={() => {
          setFailed(true);
          if (file.src) {
            void fetchAttachmentReasonKey(file.src).then(setReason);
          }
        }}
      />
    </a>
  );
}

/** "JPEG · 820 KB" — the two things that separate a phone photo from a logo. */
function describeAttachment(file: TicketAttachmentFile, t: Translate, locale: Locale): string {
  const subtype = file.contentType?.split("/")[1]?.toUpperCase() ?? null;
  const size = formatAttachmentBytes(file.size, t, locale);
  return [subtype, size].filter(Boolean).join(" · ");
}

/** Bytes as a person reads them. 0 means Graph did not record a size. */
function formatAttachmentBytes(size: number, t: Translate, locale: Locale): string | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size < 1024) return t("tickets.panels.attach.bytes", { n: size });
  if (size < 1024 * 1024) return t("tickets.panels.attach.kilobytes", { n: Math.round(size / 1024) });
  return t("tickets.panels.attach.megabytes", { n: formatNumber(size / (1024 * 1024), locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.contextSection}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function InfoList({ rows }: { rows: [string, ReactNode][] }) {
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

function OrderFactsBlock({
  order,
  candidate,
  onEdit,
  orderHref = null,
}: {
  order: TicketOrderFacts;
  candidate: boolean;
  /** Present on a confirmed order: the pencil beside its number. */
  onEdit?: () => void;
  /** The order page, carrying this ticket so that page can offer the way back. */
  orderHref?: string | null;
}) {
  const t = useT();
  const orderName = orderHref && order.orderName ? (
    <a className={styles.orderLink} href={orderHref}>
      {order.orderName}
    </a>
  ) : (
    order.orderName
  );
  const orderValue =
    onEdit && order.orderName ? (
      <span className={styles.orderValue}>
        {orderName}
        <button type="button" className={styles.iconButton} aria-label={t("tickets.panels.order.change")} title={t("tickets.panels.order.change")} onClick={onEdit}>
          <PencilIcon size={14} />
        </button>
      </span>
    ) : (
      orderName
    );

  return (
    <div className={styles.orderFacts}>
      {candidate && <p className={styles.candidateNote}>{t("tickets.panels.order.candidateNote")}</p>}
      {!candidate && order.buyerUnverified && (
        <p className={styles.candidateNote}>
          {t("tickets.panels.order.anonymous", { channel: order.channel ?? t("tickets.panels.order.marketplace") })}
        </p>
      )}
      {!candidate && order.linkedByPerson && (
        <p className={styles.candidateNote}>{t("tickets.panels.order.linkedByPerson")}</p>
      )}
      <InfoList
        rows={[
          [candidate ? t("tickets.panels.order.lastOrder") : t("tickets.panels.section.order"), orderValue],
          // Named here as well as in the detail panel: this block is the one a
          // reviewer reads first, and a marketplace order changes how the
          // status and tracking lines under it should be read. Null on a web
          // order, and `InfoList` drops a null row.
          [t("tickets.panels.order.channel"), order.channel],
          [t("tickets.panels.order.nameOnOrder"), order.customerName],
          [t("tickets.panels.order.contact"), order.contactEmail],
          [t("tickets.panels.order.status"), order.orderStatus],
          [t("tickets.panels.order.trackingStatus"), order.trackingStatus],
          // On BOTH blocks. It was candidate-only on the reasoning that a
          // confirmed order is already the right one, but what was bought is
          // the line a reviewer needs to answer the reply itself — which
          // product the complaint is about, whether the parcel that is late
          // holds one item or four.
          [t("tickets.panels.order.items"), order.items.length > 0 ? order.items.join(", ") : null],
        ]}
      />
      {order.tracking.length > 0 && (
        <div className={styles.trackingList}>
          <span>{t("tickets.panels.order.tracking")}</span>
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
        <p className={styles.stamp}>{t("tickets.panels.order.dataRead")} <time dateTime={order.resolvedAt}>{formatRelativeTime(order.resolvedAt, t)}</time></p>
      )}
    </div>
  );
}

function InvestigationBlock({ detail }: { detail: TicketDetail }) {
  const t = useT();
  const results = detail.results;
  if (!results) return null;

  return (
    <div className={styles.investigation}>
      <p className={`${styles.verdict} ${styles[`verdict_${results.verdict}`]}`}>{t(`tickets.view.verdict.${results.verdict}`)}</p>
      <p className={styles.resultHeadline}>{results.headline}</p>
      {results.investigatedAt && (
        <p className={styles.stamp}>{t("tickets.panels.investigation.investigated")} <time dateTime={results.investigatedAt}>{formatRelativeTime(results.investigatedAt, t)}</time></p>
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
        <p className={styles.muted}>{t("tickets.panels.investigation.nothing")}</p>
      )}
    </div>
  );
}

function TicketLevelBadge({ ticket }: { ticket: TicketListItem }) {
  const t = useT();
  const status = t(`status.${ticket.status}`);
  return (
    <span className={`${styles.levelBadge} ${statusClass(ticket)}`}>
      {ticket.level ? `L${ticket.level} ${t(`levelMeaning.${ticket.level}`)}` : t("tickets.panels.uncategorised")}
      {ticket.status !== "open" ? ` - ${status}` : ""}
    </span>
  );
}

function MessageBlock({
  message,
  parcels,
  itemRef,
}: {
  message: TicketMessage;
  parcels: TicketTracking[];
  itemRef?: RefObject<HTMLLIElement>;
}) {
  const t = useT();
  const locale = useLocale();
  const role = t(`tickets.panels.role.${message.role}`);
  const route = message.routeTo.length > 0 ? `${role} → ${message.routeTo.join(" + ")}` : null;
  const entities = messageEntities(message, parcels);
  const address = message.fromEmail?.trim() || undefined;

  return (
    <li className={styles.message} ref={itemRef}>
      <span className={`${styles.timelineAvatar} ${styles[`role_${message.role}`]}`} data-email={address}>
        <span aria-hidden="true">{senderInitials(message, t)}</span>
      </span>
      <article className={styles.messageContent}>
        <header className={styles.messageHead}>
          <div className={styles.senderLine}>
            <span className={styles.sender} data-email={address}>{senderDisplayName(message, t)}</span>
            <span className={`${styles.roleBadge} ${styles[`role_${message.role}`]}`}>{role}</span>
            {message.hasAttachments && <span className={styles.attachment}>{t("tickets.panels.attachment")}</span>}
          </div>
          {message.at && <time className={styles.when} dateTime={message.at}>{formatExactTime(message.at, locale)}</time>}
        </header>

        {route && <p className={styles.messageRoute}>{message.isForward ? `${t("tickets.panels.message.forwarded")} · ${route}` : route}</p>}

        {message.bodyClean?.trim() ? (
          <pre className={styles.messageBody}>
            <TrackingText text={message.bodyClean} parcels={parcels} />
          </pre>
        ) : message.isForward ? (
          <p className={styles.forwardLabel}>{t("tickets.panels.message.forwardedEmail")}</p>
        ) : (
          <p className={styles.placeholder}>{t("tickets.panels.message.noBody")}</p>
        )}

        {entities.length > 0 && (
          <div className={styles.entityList} aria-label={t("tickets.panels.message.references")}>
            {entities.map((entity) => (
              <span className={styles.entityChip} key={`${entity.kind}-${entity.value}`}>
                {entity.kind === "tracking" ? (
                  <TrackingText text={t("tickets.panels.tracking", { number: entity.value })} parcels={parcels} />
                ) : (
                  `${t(`tickets.panels.entity.${entity.kind}`)} ${entity.value}`
                )}
              </span>
            ))}
          </div>
        )}

        <div className={styles.messageDisclosures}>
          {message.quotedBody && (
            <details>
              <summary>↳ {t("tickets.panels.message.showQuoted", { count: message.quotedMessageCount })}</summary>
              <pre><TrackingText text={message.quotedBody} parcels={parcels} /></pre>
            </details>
          )}
          {message.forwardedContent && (
            <details>
              <summary>{t("tickets.panels.message.viewForwarded")}</summary>
              <pre><TrackingText text={message.forwardedContent} parcels={parcels} /></pre>
            </details>
          )}
          {message.signature && (
            <details>
              <summary>{t("tickets.panels.message.showSignature")}</summary>
              <pre>{message.signature}</pre>
            </details>
          )}
          {message.body && (
            <details>
              <summary>{t("tickets.panels.message.viewOriginal")}</summary>
              <pre><TrackingText text={message.body} parcels={parcels} /></pre>
            </details>
          )}
        </div>
      </article>
    </li>
  );
}

function senderDisplayName(message: TicketMessage, t: Translate): string {
  if (message.role === "qiriness") {
    const stored = message.fromName?.trim().toLowerCase() ?? "";
    if (!stored || stored === "contact" || stored.includes("service client") || stored.includes("support")) {
      return t("tickets.panels.role.qiriness");
    }
  }
  return senderIdentity(message, message.direction === "outbound", t).name;
}

/**
 * The address the requester is writing from: their latest inbound message's, so
 * someone who switched mailboxes mid-thread shows the one a reply goes to. Any
 * outside sender counts — a retailer or partner is the requester on its own
 * threads — and only a colleague's inbound note is skipped. The
 * thread route already ships (and audits) every sender address; the ticket list
 * never carries one, which is why this reads the thread and not the ticket.
 */
function contactingAddress(thread: TicketThread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i];
    if (message.direction === "inbound" && message.role !== "internal" && message.fromEmail?.trim()) {
      return message.fromEmail.trim();
    }
  }
  return null;
}

function senderInitials(message: TicketMessage, t: Translate): string {
  const name = senderDisplayName(message, t).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}

function groupMessagesByDate(messages: TicketMessage[], t: Translate, locale: Locale) {
  const groups: { key: string; label: string; messages: TicketMessage[]; isLast: boolean }[] = [];
  for (const message of messages) {
    const date = message.at ? new Date(message.at) : null;
    const valid = date && !Number.isNaN(date.getTime());
    // The local day, matching the label: a UTC key splits a 00:30 Paris message
    // off from the rest of its day under a duplicate divider.
    const key = valid
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "undated";
    const label = valid
      ? new Intl.DateTimeFormat(intlTag(locale), { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date).toUpperCase()
      : t("tickets.panels.message.dateUnknown");
    const previous = groups[groups.length - 1];
    if (previous?.key === key) previous.messages.push(message);
    else groups.push({ key, label, messages: [message], isLast: false });
  }
  if (groups.length > 0) groups[groups.length - 1].isLast = true;
  return groups;
}

function formatExactTime(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(intlTag(locale), { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatEventTime(value: string | null, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(intlTag(locale), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}


function messageEntities(message: TicketMessage, parcels: TicketTracking[]) {
  const text = message.bodyClean ?? "";
  const entities: { kind: "order" | "reference" | "tracking" | "carrier"; label: string; value: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: "order" | "reference" | "tracking" | "carrier", label: string, value: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ kind, label, value });
    }
  };

  for (const match of text.matchAll(/(?:commande|order)\s*(?:n[°ºo.]?\s*)?#?\s*(\d{4,})|#(\d{4,})/gi)) {
    add("order", "Order", `#${match[1] ?? match[2]}`);
  }
  for (const match of text.matchAll(/\b(Q\d{2}\s?\d{6,})\b/gi)) add("reference", "Reference", match[1]);
  for (const parcel of parcels) {
    if (text.toLowerCase().includes(parcel.number.toLowerCase())) {
      add("tracking", "Tracking", parcel.number);
      if (parcel.carrier) add("carrier", "Carrier", parcel.carrier);
    }
  }
  return entities.slice(0, 5);
}

function senderIdentity(message: TicketMessage, outbound: boolean, t: Translate): { name: string; email: string | null } {
  const name = message.fromName?.trim() ?? "";
  const email = message.fromEmail?.trim() ?? "";

  if (!name && !email) return { name: outbound ? t("tickets.panels.role.qiriness") : t("tickets.panels.unknownSender"), email: null };
  if (!name) return { name: email, email: null };
  if (!email) return { name, email: null };
  return { name, email: name.toLowerCase() === email.toLowerCase() ? null : email };
}

/**
 * The Irrelevant tab: the gate's drops, one preview, and the verdict beside it.
 *
 * SELECT AND CLEAR IS A LIST OPERATION, so it lives in this pane's header and
 * nowhere else. Reviewing dropped mail is reading a run of obvious junk with the
 * occasional real customer in it, and the only action that existed — Add as
 * ticket — is per email and sits three panes away in the context rail. Clearing
 * is the opposite shape: many rows at once, no consequence beyond the list, and
 * a mode you turn on rather than a button per row, because a delete-looking
 * control on every row of a list somebody scrolls fast is asking for the mis-tap
 * it would get.
 *
 * The mode is off by default and changes what a row click does — tick instead of
 * preview — so the ticks are what a row shows while it is on, and Cancel leaves
 * without touching anything.
 */
function IrrelevantWorkspace({
  mail,
  selectedMail,
  selectedId,
  onSelect,
  onPromote,
  pendingId,
  selecting,
  picked,
  clearedCount,
  total,
  loadingMore,
  onLoadMore,
  onStartSelecting,
  onCancelSelecting,
  onTogglePick,
  onClearPicked,
  onRestoreCleared,
  onPickAll,
}: {
  mail: DroppedMail[];
  selectedMail: DroppedMail | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPromote: (mail: DroppedMail) => void;
  pendingId: string | null;
  /** Select mode: a row click ticks it rather than opening it. */
  selecting: boolean;
  picked: Set<string>;
  /** Rows cleared shop-wide — the number Restore offers to bring back. */
  clearedCount: number;
  /** Every row the list holds for this search; `mail` is the pages loaded. */
  total: number;
  loadingMore: boolean;
  onLoadMore: () => void;
  onStartSelecting: () => void;
  onCancelSelecting: () => void;
  onTogglePick: (id: string) => void;
  onClearPicked: () => void;
  onRestoreCleared: () => void;
  /** Replaces the ticks with these ids: every shown row, or none. */
  onPickAll: (ids: string[]) => void;
}) {
  const t = useT();
  const locale = useLocale();
  // "All" means every row the list shows — a search narrows what Select all
  // ticks, so it never clears mail the reviewer could not see.
  const allPicked = mail.length > 0 && mail.every((item) => picked.has(item.id));
  const shown = useFullDroppedMail(selectedMail);

  return (
    <div className={`${styles.workspace} ${styles.irrelevantWorkspace} ${selectedMail ? styles.hasSelection : ""}`}>
      <aside className={styles.listPane} aria-label={t("tickets.panels.irrelevant.listLabel")}>
        <div className={styles.listHeader}>
          <div>
            <h2>{t("tickets.view.tab.irrelevant")}</h2>
            <p>
              {selecting
                ? t("tickets.panels.irrelevant.selected", { n: formatNumber(picked.size, locale) })
                : `${
                    total > mail.length
                      ? t("tickets.panels.irrelevant.shownOf", { shown: formatNumber(mail.length, locale), total: formatNumber(total, locale) })
                      : t("tickets.panels.irrelevant.count", { count: mail.length })
                  } · ${t("tickets.panels.irrelevant.newestFirst")}`}
            </p>
          </div>
          <div className={styles.listActions}>
            {selecting ? (
              <>
                <Button size="sm" variant="tertiary" disabled={mail.length === 0} onClick={() => onPickAll(allPicked ? [] : mail.map((item) => item.id))}>
                  {allPicked ? t("tickets.panels.irrelevant.selectNone") : t("tickets.panels.irrelevant.selectAll")}
                </Button>
                <Button size="sm" variant="secondary" disabled={picked.size === 0} onClick={onClearPicked}>
                  {picked.size > 0 ? t("tickets.panels.irrelevant.clearN", { n: picked.size }) : t("tickets.panels.irrelevant.clear")}
                </Button>
                <Button size="sm" variant="tertiary" onClick={onCancelSelecting}>
                  {t("tickets.panels.draft.cancel")}
                </Button>
              </>
            ) : (
              <>
                {clearedCount > 0 && (
                  <Button size="sm" variant="tertiary" onClick={onRestoreCleared}>
                    {t("tickets.panels.irrelevant.restore", { n: clearedCount })}
                  </Button>
                )}
                <Button size="sm" variant="secondary" disabled={mail.length === 0} onClick={onStartSelecting}>
                  {t("tickets.panels.irrelevant.select")}
                </Button>
              </>
            )}
          </div>
        </div>
        {mail.length === 0 ? (
          /* An emptied list says which kind of empty it is: nothing was dropped,
             or everything dropped has been cleared from this browser. */
          clearedCount > 0 ? (
            <CompactEmpty
              title={t("tickets.panels.irrelevant.allClearedTitle")}
              body={t("tickets.panels.irrelevant.allClearedBody")}
            />
          ) : (
            <CompactEmpty title={t("tickets.panels.irrelevant.emptyTitle")} body={t("tickets.panels.irrelevant.emptyBody")} />
          )
        ) : (
          /* A list of checkboxes is not a listbox: in select mode the rows stop
             being options and the container stops claiming they are. */
          <ol
            className={styles.ticketList}
            role={selecting ? "group" : "listbox"}
            aria-label={selecting ? t("tickets.panels.irrelevant.toClear") : t("tickets.panels.irrelevant.dropped")}
          >
            {mail.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role={selecting ? "checkbox" : "option"}
                  aria-checked={selecting ? picked.has(item.id) : undefined}
                  aria-selected={selecting ? undefined : selectedId === item.id}
                  className={[
                    styles.ticketItem,
                    selecting ? styles.ticketItemPicking : "",
                    !selecting && selectedId === item.id ? styles.ticketItemSelected : "",
                    selecting && picked.has(item.id) ? styles.ticketItemPicked : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => (selecting ? onTogglePick(item.id) : onSelect(item.id))}
                >
                  {selecting && (
                    <span className={styles.pickBox} aria-hidden="true">
                      {picked.has(item.id) && <CheckIcon size={12} />}
                    </span>
                  )}
                  <span className={styles.itemTop}>
                    <span className={styles.priorityWord}>{item.label ?? t("tickets.panels.irrelevant.blocklisted")}</span>
                    <time dateTime={item.decidedAt ?? undefined}>{formatRelativeTime(item.decidedAt, t) || "-"}</time>
                  </span>
                  <span className={styles.itemSubject} title={item.subject ?? undefined}>{item.subject?.trim() || t("tickets.view.noSubject")}</span>
                  <span className={styles.itemRequester} title={item.fromEmail ?? undefined}>{item.fromEmail?.trim() || t("tickets.panels.unknownSender")}</span>
                  <span className={styles.itemMeta}>{item.decidedBy === "llm" ? t("tickets.panels.irrelevant.classifier") : t("tickets.panels.irrelevant.blocklist")}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {total > mail.length && (
          <div className={styles.listActions}>
            <Button size="sm" variant="tertiary" loading={loadingMore} onClick={onLoadMore}>
              {t("tickets.panels.irrelevant.loadMore", { n: formatNumber(Math.min(200, total - mail.length), locale) })}
            </Button>
          </div>
        )}
      </aside>

      <section className={styles.detailPane} aria-label={t("tickets.panels.irrelevant.previewLabel")}>
        {selectedMail ? (
          <DroppedMailPreview mail={shown.mail ?? selectedMail} loading={shown.loading} />
        ) : (
          <EmptyDetail title={t("tickets.panels.irrelevant.selectTitle")} body={t("tickets.panels.irrelevant.selectBody")} />
        )}
      </section>

      <aside className={styles.contextPane} aria-label={t("tickets.panels.irrelevant.contextLabel")}>
        {selectedMail ? (
          <DroppedMailContext mail={shown.mail ?? selectedMail} onPromote={onPromote} pendingId={pendingId} />
        ) : (
          <EmptyDetail title={t("tickets.panels.irrelevant.noneTitle")} body={t("tickets.panels.irrelevant.noneBody")} />
        )}
      </aside>
    </div>
  );
}

/**
 * The selected email with its text. The list carries none (1.9 MB of bodies on
 * every /tickets load until 2026-10-06), so the text is read when a row is
 * opened, from `/api/dropped-mail/[id]`.
 */
function useFullDroppedMail(selected: DroppedMail | null): { mail: DroppedMail | null; loading: boolean } {
  const [full, setFull] = useState<DroppedMail | null>(null);
  const id = selected?.id ?? null;
  const needs = Boolean(selected && selected.bodyLoaded === false);
  useEffect(() => {
    setFull(null);
    if (!id || !needs) return;
    let live = true;
    fetch(`/api/dropped-mail/${encodeURIComponent(id)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((mail: DroppedMail | null) => {
        if (live && mail) setFull(mail);
      })
      .catch(() => {
        // The preview says there is no text; reopening the row asks again.
      });
    return () => {
      live = false;
    };
  }, [id, needs]);
  if (!selected) return { mail: null, loading: false };
  if (!needs) return { mail: selected, loading: false };
  return { mail: full, loading: full === null };
}

function DroppedMailPreview({ mail, loading = false }: { mail: DroppedMail; loading?: boolean }) {
  const t = useT();
  const expired = !mail.body && Boolean(mail.bodyCapturedAt);
  return (
    <div className={styles.detailFrame}>
      <header className={styles.ticketHeader}>
        <div className={styles.ticketHeaderText}>
          <h2 title={mail.subject ?? undefined}>{mail.subject?.trim() || t("tickets.view.noSubject")}</h2>
          <p>{mail.fromEmail?.trim() || t("tickets.panels.unknownSender")}{mail.decidedAt ? ` - ${t("tickets.panels.irrelevant.droppedAgo", { when: formatRelativeTime(mail.decidedAt, t) })}` : ""}</p>
        </div>
      </header>
      <div className={styles.conversationArea}>
        {mail.failedOpen && (
          <p className={styles.blocked} role="note">
            {t("tickets.panels.irrelevant.failedOpen")}
          </p>
        )}
        {loading ? (
          <p className={styles.placeholder}>{t("tickets.panels.irrelevant.loadingText")}</p>
        ) : mail.body ? (
          <pre className={styles.messageBody}>
            <TrackingText text={mail.body} parcels={mail.parcels} />
          </pre>
        ) : expired ? (
          <p className={styles.placeholder}>{t("tickets.panels.irrelevant.expired")}</p>
        ) : (
          <p className={styles.placeholder}>{t("tickets.panels.irrelevant.noText")}</p>
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
  const t = useT();
  return (
    <div className={styles.contextScroll}>
      <ContextSection title={t("tickets.panels.irrelevant.verdict")}>
        <InfoList
          rows={[
            [t("tickets.panels.irrelevant.verdict"), mail.label ?? t("tickets.panels.irrelevant.blocklisted")],
            [t("tickets.panels.irrelevant.decidedBy"), mail.decidedBy === "llm" ? t("tickets.panels.irrelevant.classifier") : t("tickets.panels.irrelevant.blocklist")],
            [t("tickets.panels.irrelevant.decided"), formatRelativeTime(mail.decidedAt, t) || null],
          ]}
        />
      </ContextSection>
      <ContextSection title={t("tickets.panels.irrelevant.reason")}>
        <p className={styles.actionText}>{mail.reason}</p>
      </ContextSection>
      <ContextSection title={t("tickets.panels.section.requiredAction")}>
        <Button
          size="sm"
          variant="primary"
          block
          disabled={!(mail.body || mail.hasBody)}
          loading={pendingId === mail.id}
          onClick={() => onPromote(mail)}
          title={
            mail.body || mail.hasBody
              ? t("tickets.panels.irrelevant.promoteHint")
              : t("tickets.panels.irrelevant.promoteNoBody")
          }
        >
          {t("tickets.panels.irrelevant.addAsTicket")}
        </Button>
        <p className={styles.stamp}>{t("tickets.panels.irrelevant.promoteNote")}</p>
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
  const t = useT();
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label={t("tickets.panels.loading.conversation")}>
      <span className={styles.skeletonLine} />
      <span className={styles.skeletonBlock} />
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonBlock} />
    </div>
  );
}

function DraftSkeleton() {
  const t = useT();
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label={t("tickets.panels.loading.draft")}>
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonBlockSmall} />
    </div>
  );
}

function ContextSkeleton() {
  const t = useT();
  return (
    <div className={styles.skeletonStack} aria-busy="true" aria-label={t("tickets.panels.loading.context")}>
      <span className={styles.skeletonLineShort} />
      <span className={styles.skeletonLine} />
      <span className={styles.skeletonLineShort} />
    </div>
  );
}
