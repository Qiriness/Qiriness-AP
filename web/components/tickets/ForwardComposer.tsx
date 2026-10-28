"use client";

/**
 * Forwarding a ticket to colleagues (06_manual_forwards.sql), in three pieces:
 *
 *   ForwardComposer    the composer's purple « Transférer » mode: who, a note,
 *                      what will travel, and the button.
 *   ForwardSnoozeDialog after a forward: the ticket now waits on someone else,
 *                      so offer to snooze it until they reply.
 *   ForwardCard        the forward in the conversation, from the moment it is
 *                      queued; its sent copy, once read back, is folded inside
 *                      it rather than shown as a second copy of the thread.
 *
 * Always internal, hence always purple: the server refuses any address outside
 * the company. docs/decisions/forwarding.md § Manual forwards.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertIcon, CloseIcon, ForwardIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { forwardTicket, retryForward, snoozeTicket } from "@/lib/api/tickets";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import { fallbackFor, formatWake, toLocalInput, type SnoozeDelays } from "@/lib/snooze";
import type { TicketForward, TicketListItem, TicketThread } from "@/lib/types";
import type { SnoozeChange } from "./SnoozeControl";
import { useTeam } from "./team-context";
import styles from "./ForwardComposer.module.css";

/** A picked recipient: a picker key (`team:…`, `destination:…`) or a typed internal address. */
type Picked = { key: string; name: string };

