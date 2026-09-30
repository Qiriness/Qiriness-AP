"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { addSender, deleteSender, updateSender } from "@/lib/api/senders";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import { SENDER_LABEL_KEYS } from "@/lib/types";
import type { SenderDirectoryView, SenderLabel } from "@/lib/types";
import styles from "./SenderDirectory.module.css";

/**
 * Who a sender is to this business: our team, an agency, the warehouse, a
 * carrier, a retailer. One row per address or domain; subdomains count.
 *
 * WHAT EACH CHOICE MEANS IS SAID NEXT TO IT, because the label is not a tag:
 * it decides whether that sender's mail is answered like a customer's, and
 * whether they can owe a check on a case (codex_plans/Case_State_Plan.md,
 * stage 5). « Operations partner » (the 3PL, a carrier) is never called just
 * « partner » here: the directory also has a commercial partner, and the two
 * mean opposite things for a case.
 */
// Meanings: `setup.senders.actor.<actor>`.

export function SenderDirectory({ initial, loadError }: { initial: SenderDirectoryView | null; loadError: string | null }) {
  const t = useT();
  const [view, setView] = useState<SenderDirectoryView | null>(initial);
  const [patternType, setPatternType] = useState<"domain" | "email">("domain");
  const [pattern, setPattern] = useState("");
  const [label, setLabel] = useState<SenderLabel>("internal");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<SenderDirectoryView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
      return true;
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError || !view) {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t("setup.tabs.senders.label")}</h2>
        <p className={styles.error} role="alert">{loadError ?? t("setup.senders.loadFailed")}</p>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="senders-heading">
      <header className={styles.header}>
        <h2 className={styles.title} id="senders-heading">{t("setup.tabs.senders.label")}</h2>
        <p className={styles.intro}>
          Who writes to the support mailbox besides customers: your own team, an agency, your warehouse, a carrier, a
          retailer. Add a domain (every address under it counts, subdomains too) or a single address. Anyone not listed
          is a customer.
          {view.supportMailboxDomain && (
            <> Addresses at <strong>{view.supportMailboxDomain}</strong> already count as your team.</>
          )}
        </p>
        <p className={styles.callout}>
          {view.hasOperationsPartner
            ? "You have at least one operations partner on file, so a check can be owed by a partner as well as by your team."
            : "No operations partner on file: every check is owed by your team or a colleague. Add your warehouse or carrier as Logistics (3PL) or Carrier to change that."}
        </p>
      </header>

      <form
        className={styles.addForm}
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run(() => addSender({ patternType, pattern, label, note }))) {
            setPattern("");
            setNote("");
          }
        }}
      >
        <label className={styles.field}>
          {t("setup.senders.type")}
          <select className={styles.select} value={patternType} onChange={(e) => setPatternType(e.target.value as "domain" | "email")}>
            <option value="domain">{t("setup.senders.domain")}</option>
            <option value="email">{t("setup.senders.address")}</option>
          </select>
        </label>
        <label className={styles.field}>
          {patternType === "domain" ? t("setup.senders.domain") : t("setup.senders.address")}
          <input
            className={styles.input}
            value={pattern}
            placeholder={patternType === "domain" ? "warehouse.example" : "someone@company.example"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPattern(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          {t("setup.senders.whoTheyAre")}
          <select className={styles.select} value={label} onChange={(e) => setLabel(e.target.value as SenderLabel)}>
            {SENDER_LABEL_KEYS.map((key) => (
              <option key={key} value={key}>{t(`sender.${key}`)}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {t("setup.senders.note")}
          <input className={styles.input} value={note} placeholder={t("setup.senders.optional")} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !pattern.trim()}>{t("setup.senders.add")}</Button>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}

      <ul className={styles.list} aria-label={t("setup.senders.directory")}>
        {view.entries.map((entry) => (
          <li key={entry.id} className={styles.row}>
            <span className={styles.pattern}>
              {entry.pattern}
              <span className={styles.kind}>{entry.patternType === "domain" ? t("setup.senders.domain") : t("setup.senders.address")}{entry.note ? ` · ${entry.note}` : ""}</span>
            </span>
            <select
              className={styles.select}
              aria-label={t("setup.senders.whoIs", { pattern: entry.pattern })}
              value={entry.label}
              disabled={busy}
              onChange={(e) => run(() => updateSender(entry.id, { label: e.target.value as SenderLabel }))}
            >
              {SENDER_LABEL_KEYS.map((key) => (
                <option key={key} value={key}>{t(`sender.${key}`)}</option>
              ))}
            </select>
            <span className={styles.meaning}>{t(`setup.senders.actor.${entry.actor}`)}</span>
            <Button size="sm" variant="tertiary" disabled={busy} onClick={() => run(() => deleteSender(entry.id))}>
              {t("setup.senders.remove")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
