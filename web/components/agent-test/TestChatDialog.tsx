"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import {
  deleteRun as deleteRunRequest,
  fetchRun,
  fetchRuns,
  saveIdealAnswer,
  streamRehearsal,
} from "@/lib/api/agent-test";
import type { RunFinished } from "@/lib/api/agent-test";
import { EMPTY_INPUT } from "@/lib/agent-test-types";
import type { Readiness, RehearsalInput, RunDetail, RunSummary, TraceEvent } from "@/lib/agent-test-types";

import { IdealAnswer } from "./IdealAnswer";
import { RunHistory } from "./RunHistory";
import { RunTranscript } from "./RunTranscript";
import { TestComposer } from "./TestComposer";
import styles from "./TestChatDialog.module.css";

/**
 * The test chat.
 *
 * A message goes in, the real pipeline runs, and every decision it made comes
 * back as a transcript — which tools were called, what each one returned, what
 * reached the drafting model, and what the reply says. No ticket is written.
 *
 * TWO MODES, ONE ENGINE. Opened from the header it is a free test; opened from
 * an article it additionally asks whether THAT article was retrieved, and
 * reports one of five answers rather than a yes/no, because the four ways of
 * failing point at four different fixes.
 *
 * THE RUN STREAMS. Each step is rendered as it lands, so a run is watched rather
 * than waited for — which is also the only way to see where a slow one is.
 */
export function TestChatDialog({
  onClose,
  expectDocumentId = null,
  expectDocumentTitle = null,
}: {
  onClose: () => void;
  expectDocumentId?: string | null;
  expectDocumentTitle?: string | null;
}) {
  const [input, setInput] = useState<RehearsalInput>(EMPTY_INPUT);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [finished, setFinished] = useState<RunFinished | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [opened, setOpened] = useState<RunDetail | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const { runs: rows, readiness: state } = await fetchRuns();
      setRuns(rows);
      setReadiness(state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load earlier runs.");
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Abandoning a run aborts the READ, not the passes: they are already paid for
  // and the server stores the row either way, so it still lands in the history.
  useEffect(() => () => abort.current?.abort(), []);

  // Follow the run as steps land. Only while running, so reading an opened run
  // is not yanked to the bottom.
  useEffect(() => {
    if (running) {
      transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [events, running]);

  async function run(pastGate = false) {
    setRunning(true);
    setError(null);
    setEvents([]);
    setFinished(null);
    setOpened(null);
    abort.current = new AbortController();

    try {
      const result = await streamRehearsal(
        {
          name: input.name,
          email: input.email,
          subject: input.subject,
          body: input.body,
          orderNumber: input.orderNumber,
          expectDocumentId,
          pastGate,
        },
        {
          onStep: (event) => setEvents((previous) => [...previous, event]),
          signal: abort.current.signal,
        }
      );
      setFinished(result);
      void loadHistory();
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "The run failed.");
    } finally {
      setRunning(false);
    }
  }

  async function open(id: string) {
    try {
      const run = await fetchRun(id);
      setOpened(run);
      setEvents(run.trace);
      setFinished(null);
      setShowHistory(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that run.");
    }
  }

  async function remove(id: string) {
    try {
      await deleteRunRequest(id);
      setRuns((previous) => previous.filter((row) => row.id !== id));
      if (opened?.id === id) {
        setOpened(null);
        setEvents([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that run.");
    }
  }

  // Which run the ideal answer belongs to: the one just finished, or the one
  // opened from history.
  const currentRunId = opened?.id ?? finished?.runId ?? null;
  const draftBody =
    opened?.draftBody ??
    (lastDraft(events) as string | null) ??
    null;

  const gated = finished?.status === "gated";

  return (
    <Dialog
      title={expectDocumentTitle ? `Test: ${expectDocumentTitle}` : "Test the agent"}
      meta="A message you write, put through the real pipeline. Nothing is added to the ticket queue."
      closeLabel="Close the agent test"
      onClose={onClose}
    >
      <div className={styles.layout}>
        {readiness?.problems.length ? (
          <div className={styles.problems}>
            {readiness.problems.map((problem) => (
              <p key={problem} className={styles.problem}>
                {problem}
              </p>
            ))}
          </div>
        ) : null}

        <TestComposer
          value={input}
          onChange={setInput}
          onRun={() => run(false)}
          running={running}
          disabled={readiness ? !readiness.ready : false}
          articleTitle={expectDocumentTitle}
        />

        {error && <p className={styles.error}>{error}</p>}

        {events.length > 0 && (
          <section className={styles.result}>
            <header className={styles.resultHead}>
              <h3 className={styles.resultTitle}>
                {opened ? `Run from ${new Date(opened.ranAt).toLocaleString()}` : "This run"}
              </h3>
              <Cost finished={finished} opened={opened} running={running} />
            </header>

            <RunTranscript events={events} />
            <div ref={transcriptEnd} />

            {gated && (
              <div className={styles.gated}>
                <p className={styles.problem}>
                  The gate would have dropped this message, so nothing after it ran. That is the
                  finding — but you can push it through if you want to see the rest.
                </p>
                <Button variant="secondary" size="sm" onClick={() => run(true)} disabled={running}>
                  Run it anyway
                </Button>
              </div>
            )}

            {finished?.stored === false && (
              <p className={styles.problem}>
                This run finished but could not be saved, so it will not appear in the history below.
              </p>
            )}

            {currentRunId && !running && (
              <IdealAnswer
                draftBody={draftBody}
                saved={opened?.idealBody ?? null}
                savedAt={opened?.idealSavedAt ?? null}
                onSave={async (body) => {
                  const updated = await saveIdealAnswer(currentRunId, body);
                  setOpened(updated);
                  void loadHistory();
                }}
              />
            )}
          </section>
        )}

        <section className={styles.history}>
          <button
            type="button"
            className={styles.historyToggle}
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
          >
            Earlier runs
            <span className={styles.historyCount}>{runs.length}</span>
          </button>
          {showHistory && (
            <RunHistory
              runs={runs}
              activeId={currentRunId}
              onOpen={open}
              onDelete={remove}
              loading={loadingHistory}
            />
          )}
        </section>
      </div>
    </Dialog>
  );
}

/**
 * What the run cost.
 *
 * Deliberately prominent: every run is real money against live models, and the
 * figure is not in the Agent panel — rehearsal spend is kept out of `llm_usage`
 * so it cannot move the per-ticket cost of handling real mail.
 */
function Cost({
  finished,
  opened,
  running,
}: {
  finished: RunFinished | null;
  opened: RunDetail | null;
  running: boolean;
}) {
  if (running) {
    return <span className={styles.cost}>running…</span>;
  }
  const tokens = finished?.tokens ?? opened?.tokens;
  if (!tokens) return null;
  const cost = finished?.cost;
  return (
    <span className={styles.cost}>
      {tokens.calls} model calls · {tokens.total.toLocaleString()} tokens
      {cost ? ` · ~$${cost.usd.toFixed(3)}${cost.rated ? "" : " (partly unpriced)"}` : ""}
    </span>
  );
}

/** The drafted reply out of a live run's events, for the ideal-answer starting point. */
function lastDraft(events: TraceEvent[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "draft" && typeof events[index].body === "string") {
      return events[index].body;
    }
  }
  return null;
}
