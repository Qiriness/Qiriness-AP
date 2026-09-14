"use client";

import { useEffect, useRef, useState } from "react";

import { AlertIcon, PlusIcon, SparkleIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
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
  "What was our revenue last month, by sales channel, compared with the month before?",
  "Which 10 products sold the most units over the last 30 days?",
  "How long did we take to ship orders each month this year (median hours)?",
  "How many support tickets have we had per category since the mailbox sync started?",
];

const TITLE_CHARS = 80;

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

/**
 * Home's management chat: the conversation list, the thread, and the composer.
 *
 * The run is streamed (POST /api/chat, NDJSON), so each query appears as it
 * finishes. Everything shown is also stored; reopening a conversation reads it
 * back from the server rather than from this component's memory.
 */
export function ChatView({ initialConversations, readiness, loadError }: ChatViewProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurnView[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(loadError);
  const [loadingThread, setLoadingThread] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const busy = pending !== null;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, pending?.queries.length, pending?.running]);

  async function openConversation(id: string) {
    if (busy || id === activeId) return;
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
  }

  function rememberConversation(id: string, question: string) {
    const now = new Date().toISOString();
    setConversations((list) => {
      const existing = list.find((conversation) => conversation.id === id);
      const firstLine = question.split("\n")[0].trim();
      const entry = existing
        ? { ...existing, updatedAt: now }
        : { id, title: firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine, updatedAt: now };
      return [entry, ...list.filter((conversation) => conversation.id !== id)];
    });
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
      <aside className={styles.rail} aria-label="Your conversations">
        <Button variant="primary" size="sm" block leadingIcon={<PlusIcon size={16} />} onClick={startNew} disabled={busy}>
          New conversation
        </Button>
        <p className={styles.railLabel}>Your conversations</p>
        {conversations.length === 0 ? (
          <p className={styles.railEmpty}>Nothing yet. Your questions are kept here, visible only to you.</p>
        ) : (
          <ul className={styles.list}>
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`${styles.item} ${conversation.id === activeId ? styles.itemActive : ""}`}
                  onClick={() => openConversation(conversation.id)}
                  disabled={busy}
                  aria-current={conversation.id === activeId || undefined}
                >
                  <span className={styles.itemTitle}>{conversation.title}</span>
                  <span className={styles.itemDate}>{formatDate(conversation.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            Ask the data <span className={styles.beta}>Beta</span>
          </h1>
          <p className={styles.subtitle}>
            Answers are worked out with SQL on the live database, from totals and counts only: no customer names,
            addresses or messages. Before relying on a figure, open <em>How this was answered</em> under it to see
            the queries.
          </p>
        </header>

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

        <div className={styles.thread}>
          {loadingThread && <p className={styles.muted}>Loading the conversation…</p>}

          {!loadingThread && turns.length === 0 && !pending && (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}>
                <SparkleIcon size={20} />
              </span>
              <p className={styles.emptyText}>
                Ask about sales, orders, fulfilment, customers, products, promotions or support. Follow-up questions
                keep the context.
              </p>
              <div className={styles.examples}>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className={styles.example}
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

        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            ask(draft);
          }}
        >
          <textarea
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask(draft);
              }
            }}
            placeholder={activeId ? "Ask a follow-up…" : "Ask a question…"}
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            disabled={!readiness.ready || busy}
            aria-label="Your question"
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!readiness.ready || !draft.trim()}>
            Ask
          </Button>
        </form>
        <div className={styles.footnote}>
          <span className={styles.spend} title="Model cost of this conversation, priced from llm-rates.mjs (USD, list prices)">
            {spendLabel(turns)}
          </span>
          <span>
            {readiness.model} · Enter to send, Shift+Enter for a new line · Every question and query is logged.
          </span>
        </div>
      </section>
    </div>
  );
}
