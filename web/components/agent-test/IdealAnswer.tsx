"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";

import styles from "./IdealAnswer.module.css";

/**
 * What the agent should have said.
 *
 * THE POINT OF KEEPING RUNS AT ALL. A transcript answers "what did it do"; this
 * answers "what was the right answer", which is the half nothing in the system
 * captures for a situation that has not happened yet. `ticket_draft_edits` makes
 * the same capture for real mail — the model's text beside a person's — and this
 * is its invented-situation twin: a gap can be written down before a customer
 * has hit it.
 *
 * NOTHING READS IT YET, and the UI says so rather than implying the agent learns
 * from it tonight. Promising a feedback loop that does not exist is how a
 * capture like this ends up full of text nobody trusts.
 */
export function IdealAnswer({
  draftBody,
  saved,
  savedAt,
  onSave,
  disabled,
}: {
  /** What the agent wrote, offered as a starting point to edit. */
  draftBody: string | null;
  saved: string | null;
  savedAt: string | null;
  onSave: (body: string | null) => Promise<void>;
  disabled?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(Boolean(saved));
  const [text, setText] = useState(saved ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different run was opened underneath this component.
  useEffect(() => {
    setText(saved ?? "");
    setOpen(Boolean(saved));
  }, [saved]);

  const dirty = (saved ?? "") !== text;

  async function save(next: string | null) {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.test.couldNotSave"));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className={styles.collapsed}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
          {t("setup.test.writeIdeal")}
        </Button>
        <p className={styles.hint}>
          Kept with this run as a worked example of what the agent should have said.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>{t("setup.test.theIdeal")}</h3>
        {savedAt && <span className={styles.saved}>{t("setup.knowledge.savedAt", { when: new Date(savedAt).toLocaleString(intlTag(locale)) })}</span>}
      </div>
      <p className={styles.hint}>
        What you would have sent instead. Kept with this run as a worked example — nothing reads it
        yet, and the agent does not learn from it today.
      </p>

      <textarea
        className={styles.textarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={8}
        placeholder="Bonjour Madame Durand, …"
        disabled={saving || disabled}
      />

      <div className={styles.actions}>
        {draftBody && text.trim() === "" && (
          <Button variant="tertiary" size="sm" onClick={() => setText(draftBody)} disabled={saving}>
            {t("setup.test.startFromReply")}
          </Button>
        )}
        {saved && (
          <Button
            variant="tertiary"
            size="sm"
            onClick={() => {
              setText("");
              void save(null);
            }}
            disabled={saving}
          >
            {t("setup.parameters.clear")}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => save(text)}
          loading={saving}
          disabled={!dirty || text.trim() === ""}
        >
          {saved ? t("setup.test.update") : t("tickets.panels.save")}
        </Button>
      </div>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
