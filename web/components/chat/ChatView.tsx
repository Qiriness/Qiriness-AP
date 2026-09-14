"use client";

import { useEffect, useRef, useState } from "react";

import { AlertIcon, ArrowRightIcon, ClockIcon, CloseIcon, PlusIcon, SparkleIcon } from "@/components/icons";
import {
  MAX_QUESTION_CHARS,
  type ChatConversationSummary,
  type ChatQueryView,
  type ChatReadiness,
  type ChatStepEvent,
  type ChatStreamLine,
  type ChatTurnView,
} from "@/lib/chat-types";
import { ChatTurn, PendingTurn } from "./ChatTurn";
import styles from "./ChatView.module.css";

/** Starting points, each answerable from the chat views. Clicking one asks it. */
const EXAMPLES = [
  "Revenue last month by sales channel, vs the month before",
  "Top 10 products by units sold in the last 30 days",
  "Median shipping time per month this year",
  "Support tickets per category since the mailbox sync began",
];

const TITLE_CHARS = 80;
/** Conversations open as tabs when the page loads; the rest are in History. */
const INITIAL_TABS = 4;
/** The composer grows with its text up to this height, then scrolls. */
const MAX_INPUT_HEIGHT = 200;

interface Pending {
  question: string;
  step: number;
  running: string | null;
  queries: ChatQueryView[];
}

interface ChatViewProps {
  initialConversations: ChatConversationSummary[];
  readiness: ChatReadiness;
  loadError: string | null;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatUsd(value: number) {
  // Cents hide most single questions, so small amounts keep a third decimal.
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/**
 * What the open conversation has cost so far: the sum of its turns, each priced
 * on the server at read time. A turn whose model has no rate is counted apart
 * rather than as free — the same rule `estimateCost` follows.
 */
function spendLabel(turns: ChatTurnView[]) {
  if (turns.length === 0) return "This conversation: $0.000";
  const priced = turns.filter((turn) => turn.costUsd !== null);
  const total = priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  const questions = `${turns.length} question${turns.length === 1 ? "" : "s"}`;
  const unpriced = turns.length - priced.length;
  if (priced.length === 0) return `This conversation: cost not priced · ${questions}`;
  return `This conversation: ${formatUsd(total)} · ${questions}${unpriced ? ` (${unpriced} not priced)` : ""}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function titleFrom(question: string) {
  const firstLine = question.split("\n")[0].trim();
  return firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine;
}

/**
 * Home's management chat: conversation tabs, the thread, and the composer.
 *
 * TABS ARE A VIEW, NOT A LIST. Closing a tab only takes it off the strip; every
 * conversation stays in History and on the server. The run is streamed
 * (POST /api/chat, NDJSON), so each query appears as it finishes, and reopening
 * a conversation reads it back from the server rather than from memory here.
 */
export function ChatView({ initialConversations, readiness, loadError }: ChatViewProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [openIds, setOpenIds] = useState<string[]>(() =>
    initialConversations.slice(0, INITIAL_TABS).map((conversation) => conversation.id)
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurnView[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(loadError);
  const [loadingThread, setLoadingThread] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const historyRoot = useRef<HTMLDivElement>(null);

  const busy = pending !== null;
  const titles = new Map(conversations.map((conversation) => [conversation.id, conversation.title]));
  const showEmpty = !loadingThread && turns.length === 0 && !pending;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, pending?.queries.length, pending?.running]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    if (!historyOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!historyRoot.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

  async function openConversation(id: string) {
    setHistoryOpen(false);
    if (busy || id === activeId) return;
    setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setActiveId(id);
    setTurns([]);
    setError(null);
    setLoadingThread(true);
    try {
      const response = await fetch(`/api/chat/conversations/${id}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not load the conversation.");
      setTurns(body.conversation.turns);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the conversation."));
    } finally {
      setLoadingThread(false);
    }
  }

  function startNew() {
    if (busy) return;
    setActiveId(null);
    setTurns([]);
    setError(null);
    input.current?.focus();
  }

  function closeTab(id: string) {
    if (busy && id === activeId) return;
    setOpenIds((ids) => ids.filter((open) => open !== id));
    if (id === activeId) startNew();
  }

  function rememberConversation(id: string, question: string) {
    const now = new Date().toISOString();
    setConversations((list) => {
      const existing = list.find((conversation) => conversation.id === id);
      const entry = existing ? { ...existing, updatedAt: now } : { id, title: titleFrom(question), updatedAt: now };
      return [entry, ...list.filter((conversation) => conversation.id !== id)];
    });
    setOpenIds((ids) => (ids.includes(id) ? ids : [id, ...ids]));
  }

