import type { ChatQueryView, ChatTurnStatus, ChatTurnView } from "@/lib/chat-types";
import { MAX_STEPS } from "../../../scripts/lib/chat-agent-loop.mjs";
import { useFormat, useT } from "@/lib/i18n/client";
import type { InsightsFormat } from "@/lib/insights-format";
import type { Translate } from "@/lib/i18n/translate";
import { ChatMarkdown } from "./ChatMarkdown";
import styles from "./ChatTurn.module.css";

// Status words: `home.status.<status>`.

/** Rows of a query result drawn under an answer; the rest are counted, not shown. */
const RESULT_ROWS_SHOWN = 20;

function metaLine(turn: ChatTurnView, t: Translate, f: InsightsFormat): string {
  const parts = [t("home.steps", { count: turn.steps, n: f.integer(turn.steps) }), t("home.queries", { count: turn.queries.length, n: f.integer(turn.queries.length) })];
  if (turn.durationMs !== null) parts.push(`${f.decimal(turn.durationMs / 1000, 1)} s`);
  parts.push(t("home.tokens", { n: f.integer(turn.inputTokens + turn.outputTokens) }));
  parts.push(turn.costUsd === null ? t("home.notPriced") : `$${f.decimal(turn.costUsd, 3)}`);
  parts.push(turn.model);
  return parts.join(" · ");
}

export function ChatTurn({ turn }: { turn: ChatTurnView }) {
  const t = useT();
  const f = useFormat();
  return (
    <article className={styles.turn}>
      <p className={styles.question}>{turn.question}</p>
      <div className={styles.answer}>
        {turn.status !== "ok" && <span className={styles.status}>{t(`home.status.${turn.status}`)}</span>}
        {turn.answer ? (
          <ChatMarkdown text={turn.answer} />
        ) : (
          <p className={styles.errorText}>{turn.error ?? t("home.noAnswerProduced")}</p>
        )}
        <p className={styles.meta}>{metaLine(turn, t, f)}</p>
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
  const t = useT();
  const f = useFormat();
  return (
    <article className={styles.turn} aria-live="polite">
      <p className={styles.question}>{question}</p>
      <div className={styles.answer}>
        <p className={styles.progress}>
          <span className={styles.spinner} aria-hidden="true" />
          {running ? t("home.runningQuery") : step > 0 ? t("home.working", { step, max: MAX_STEPS }) : t("home.starting")}
        </p>
        {queries.map((query, index) => (
          <p key={index} className={styles.progressQuery}>
            {query.ok ? "✓" : "✗"} {summary(query, t, f)}
          </p>
        ))}
        {running && <pre className={styles.sql}>{running}</pre>}
      </div>
    </article>
  );
}

function summary(query: ChatQueryView, t: Translate, f: InsightsFormat): string {
  const outcome = query.ok
    ? `${t("home.rows", { count: query.rowCount, n: f.integer(query.rowCount) })}${query.truncated ? `, ${t("home.cutOff")}` : ""}`
    : t("home.refused");
  return `${t("home.step", { n: query.step })} · ${outcome} · ${Math.round(query.durationMs)} ms`;
}

function QueryList({ queries }: { queries: ChatQueryView[] }) {
  const t = useT();
  const f = useFormat();
  if (queries.length === 0) return null;
  return (
    <details className={styles.details}>
      <summary>{t("home.howAnswered")} · {t("home.queries", { count: queries.length, n: f.integer(queries.length) })}</summary>
      <div className={styles.queries}>
        {queries.map((query, index) => (
          <section key={index} className={styles.query}>
            <p className={`${styles.queryHead} ${query.ok ? "" : styles.queryFailed}`}>{summary(query, t, f)}</p>
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
  const t = useT();
  const f = useFormat();
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
          {t("home.showing", { shown: rows.length, total: f.integer(query.rowCount) })}
        </p>
      )}
    </>
  );
}
