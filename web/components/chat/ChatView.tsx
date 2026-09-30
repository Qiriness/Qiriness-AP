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
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import type { InsightsFormat } from "@/lib/insights-format";
import type { Translate } from "@/lib/i18n/translate";
import { ChatTurn, PendingTurn } from "./ChatTurn";
import styles from "./ChatView.module.css";

/** Starting points, each answerable from the chat views. Clicking one asks it (in the reader's language: `home.example.<n>`). */
const EXAMPLE_COUNT = 4;

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

function formatUsd(value: number, f: InsightsFormat) {
  // Cents hide most single questions, so small amounts keep a third decimal.
  return `$${f.decimal(value, value < 1 ? 3 : 2)}`;
}

/**
 * What the open conversation has cost so far: the sum of its turns, each priced
 * on the server at read time. A turn whose model has no rate is counted apart
 * rather than as free — the same rule `estimateCost` follows.
 */
function spendLabel(turns: ChatTurnView[], t: Translate, f: InsightsFormat) {
  if (turns.length === 0) return t("home.spendEmpty", { amount: `$${f.decimal(0, 3)}` });
  const priced = turns.filter((turn) => turn.costUsd !== null);
  const total = priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  const questions = t("home.questions", { count: turns.length, n: turns.length });
  const unpriced = turns.length - priced.length;
  if (priced.length === 0) return t("home.spendUnpriced", { questions });
  return t("home.spend", { amount: formatUsd(total, f), questions, unpriced: unpriced ? ` ${t("home.unpricedN", { n: unpriced })}` : "" });
}

function formatDate(iso: string, locale: "fr" | "en") {
  return new Date(iso).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" });
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
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
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
      if (!response.ok) throw new Error(body.error ?? t("home.couldNotLoad"));
      setTurns(body.conversation.turns);
    } catch (caught) {
      setError(errorMessage(caught, t("home.couldNotLoad")));
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
        throw new Error(body.error ?? t("home.requestFailed", { status: response.status }));
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
        throw new Error(t("home.connectionClosed"));
      }
    } catch (caught) {
      setError(errorMessage(caught, t("home.couldNotAnswer")));
      // Give the question back, so a retry is one keypress.
      setDraft((current) => current || question);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t("home.title")}</h1>
      <div className={styles.panel}>
        <div className={styles.tabBar}>
          <div className={styles.tabs} role="tablist" aria-label={t("nav.conversations")}>
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
                <span className={styles.tabLabel}>{t("home.newChat")}</span>
              </button>
            </div>
            {openIds.map((id) => {
              const title = titles.get(id) ?? t("home.conversation");
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
                    aria-label={t("home.close", { title })}
                  >
                    <CloseIcon size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className={styles.tabBarEnd}>
            <span className={styles.beta}>{t("nav.beta")}</span>
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
                <span className={styles.historyLabel}>{t("home.history")}</span>
              </button>
              {historyOpen && (
                <div className={styles.historyMenu} role="menu">
                  {conversations.length === 0 ? (
                    <p className={styles.historyEmpty}>{t("home.historyEmpty")}</p>
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
                        <span className={styles.historyDate}>{formatDate(conversation.updatedAt, locale)}</span>
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
                  <strong>{t("home.notSetUp")}</strong>
                  <ul>
                    {readiness.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {loadingThread && <p className={styles.muted}>{t("home.loadingConversation")}</p>}

            {showEmpty && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>
                  <SparkleIcon size={22} />
                </span>
                <h2 className={styles.emptyTitle}>{t("home.emptyTitle")}</h2>
                <p className={styles.emptyText}>
                  {t("home.emptyText")}
                </p>
                <p className={styles.promptsLabel}>{t("home.tryPrompts")}</p>
                <div className={styles.prompts}>
                  {Array.from({ length: EXAMPLE_COUNT }, (_, i) => t(`home.example.${i + 1}`)).map((example) => (
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
              placeholder={activeId ? t("home.followUp") : t("home.askSomething")}
              rows={1}
              maxLength={MAX_QUESTION_CHARS}
              disabled={!readiness.ready || busy}
              aria-label={t("home.yourQuestion")}
            />
            <button
              type="submit"
              className={styles.send}
              disabled={!readiness.ready || busy || !draft.trim()}
              aria-label={busy ? t("home.answering") : t("home.send")}
            >
              {busy ? <span className={styles.sendSpinner} aria-hidden="true" /> : <ArrowRightIcon size={16} />}
            </button>
          </form>
          <div className={styles.footnote}>
            <span className={styles.spend} title={t("home.spendHint")}>
              {spendLabel(turns, t, f)}
            </span>
            <span>{readiness.model} · {t("home.enterHint")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