export function ForwardComposer({
  ticket,
  thread,
  onForwarded,
}: {
  ticket: TicketListItem;
  thread: TicketThread | null;
  onForwarded: (forward: TicketForward, recipientsLabel: string) => void;
}) {
  const t = useT();
  const { forwardRecipients, forwardingEnabled } = useTeam();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  // Minted when the form opens: a double click or a retried request forwards once.
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPicked([]);
    setTyped("");
    setNote("");
    setError(null);
    setClientKey(crypto.randomUUID());
  }, [ticket.id]);

  const available = forwardRecipients.filter((option) => !picked.some((p) => p.key === option.key));
  const team = available.filter((option) => option.kind === "team");
  const destinations = available.filter((option) => option.kind === "destination");
  const messages = thread?.messages.filter((message) => !message.internalOnly) ?? [];
  const withFiles = messages.filter((message) => message.hasAttachments).length;

  function addTyped() {
    const address = typed.trim().toLowerCase();
    if (!address) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      setError(t("tickets.panels.forward.badAddress", { address }));
      return;
    }
    if (!picked.some((p) => p.key === address)) setPicked((current) => [...current, { key: address, name: address }]);
    setTyped("");
    setError(null);
  }

  async function send() {
    if (picked.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      const forward = await forwardTicket(ticket.id, { recipients: picked.map((p) => p.key), note, clientKey });
      onForwarded(forward, picked.map((p) => p.name).join(", "));
      setPicked([]);
      setNote("");
      setClientKey(crypto.randomUUID());
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  if (!forwardingEnabled) {
    return <p className={styles.off}>{t("tickets.panels.forward.off")}</p>;
  }

  return (
    <div className={styles.composer}>
      <div className={styles.toLine}>
        <span className={styles.toLabel}>{t("tickets.panels.compose.to")}</span>
        <span className={styles.chips}>
          {picked.map((p) => (
            <span key={p.key} className={styles.chip}>
              {p.name}
              <button
                type="button"
                onClick={() => setPicked((current) => current.filter((c) => c.key !== p.key))}
                aria-label={t("tickets.panels.forward.remove", { name: p.name })}
              >
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
          {available.length > 0 && (
            <select
              className={styles.picker}
              value=""
              aria-label={t("tickets.panels.forward.pick")}
              onChange={(event) => {
                const option = forwardRecipients.find((o) => o.key === event.target.value);
                if (option) setPicked((current) => [...current, { key: option.key, name: option.name }]);
              }}
            >
              <option value="">{t("tickets.panels.forward.pick")}</option>
              {team.length > 0 && (
                <optgroup label={t("tickets.panels.forward.team")}>
                  {team.map((option) => (
                    <option key={option.key} value={option.key}>{option.name}</option>
                  ))}
                </optgroup>
              )}
              {destinations.length > 0 && (
                <optgroup label={t("tickets.panels.forward.destinations")}>
                  {destinations.map((option) => (
                    <option key={option.key} value={option.key}>{option.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          <span className={styles.typed}>
            <input
              type="email"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTyped();
                }
              }}
              placeholder={t("tickets.panels.forward.typed")}
              aria-label={t("tickets.panels.forward.typed")}
            />
            {typed.trim() && (
              <button type="button" onClick={addTyped} aria-label={t("tickets.panels.forward.addTyped")}>
                <PlusIcon size={12} />
              </button>
            )}
          </span>
        </span>
      </div>

      <textarea
        className={styles.note}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t("tickets.panels.forward.notePlaceholder")}
        aria-label={t("tickets.panels.forward.noteLabel")}
        maxLength={5000}
        disabled={sending}
      />

      <div className={styles.foot}>
        <span className={styles.summary}>
          <ForwardIcon size={13} />
          {t("tickets.panels.forward.summary", { count: messages.length })}
          {withFiles > 0 ? ` · ${t("tickets.panels.forward.files", { count: withFiles })}` : ""}
        </span>
        <Button size="sm" variant="primary" className={styles.send} loading={sending} disabled={sending || picked.length === 0} onClick={send}>
          {t("tickets.panels.forward.send")}
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          <AlertIcon size={13} /> {error}
        </p>
      )}
    </div>
  );
}

/**
 * The ticket now waits on someone else: offer to snooze it until they reply.
 * « Until they reply » is a colleague snooze, so the shop's colleague delay is
 * the latest it wakes; their reply, coming back to this ticket, wakes it sooner.
 */
export function ForwardSnoozeDialog({
  ticket,
  recipientsLabel,
  delays,
  onClose,
  onSnoozed,
}: {
  ticket: TicketListItem;
  recipientsLabel: string;
  delays: SnoozeDelays;
  onClose: () => void;
  onSnoozed: (ticketId: string, change: SnoozeChange) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState(() => toLocalInput(fallbackFor("colleague", delays) ?? new Date(Date.now() + 2 * 86_400_000)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = fallbackFor("colleague", delays);

  async function snooze(until: string | null) {
    setSaving(true);
    setError(null);
    try {
      const snoozed = await snoozeTicket(ticket.id, { waitingFor: until ? "date" : "colleague", until, reason: t("tickets.panels.forward.snoozeReason", { names: recipientsLabel }) });
      onSnoozed(ticket.id, { snooze: snoozed, lastWake: ticket.lastWake });
      onClose();
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={t("tickets.panels.forward.snoozeTitle", { names: recipientsLabel })} closeLabel={t("tickets.panels.forward.notNow")} onClose={onClose} size="compact">
      <div className={styles.dialogBody}>
        <p>{t("tickets.panels.forward.snoozeBody")}</p>
        {fallback && <p className={styles.dialogHint}>{t("tickets.panels.forward.snoozeLatest", { when: formatWake(fallback, intlTag(locale)) })}</p>}
        {picking && (
          <label className={styles.dateField}>
            <span>{t("tickets.panels.forward.snoozeUntil")}</span>
            <input type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.dialogActions}>
          <Button size="sm" variant="tertiary" disabled={saving} onClick={onClose}>
            {t("tickets.panels.forward.notNow")}
          </Button>
          {picking ? (
            <Button size="sm" variant="primary" loading={saving} disabled={saving || !date} onClick={() => snooze(new Date(date).toISOString())}>
              {t("tickets.panels.forward.snoozeDate")}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => setPicking(true)}>
                {t("tickets.panels.forward.pickDate")}
              </Button>
              <Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => snooze(null)}>
                {t("tickets.panels.forward.snoozeColleague")}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The forward in the conversation, from the moment it is queued. `sent` is its
 * copy from Sent Items once read back: folded in here, because it repeats the
 * whole thread the reader is already looking at.
 */
export function ForwardCard({
  ticketId,
  forward,
  sent,
  onChanged,
  itemRef,
}: {
  ticketId: string;
  forward: TicketForward;
  sent: ReactNode | null;
  onChanged: (forward: TicketForward) => void;
  itemRef?: React.Ref<HTMLLIElement>;
}) {
  const t = useT();
  const locale = useLocale();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = forward.recipients.map((r) => r.name).join(", ");
  const time = useMemo(() => {
    const at = new Date(forward.sentAt ?? forward.createdAt);
    return Number.isNaN(at.getTime())
      ? ""
      : new Intl.DateTimeFormat(intlTag(locale), { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  }, [forward.sentAt, forward.createdAt, locale]);

  return (
    <li className={styles.card} ref={itemRef}>
      <span className={styles.cardIcon}>
        <ForwardIcon size={14} />
      </span>
      <article className={styles.cardBody}>
        <header className={styles.cardHead}>
          <span>
            <strong>{t("tickets.panels.forward.cardTitle", { names })}</strong>
            {forward.forwardedByName ? <span className={styles.by}> · {t("tickets.panels.forward.by", { name: forward.forwardedByName })}</span> : null}
          </span>
          <span className={styles.cardMeta}>
            <span className={`${styles.state} ${styles[`state_${forward.state}`]}`}>{t(`tickets.panels.forward.state.${forward.state}`)}</span>
            {time && <time dateTime={forward.sentAt ?? forward.createdAt}>{time}</time>}
          </span>
        </header>
        {forward.note && <p className={styles.cardNote}>{forward.note}</p>}
        {forward.attachmentsSkipped.length > 0 && (
          <p className={styles.cardHint}>
            {t("tickets.panels.forward.skipped", { names: forward.attachmentsSkipped.map((f) => f.name ?? "—").join(", ") })}
          </p>
        )}
        {forward.state === "failed" && (
          <p className={styles.cardError}>
            {forward.error ?? t("tickets.panels.forward.failedUnknown")}{" "}
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                setError(null);
                try {
                  onChanged(await retryForward(ticketId, forward.id));
                } catch (cause) {
                  setError(knowledgeErrorMessage(cause));
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {t("tickets.panels.forward.retry")}
            </button>
          </p>
        )}
        {error && <p className={styles.cardError}>{error}</p>}
        {sent && (
          <details className={styles.sent}>
            <summary>{t("tickets.panels.forward.showSent")}</summary>
            <ol className={styles.sentList}>{sent}</ol>
          </details>
        )}
      </article>
    </li>
  );
}
