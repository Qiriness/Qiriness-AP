"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons";
import { TrackingText } from "@/components/ui/TrackingText";
import type { ModelCall, TraceEvent } from "@/lib/agent-test-types";
import type { TicketTracking } from "@/lib/types";

import styles from "./StepCard.module.css";

/**
 * One step of a run.
 *
 * COLLAPSED BY DEFAULT EXCEPT WHERE IT IS THE ANSWER. A run emits a dozen steps
 * and most of them are "this happened, as expected"; expanding all of them makes
 * the two that matter — what the tools returned and what the reply says —
 * something to scroll past. `open` is set by the caller per step type.
 *
 * THE MODEL CALLS ARE THE BOTTOM DRAWER of every step that made one. They are
 * the raw material — the system prompt, the exact messages, the response — and
 * they are one level further in than the step's own summary because on a good
 * run nobody needs them and on a bad one they are the only thing that helps.
 */
export function StepCard({
  title,
  tone = "neutral",
  badge,
  summary,
  calls = [],
  defaultOpen = false,
  children,
}: {
  title: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  badge?: ReactNode;
  /** One line, always visible — the step's answer in the collapsed state. */
  summary?: ReactNode;
  calls?: ModelCall[];
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Boolean(children) || calls.length > 0;

  return (
    <section className={styles.card} data-tone={tone}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className={styles.chevron} aria-hidden="true">
          {expandable ? (
            open ? (
              <ChevronDownIcon size={14} />
            ) : (
              <ChevronRightIcon size={14} />
            )
          ) : null}
        </span>
        <span className={styles.title}>{title}</span>
        {badge}
        {summary && <span className={styles.summary}>{summary}</span>}
      </button>

      {open && (
        <div className={styles.body}>
          {children}
          {calls.length > 0 && <ModelCalls calls={calls} />}
        </div>
      )}
    </section>
  );
}

/** A labelled value. The transcript is mostly these. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{children}</dd>
    </div>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <dl className={styles.fields}>{children}</dl>;
}

/**
 * The parcels this run's order carries, for linking a tracking number wherever
 * one appears in the transcript.
 *
 * A CONTEXT RATHER THAN A PROP, and that is a deliberate trade. `Verbatim` is
 * called from eleven places across two files — every tool answer, every prompt,
 * every model response, the draft — and a tracking number can appear in any of
 * them, because they are all views of the same French text the order tool
 * produced. Threading a `parcels` prop through all eleven would mean the next
 * call site added silently renders a number that is a link everywhere else, and
 * that specific drift is what `TicketDetailPanel` already recorded happening.
 *
 * Empty by default, which is exactly what a run with no confirmed order shows.
 */
const TranscriptParcelsContext = createContext<TicketTracking[]>([]);

export function TranscriptParcels({
  parcels,
  children,
}: {
  parcels: TicketTracking[];
  children: ReactNode;
}) {
  return (
    <TranscriptParcelsContext.Provider value={parcels}>{children}</TranscriptParcelsContext.Provider>
  );
}

/** Verbatim text — a prompt, a tool's answer, a draft. Never re-wrapped. */
export function Verbatim({
  label,
  text,
  link = null,
}: {
  label?: string;
  text: string;
  /** On a draft only: the link its [[marker]] was written about. */
  link?: { url: string; label: string } | null;
}) {
  const parcels = useContext(TranscriptParcelsContext);
  return (
    <div className={styles.verbatim}>
      {label && <p className={styles.verbatimLabel}>{label}</p>}
      <pre className={styles.pre}>
        <TrackingText text={text} parcels={parcels} link={link} />
      </pre>
    </div>
  );
}

/** A list of claims from the case file. Empty renders as a stated absence. */
export function ClaimList({ label, items }: { label: string; items: unknown[] }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div className={styles.claims}>
      <p className={styles.verbatimLabel}>
        {label} <span className={styles.count}>{list.length}</span>
      </p>
      {list.length === 0 ? (
        // "None" said out loud. An empty block would read as a rendering gap.
        <p className={styles.none}>None.</p>
      ) : (
        <ul className={styles.claimItems}>
          {list.map((item, index) => (
            <li key={index}>{claimText(item)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function claimText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const main =
      (record.claim as string) ||
      (record.statement as string) ||
      (record.field as string) ||
      (record.reason as string) ||
      JSON.stringify(record);
    const why = record.why || record.reason;
    return why && why !== main ? `${main} — ${why}` : String(main);
  }
  return String(item);
}

function ModelCalls({ calls }: { calls: ModelCall[] }) {
  return (
    <details className={styles.calls}>
      <summary className={styles.callsSummary}>
        {calls.length} model {calls.length === 1 ? "call" : "calls"} · what was actually sent
      </summary>
      <div className={styles.callList}>
        {calls.map((call, index) => (
          <article key={index} className={styles.call} data-failed={call.failed || undefined}>
            <header className={styles.callHead}>
              <span className={styles.callModel}>{call.model ?? "unknown model"}</span>
              <span className={styles.callMeta}>
                {call.pass} · {call.ms}ms
                {call.tools.length > 0 && ` · tools offered: ${call.tools.join(", ")}`}
              </span>
            </header>
            {call.system && <Verbatim label="System prompt" text={call.system} />}
            {call.messages.map((message, messageIndex) => (
              <Verbatim
                key={messageIndex}
                label={
                  message.toolCalls?.length
                    ? `${message.role} → ${message.toolCalls.join(", ")}`
                    : message.role
                }
                text={message.content ?? ""}
              />
            ))}
            {call.failed ? (
              <p className={styles.callError}>Failed: {call.error}</p>
            ) : (
              call.response && <Verbatim label="Response" text={call.response} />
            )}
          </article>
        ))}
      </div>
    </details>
  );
}

/** Everything a step carried that this renderer has no opinion about. */
export function RawEvent({ event }: { event: TraceEvent }) {
  const { type, at, calls, ...rest } = event;
  if (Object.keys(rest).length === 0) return null;
  return (
    <details className={styles.raw}>
      <summary className={styles.callsSummary}>Everything this step recorded</summary>
      <pre className={styles.pre}>{JSON.stringify(rest, null, 2)}</pre>
    </details>
  );
}
