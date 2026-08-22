"use client";

import { Button } from "@/components/ui/Button";
import type { RehearsalInput } from "@/lib/agent-test-types";

import styles from "./TestComposer.module.css";

/**
 * What the operator types.
 *
 * IDENTITY IS FIELDS, NOT PROSE, and that is the one thing worth defending here.
 * On a real email the sender is the envelope: ingestion takes the address off the
 * Graph message and never reads one out of the body. Asking somebody to write
 * "je suis Marie, marie@x.fr" in the message would mean inventing a parser
 * production does not have, and then testing it instead of the pipeline.
 *
 * THE ORDER NUMBER IS THE OPPOSITE and says so: on a real email it IS in the
 * body, so what is typed here is appended to the message and the resolver has to
 * find it exactly as it would live.
 */
export function TestComposer({
  value,
  onChange,
  onRun,
  running,
  disabled,
  articleTitle,
}: {
  value: RehearsalInput;
  onChange: (next: RehearsalInput) => void;
  onRun: () => void;
  running: boolean;
  disabled: boolean;
  articleTitle: string | null;
}) {
  const set = (patch: Partial<RehearsalInput>) => onChange({ ...value, ...patch });
  const ready = value.body.trim() !== "";

  return (
    <div className={styles.composer}>
      {articleTitle && (
        <p className={styles.testing}>
          Testing <strong>{articleTitle}</strong> — write a question this article should answer. The
          run reports whether it was retrieved, and how far it got.
        </p>
      )}

      <div className={styles.identity}>
        <label className={styles.field}>
          <span className={styles.label}>Customer name</span>
          <input
            className={styles.input}
            value={value.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="Marie Durand"
            disabled={running}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Email address</span>
          <input
            className={styles.input}
            type="email"
            value={value.email}
            onChange={(event) => set({ email: event.target.value })}
            placeholder="marie@example.fr"
            disabled={running}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Order number</span>
          <input
            className={styles.input}
            value={value.orderNumber}
            onChange={(event) => set({ orderNumber: event.target.value })}
            placeholder="#1006"
            disabled={running}
          />
        </label>
      </div>
      <p className={styles.hint}>
        The name and address stand in for the email envelope — the agent&apos;s customer and order
        tools resolve from the address, so leave it blank to see how the agent behaves with an
        unknown sender. An order number is added to the end of the message, where a customer would
        have written it.
      </p>

      <label className={styles.field}>
        <span className={styles.label}>Subject</span>
        <input
          className={styles.input}
          value={value.subject}
          onChange={(event) => set({ subject: event.target.value })}
          placeholder="Commande en retard"
          disabled={running}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Message</span>
        <textarea
          className={styles.textarea}
          value={value.body}
          onChange={(event) => set({ body: event.target.value })}
          rows={5}
          placeholder="Bonjour, j'ai commandé il y a deux semaines et je n'ai toujours rien reçu…"
          disabled={running}
          // Ctrl/Cmd+Enter runs it, because this is a chat box and behaves like
          // one; plain Enter has to stay a newline in a five-line email.
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && ready && !disabled) {
              event.preventDefault();
              onRun();
            }
          }}
        />
      </label>

      <div className={styles.actions}>
        <p className={styles.cost}>
          Each run makes about six model calls against live data — it costs real money and writes no
          ticket.
        </p>
        <Button variant="primary" onClick={onRun} loading={running} disabled={!ready || disabled}>
          {running ? "Running" : "Run through the agent"}
        </Button>
      </div>
    </div>
  );
}
