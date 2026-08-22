"use client";

import { ARTICLE_VERDICT_LABELS } from "@/lib/agent-test-types";
import type { ArticleVerdict, RunSummary } from "@/lib/agent-test-types";

import styles from "./RunHistory.module.css";

/**
 * Every rehearsal this shop has run, newest first.
 *
 * WHY IT IS KEPT. A run you cannot look at again answers only "does it work
 * right now". The two questions worth a table both need two runs: did changing
 * the prompt, the article or the bands make this better — and what should the
 * agent have said, which is the ideal answer stored beside it.
 *
 * Rows render from the flat columns on `agent_test_runs`, never from the trace:
 * the trace is the largest thing in the schema after a message body and this is
 * a list of forty of them.
 */
export function RunHistory({
  runs,
  activeId,
  onOpen,
  onDelete,
  loading,
}: {
  runs: RunSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return <p className={styles.empty}>Loading earlier runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <p className={styles.empty}>
        No runs yet. Send a message above and it will be kept here, so you can compare it against the
        same question after a change.
      </p>
    );
  }

  return (
    <ul className={styles.list}>
      {runs.map((run) => (
        <li key={run.id}>
          <div className={styles.row} data-active={run.id === activeId || undefined}>
            <button type="button" className={styles.open} onClick={() => onOpen(run.id)}>
              <span className={styles.subject}>{run.subject || firstLine(run.body)}</span>
              <span className={styles.meta}>
                {new Date(run.ranAt).toLocaleString()}
                {run.requesterMasked ? ` · ${run.requesterMasked}` : ""}
              </span>
              <span className={styles.chips}>
                <Outcome run={run} />
                {run.articleVerdict && (
                  <span
                    className={styles.chip}
                    data-tone={ARTICLE_VERDICT_LABELS[run.articleVerdict as ArticleVerdict]?.tone}
                  >
                    {ARTICLE_VERDICT_LABELS[run.articleVerdict as ArticleVerdict]?.label ??
                      run.articleVerdict}
                  </span>
                )}
                {run.hasIdealAnswer && (
                  <span className={styles.chip} data-tone="good">
                    ideal answer
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              className={styles.delete}
              onClick={() => onDelete(run.id)}
              aria-label="Delete this run"
              title="Delete this run"
            >
              ×
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The one-line answer: how far the run got, and what it concluded. */
function Outcome({ run }: { run: RunSummary }) {
  if (run.status === "failed") {
    return (
      <span className={styles.chip} data-tone="bad">
        failed
      </span>
    );
  }
  if (run.status === "gated") {
    return (
      <span className={styles.chip} data-tone="bad">
        would have been dropped
      </span>
    );
  }
  return (
    <>
      {run.category && (
        <span className={styles.chip}>
          {run.category}
          {run.requestKind ? ` / ${run.requestKind}` : ""}
          {run.level ? ` · L${run.level}` : ""}
        </span>
      )}
      {run.verdict && <span className={styles.chip}>{run.verdict}</span>}
      {run.draftSkippedReason ? (
        <span className={styles.chip} data-tone="warn">
          no reply · {run.draftSkippedReason}
        </span>
      ) : run.draftChecksPassed === false ? (
        <span className={styles.chip} data-tone="warn">
          checks failed
        </span>
      ) : null}
    </>
  );
}

function firstLine(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line || "(empty)";
}