  function applyStep(event: ChatStepEvent) {
    setPending((current) => {
      if (!current) return current;
      if (event.type === "thinking") return { ...current, step: event.step, running: null };
      if (event.type === "query_started") return { ...current, running: event.sql };
      return { ...current, running: null, queries: [...current.queries, event.query] };
    });
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !readiness.ready) return;
    setError(null);
    setDraft("");
    setPending({ question, step: 0, running: null, queries: [] });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId: activeId }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `The request failed (${response.status}).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answered = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as ChatStreamLine;
          if (message.stream === "conversation") {
            setActiveId(message.conversationId);
            rememberConversation(message.conversationId, question);
          } else if (message.stream === "step") {
            applyStep(message.event);
          } else if (message.stream === "done") {
            answered = true;
            setTurns((current) => [...current, message.turn]);
          } else if (message.stream === "failed") {
            answered = true;
            throw new Error(message.error);
          }
        }
      }
      if (!answered) {
        throw new Error("The connection closed before the answer arrived. Reopen the conversation in a moment: it may have been saved.");
      }
    } catch (caught) {
      setError(errorMessage(caught, "The question could not be answered."));
      // Give the question back, so a retry is one keypress.
      setDraft((current) => current || question);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>Ask the data</h1>
      <div className={styles.panel}>
        <div className={styles.tabBar}>
          <div className={styles.tabs} role="tablist" aria-label="Conversations">
            <div className={`${styles.tab} ${activeId === null ? styles.tabActive : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={activeId === null}
                className={styles.tabButton}
                onClick={startNew}
                disabled={busy}
              >
                <PlusIcon size={14} />
                <span className={styles.tabLabel}>New chat</span>
              </button>
            </div>
            {openIds.map((id) => {
              const title = titles.get(id) ?? "Conversation";
              return (
                <div key={id} className={`${styles.tab} ${id === activeId ? styles.tabActive : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={id === activeId}
                    className={styles.tabButton}
                    onClick={() => openConversation(id)}
                    disabled={busy && id !== activeId}
                    title={title}
                  >
                    <span className={styles.tabLabel}>{title}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.tabClose}
                    onClick={() => closeTab(id)}
                    disabled={busy && id === activeId}
                    aria-label={`Close ${title}`}
                  >
                    <CloseIcon size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className={styles.tabBarEnd}>
            <span className={styles.beta}>Beta</span>
            <div className={styles.historyWrap} ref={historyRoot}>
              <button
                type="button"
                className={styles.historyBtn}
                aria-haspopup="menu"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
                disabled={busy}
              >
                <ClockIcon size={15} />
                <span className={styles.historyLabel}>History</span>
              </button>
              {historyOpen && (
                <div className={styles.historyMenu} role="menu">
                  {conversations.length === 0 ? (
                    <p className={styles.historyEmpty}>No conversations yet. They are kept here, visible only to you.</p>
                  ) : (
                    conversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        role="menuitem"
                        className={`${styles.historyItem} ${conversation.id === activeId ? styles.historyItemActive : ""}`}
                        onClick={() => openConversation(conversation.id)}
                      >
                        <span className={styles.historyTitle}>{conversation.title}</span>
                        <span className={styles.historyDate}>{formatDate(conversation.updatedAt)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.column}>
            {!readiness.ready && (
              <div className={styles.notice} role="alert">
                <AlertIcon size={16} />
                <div>
                  <strong>The chat is not set up on this server yet.</strong>
                  <ul>
                    {readiness.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {loadingThread && <p className={styles.muted}>Loading the conversation…</p>}

            {showEmpty && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>
                  <SparkleIcon size={22} />
                </span>
                <h2 className={styles.emptyTitle}>What would you like to know?</h2>
                <p className={styles.emptyText}>
                  Ask about sales, orders, fulfilment, customers, products, promotions or support. Answers are worked
                  out with SQL on the live data, from totals only, and each one shows the queries behind it.
                </p>
                <p className={styles.promptsLabel}>Try these prompts:</p>
                <div className={styles.prompts}>
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className={styles.prompt}
                      onClick={() => ask(example)}
                      disabled={!readiness.ready}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((turn) => (
              <ChatTurn key={turn.id} turn={turn} />
            ))}
            {pending && <PendingTurn {...pending} />}

            {error && (
              <div className={styles.error} role="alert">
                <AlertIcon size={16} />
                <span>{error}</span>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className={styles.composerArea}>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              ask(draft);
            }}
          >
            <textarea
              ref={input}
              className={styles.input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  ask(draft);
                }
              }}
              placeholder={activeId ? "Ask a follow-up" : "Ask something"}
              rows={1}
              maxLength={MAX_QUESTION_CHARS}
              disabled={!readiness.ready || busy}
              aria-label="Your question"
            />
            <button
              type="submit"
              className={styles.send}
              disabled={!readiness.ready || busy || !draft.trim()}
              aria-label={busy ? "Answering…" : "Send"}
            >
              {busy ? <span className={styles.sendSpinner} aria-hidden="true" /> : <ArrowRightIcon size={16} />}
            </button>
          </form>
          <div className={styles.footnote}>
            <span className={styles.spend} title="Model cost of this conversation, priced from llm-rates.mjs (USD, list prices)">
              {spendLabel(turns)}
            </span>
            <span>{readiness.model} · Enter to send, Shift+Enter for a new line</span>
          </div>
        </div>
      </div>
    </div>
  );
}
