"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { snoozeTicket, unsnoozeTicket } from "@/lib/api/tickets";
import { fallbackFor, formatWake, laterToday, toLocalInput, tomorrowMorning, type SnoozeDelays } from "@/lib/snooze";
import type { SnoozeWaitingFor, TicketListItem, TicketSnooze, TicketWake } from "@/lib/types";
import styles from "./SnoozeControl.module.css";

export type SnoozeChange = { snooze: TicketSnooze | null; lastWake: TicketWake | null };

type Choice =
  | { kind: "time"; waitingFor: "date"; until: Date }
  | { kind: "party"; waitingFor: Exclude<SnoozeWaitingFor, "date"> };

const PARTIES: Exclude<SnoozeWaitingFor, "date">[] = ["customer", "partner", "colleague"];

/**
 * « Snooze » in the ticket header: a time, or a party to wait for. A snoozed
 * ticket shows « Unsnooze » instead. Everything else about the ticket stays as
 * it is; the worker wakes it on new mail or at its deadline.
 */
export function SnoozeControl({
  ticket,
  delays,
  disabled,
  onChanged,
}: {
  ticket: TicketListItem;
  delays: SnoozeDelays;
  disabled?: boolean;
  onChanged: (ticketId: string, change: SnoozeChange) => void;
}) {
  const t = useT();
  const locale = intlTag(useLocale());
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickValue, setPickValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setPicking(false);
    setReason("");
    setError(null);
  }, [ticket.id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  async function choose(choice: Choice) {
    setBusy(true);
    setError(null);
    try {
      const snooze = await snoozeTicket(ticket.id, {
        waitingFor: choice.waitingFor,
        until: choice.kind === "time" ? choice.until.toISOString() : null,
        reason: reason.trim() || null,
      });
      setOpen(false);
      onChanged(ticket.id, { snooze, lastWake: ticket.lastWake });
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function wake() {
    setBusy(true);
    setError(null);
    try {
      const lastWake = await unsnoozeTicket(ticket.id);
      onChanged(ticket.id, { snooze: null, lastWake });
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (ticket.snooze) {
    return (
      <span className={styles.root}>
        <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={wake}>
          {t("tickets.panels.snooze.unsnooze")}
        </Button>
        {error && <span className={styles.error} role="alert">{error}</span>}
      </span>
    );
  }

  const now = new Date();
  return (
    <div className={styles.root} ref={rootRef}>
      <Button size="sm" variant="secondary" disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {t("tickets.panels.snooze.button")}
      </Button>
      {open && (
        <div className={styles.menu} role="dialog" aria-label={t("tickets.panels.snooze.menuLabel")}>
          <p className={styles.menuTitle}>{t("tickets.panels.snooze.menuLabel")}</p>
          <div className={styles.options}>
            {[
              { key: "laterToday", until: laterToday(now) },
              { key: "tomorrow", until: tomorrowMorning(now) },
            ].map(({ key, until }) => (
              <button
                key={key}
                type="button"
                className={styles.option}
                disabled={busy}
                onClick={() => choose({ kind: "time", waitingFor: "date", until })}
              >
                <span>{t(`tickets.panels.snooze.${key}`)}</span>
                <span className={styles.when}>{formatWake(until, locale)}</span>
              </button>
            ))}
            {PARTIES.map((party) => {
              const latest = fallbackFor(party, delays, now);
              return (
                <button
                  key={party}
                  type="button"
                  className={styles.option}
                  disabled={busy || !latest}
                  title={latest ? undefined : t("tickets.panels.snooze.noDelay")}
                  onClick={() => choose({ kind: "party", waitingFor: party })}
                >
                  <span>{t(`tickets.panels.snooze.until.${party}`)}</span>
                  <span className={styles.when}>
                    {latest ? t("tickets.panels.snooze.atLatest", { when: formatWake(latest, locale) }) : t("tickets.panels.snooze.noDelay")}
                  </span>
                </button>
              );
            })}
            {picking ? (
              <div className={styles.pick}>
                <label>
                  <span>{t("tickets.panels.snooze.pickLabel")}</span>
                  <input
                    type="datetime-local"
                    value={pickValue}
                    min={toLocalInput(now)}
                    onChange={(event) => setPickValue(event.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  disabled={!pickValue}
                  onClick={() => choose({ kind: "time", waitingFor: "date", until: new Date(pickValue) })}
                >
                  {t("tickets.panels.snooze.confirm")}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.option}
                disabled={busy}
                onClick={() => {
                  setPickValue(toLocalInput(tomorrowMorning(now)));
                  setPicking(true);
                }}
              >
                <span>{t("tickets.panels.snooze.pick")}</span>
              </button>
            )}
          </div>
          <label className={styles.reason}>
            <span>{t("tickets.panels.snooze.reason")}</span>
            <input
              type="text"
              maxLength={300}
              value={reason}
              placeholder={t("tickets.panels.snooze.reasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className={styles.hint}>{t("tickets.panels.snooze.hint")}</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Under the header of a snoozed ticket: why, until when, and who snoozed it. */
export function SnoozeBanner({ snooze }: { snooze: TicketSnooze }) {
  const t = useT();
  const locale = intlTag(useLocale());
  return (
    <p className={styles.banner} role="status">
      <strong>{t(`tickets.panels.snooze.waiting.${snooze.waitingFor}`)}</strong>
      <span>{t("tickets.panels.snooze.wakes", { when: formatWake(snooze.wakeAt, locale) })}</span>
      <span className={styles.bannerBy}>
        {snooze.source === "auto" ? t("tickets.panels.snooze.byAgent") : t("tickets.panels.snooze.byPerson")}
        {snooze.reason ? ` · « ${snooze.reason} »` : ""}
      </span>
    </p>
  );
}

/** In a list row: snoozed until when, or why it just came back. */
export function SnoozeChip({ ticket }: { ticket: TicketListItem }) {
  const t = useT();
  const locale = intlTag(useLocale());
  if (ticket.snooze) {
    return (
      <span className={styles.chip} title={t(`tickets.panels.snooze.waiting.${ticket.snooze.waitingFor}`)}>
        {t("tickets.panels.snooze.row", { when: formatWake(ticket.snooze.wakeAt, locale) })}
      </span>
    );
  }
  if (ticket.lastWake) {
    return <span className={`${styles.chip} ${styles.chipWoke}`}>{t(`tickets.panels.snooze.woke.${ticket.lastWake.reason}`)}</span>;
  }
  return null;
}
