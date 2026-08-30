"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import type { SupportParameter } from "@/lib/types";

import styles from "./ParameterList.module.css";

/**
 * The numbers the desk runs on.
 *
 * AN UNSET PARAMETER IS THE POINT OF THE SCREEN, not an empty row to skip past.
 * Every one starts undecided, and each is a question somebody has to answer
 * before a rule can use it — so an unset one is called out rather than shown
 * blank. The count in the header is the outstanding work.
 *
 * EACH ROW SAYS WHAT CHANGES WHEN IT CHANGES. Somebody deciding a returns window
 * is owed an answer to "what does this affect", and the alternative is that they
 * guess or ask. That prose lives with the definition in `parameters.mjs`, beside
 * the code that reads the value.
 */
export function ParameterList({
  initial,
  loadError,
}: {
  initial: SupportParameter[];
  loadError: string | null;
}) {
  const [parameters, setParameters] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unset = parameters.filter((p) => p.value === null).length;

  async function save(key: string, value: string | null) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/parameters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      setParameters((prev) => prev.map((p) => (p.key === key ? body.parameter : p)));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Parameters</h2>
          <p className={styles.lede}>
            One number, held once. A rule compares against it, an article states it, and a reply
            quotes it — so none of them can disagree.
          </p>
        </div>
        {unset > 0 && (
          <span className={styles.outstanding}>
            {unset} still to decide
          </span>
        )}
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.list}>
        {parameters.map((p) => {
          const draft = drafts[p.key];
          const current = draft ?? p.value ?? "";
          const dirty = draft !== undefined && draft !== (p.value ?? "");

          return (
            <li key={p.key} className={`${styles.row} ${p.value === null ? styles.unset : ""}`}>
              <div className={styles.text}>
                <p className={styles.label}>
                  {p.label}
                  {p.value === null && <span className={styles.tag}>not decided</span>}
                </p>
                <p className={styles.description}>{p.description}</p>
                <p className={styles.usedBy}>
                  <span className={styles.usedByLabel}>changes</span> {p.usedBy}
                </p>
              </div>

              <div className={styles.control}>
                <div className={styles.inputRow}>
                  <input
                    className={styles.input}
                    value={current}
                    inputMode={p.kind === "text" ? "text" : "decimal"}
                    placeholder={p.kind === "days" ? "e.g. 30" : p.kind === "amount" ? "e.g. 70" : ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [p.key]: e.target.value }))}
                  />
                  {p.kind !== "text" && (
                    <span className={styles.unit}>{p.kind === "days" ? "days" : "€"}</span>
                  )}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy === p.key || !dirty}
                    onClick={() => save(p.key, current)}
                  >
                    {busy === p.key ? "Saving…" : "Save"}
                  </Button>
                  {p.value !== null && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy === p.key}
                      // Clearing is a real operation: taking a wrong number out
                      // of circulation must not require inventing a right one.
                      onClick={() => save(p.key, null)}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
