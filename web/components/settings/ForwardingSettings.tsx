"use client";

import { useRef, useState } from "react";
import type { CategoryForwarding, KnowledgeCategory } from "@/lib/types";
import { CATEGORY_LABELS, TICKET_CATEGORIES } from "@/lib/types";
import { saveForwardingAddress } from "@/lib/api/forwarding";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import styles from "./ForwardingSettings.module.css";

/**
 * The forwarding address book: one optional recipient per ticket category.
 *
 * WHAT AN OPERATOR NEEDS TO UNDERSTAND HERE, and what the copy therefore says
 * out loud: filling a box in does not forward everything in that category. Only
 * mail the categoriser marks as a first approach — a job application, a
 * partnership enquiry, a B2B introduction — is handed over; a customer with a
 * delivery problem is never forwarded, whatever is typed here. Without that
 * sentence the form reads like a mail rule, and someone would reasonably expect
 * putting an address on `delivery` to divert 71 tickets.
 *
 * Saves per row on blur rather than behind one Save button, so a half-finished
 * form cannot be lost, and each row reports its own outcome.
 */

/**
 * The three categories the taxonomy actually allows a `contact` kind for
 * (see scripts/lib/support-taxonomy.mjs and 03_categorisation.sql). Every
 * category is editable — a taxonomy change should not need a UI change — but
 * these are the ones that will really receive anything today, and saying so
 * stops the other eleven boxes looking broken when nothing arrives.
 */
const ACTIVE_CATEGORIES = new Set<KnowledgeCategory>([
  "careers",
  "b2b",
  "partner_collaboration",
]);

type RowState = "idle" | "saving" | "saved" | "error";

interface ForwardingSettingsProps {
  initialForwarding: CategoryForwarding[];
  loadError: string | null;
}

export function ForwardingSettings({ initialForwarding, loadError }: ForwardingSettingsProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialForwarding.map((row) => [row.category, row.forwardEmail ?? ""]))
  );
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What the server last confirmed, so blurring an unchanged field is a no-op
  // rather than a redundant write.
  const saved = useRef<Record<string, string>>(
    Object.fromEntries(initialForwarding.map((row) => [row.category, row.forwardEmail ?? ""]))
  );

  async function commit(category: KnowledgeCategory) {
    const next = (values[category] ?? "").trim();
    if (next === (saved.current[category] ?? "")) {
      return;
    }

    setStates((s) => ({ ...s, [category]: "saving" }));
    setErrors((e) => ({ ...e, [category]: "" }));
    try {
      const entry = await saveForwardingAddress(category, next || null);
      saved.current[category] = entry.forwardEmail ?? "";
      setValues((v) => ({ ...v, [category]: entry.forwardEmail ?? "" }));
      setStates((s) => ({ ...s, [category]: "saved" }));
    } catch (error) {
      setStates((s) => ({ ...s, [category]: "error" }));
      setErrors((e) => ({ ...e, [category]: knowledgeErrorMessage(error) }));
    }
  }

  if (loadError) {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>Email forwarding</h2>
        <p className={styles.loadError} role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="forwarding-heading">
      <header className={styles.header}>
        <h2 className={styles.title} id="forwarding-heading">
          Email forwarding
        </h2>
        <p className={styles.intro}>
          Some mail that reaches the contact inbox is not customer support — a job
          application, a partnership request, a B2B introduction. Give a category an
          address and that mail is forwarded to the right colleague with a short note,
          instead of waiting for a reply nobody owes.
        </p>
        <p className={styles.caveat}>
          <strong>Only first-contact mail is forwarded.</strong> A customer with a
          delivery problem or an order question is never forwarded, whatever is set
          here — those stay in the support queue. Leave a field empty to forward
          nothing for that category.
        </p>
      </header>

      <ul className={styles.list}>
        {TICKET_CATEGORIES.map((category) => {
          const state = states[category] ?? "idle";
          const active = ACTIVE_CATEGORIES.has(category);
          const inputId = `forwarding-${category}`;
          const errorId = `${inputId}-error`;
          return (
            <li key={category} className={styles.row}>
              <label className={styles.label} htmlFor={inputId}>
                <span className={styles.categoryName}>{CATEGORY_LABELS[category]}</span>
                {active && <span className={styles.badge}>receives mail today</span>}
              </label>

              <div className={styles.field}>
                <input
                  id={inputId}
                  className={`${styles.input} ${state === "error" ? styles.inputError : ""}`}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="nobody@ — leave empty to not forward"
                  value={values[category] ?? ""}
                  aria-invalid={state === "error"}
                  aria-describedby={state === "error" ? errorId : undefined}
                  onChange={(event) =>
                    setValues((v) => ({ ...v, [category]: event.target.value }))
                  }
                  onBlur={() => commit(category)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span className={styles.status} aria-live="polite">
                  {state === "saving" && <span className={styles.saving}>Saving…</span>}
                  {state === "saved" && <span className={styles.saved}>Saved</span>}
                </span>
              </div>

              {state === "error" && (
                <p className={styles.error} id={errorId} role="alert">
                  {errors[category]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
