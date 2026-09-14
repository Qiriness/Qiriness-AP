import type { ChatQueryView, ChatTurnStatus, ChatTurnView } from "@/lib/chat-types";
import { MAX_STEPS } from "../../../scripts/lib/chat-agent-loop.mjs";
import { ChatMarkdown } from "./ChatMarkdown";
import styles from "./ChatTurn.module.css";

const STATUS_LABEL: Record<Exclude<ChatTurnStatus, "ok">, string> = {
  step_limit: "Stopped at the step limit",
  empty: "No answer",
  error: "Failed",
  running: "Did not finish",
};

/** Rows of a query result drawn under an answer; the rest are counted, not shown. */
const RESULT_ROWS_SHOWN = 20;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function metaLine(turn: ChatTurnView): string {
  const parts = [plural(turn.steps, "step", "steps"), plural(turn.queries.length, "query", "queries")];
  if (turn.durationMs !== null) parts.push(`${(turn.durationMs / 1000).toFixed(1)} s`);
  parts.push(`${(turn.inputTokens + turn.outputTokens).toLocaleString("en-GB")} tokens`);
  parts.push(turn.costUsd === null ? "cost not priced" : `$${turn.costUsd.toFixed(3)}`);
  parts.push(turn.model);
  return parts.join(" · ");
}

export function ChatTurn({ turn }: { turn: ChatTurnView }) {
  return (
    <article className={styles.turn}>
      <p className={styles.question}>{turn.question}</p>
      <div className={styles.answer}>
        {turn.status !== "ok" && <span className={styles.status}>{STATUS_LABEL[turn.status]}</span>}
        {turn.answer ? (
          <ChatMarkdown text={turn.answer} />
        ) : (
          <p className={styles.errorText}>{turn.error ?? "No answer was produced."}</p>
        )}
        <p className={styles.meta}>{metaLine(turn)}</p>
        <QueryList queries={turn.queries} />
      </div>
    </article>
  );
}

interface PendingTurnProps {
  question: string;
  step: number;
  running: string | null;
  queries: ChatQueryView[];
}

/** The turn being answered: what has run so far, and what is running now. */
export function PendingTurn({ question, step, running, queries }: PendingTurnProps) {
  return (
    <article className={styles.turn} aria-live="polite">
      <p className={styles.question}>{question}</p>
      <div className={styles.answer}>
        <p className={styles.progress}>
          <span className={styles.spinner} aria-hidden="true" />
          {running ? "Running a query…" : step > 0 ? `Working — step ${step} of ${MAX_STEPS}` : "Starting…"}
        </p>
        {queries.map((query, index) => (
          <p key={index} className={styles.progressQuery}>
            {query.ok ? "✓" : "✗"} {summary(query)}
          </p>
        ))}
        {running && <pre className={styles.sql}>{running}</pre>}
      </div>
    </article>
  );
}

function summary(query: ChatQueryView): string {
  const outcome = query.ok
    ? `${plural(query.rowCount, "row", "rows")}${query.truncated ? ", cut off at 1,000" : ""}`
    : "refused or failed";
  return `Step ${query.step} · ${outcome} · ${Math.round(query.durationMs)} ms`;
}

function QueryList({ queries }: { queries: ChatQueryView[] }) {
  if (queries.length === 0) return null;
  return (
    <details className={styles.details}>
      <summary>How this was answered · {plural(queries.length, "query", "queries")}</summary>
      <div className={styles.queries}>
        {queries.map((query, index) => (
          <section key={index} className={styles.query}>
            <p className={`${styles.queryHead} ${query.ok ? "" : styles.queryFailed}`}>{summary(query)}</p>
            <pre className={styles.sql}>{query.sql}</pre>
            {query.error && <p className={styles.errorText}>{query.error}</p>}
            {query.ok && query.columns.length > 0 && <ResultTable query={query} />}
          </section>
        ))}
      </div>
    </details>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ResultTable({ query }: { query: ChatQueryView }) {
  const rows = query.rows.slice(0, RESULT_ROWS_SHOWN);
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {query.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{formatCell(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.rowCount > rows.length && (
        <p className={styles.meta}>
          Showing {rows.length} of {query.rowCount.toLocaleString("en-GB")} rows.
        </p>
      )}
    </>
  );
}
