"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { changeTicketOrder, previewTicketOrder } from "@/lib/api/tickets";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate } from "@/lib/i18n/format";
import type {
  TicketOrderChange,
  TicketOrderLinkSource,
  TicketOrderMatch,
  TicketOrderPreview,
} from "@/lib/types";
import styles from "./OrderLinkDialog.module.css";

interface OrderLinkDialogProps {
  ticketId: string;
  /** The ticket's order as the panel showed it; the change must still match it. */
  currentOrder: string | null;
  source: TicketOrderLinkSource;
  /** Pre-filled and looked up on open: the candidate order being confirmed. */
  initialNumber?: string | null;
  onClose: () => void;
  onChanged: (change: TicketOrderChange) => void;
}

// Titles: `tickets.dialogs.orderLink.title.<source>`.

/**
 * Shown, never enforced: a person may know the order is a gift or a second
 * mailbox. The line is here so they decide with it in view. Text lives at
 * `tickets.dialogs.orderLink.match.<key>`.
 */
const MATCH_WARN: Record<TicketOrderMatch, boolean> = {
  sender_email: false,
  different_email: true,
  anonymous_marketplace: true,
  unknown: true,
};

/**
 * Add, change or confirm a ticket's order: choose it, then confirm it.
 *
 * TWO STEPS ON PURPOSE. Linking an order re-runs the investigation, which costs
 * a model run and replaces the case file the draft was written from, so the
 * second step says exactly that before anything is written.
 */
export function OrderLinkDialog({
  ticketId,
  currentOrder,
  source,
  initialNumber = null,
  onClose,
  onChanged,
}: OrderLinkDialogProps) {
  const t = useT();
  const [number, setNumber] = useState(initialNumber ?? "");
  const [preview, setPreview] = useState<TicketOrderPreview | null>(null);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [looking, setLooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function lookUp(value: string) {
    setLooking(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await previewTicketOrder(ticketId, value));
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setLooking(false);
    }
  }

  // The candidate arrives with its number: show what it is straight away. The
  // other two start empty, with the field ready for typing.
  useEffect(() => {
    if (initialNumber) {
      void lookUp(initialNumber);
    } else {
      inputRef.current?.focus();
    }
    // Runs once, for the dialog as it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (number.trim()) void lookUp(number);
  }

  async function confirm() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const change = await changeTicketOrder(ticketId, {
        number: preview.orderName,
        expected: currentOrder,
        source,
      });
      onChanged(change);
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
      setSaving(false);
    }
  }

  const actionLabel = t(`tickets.dialogs.orderLink.title.${source}`);
  const blocked = !preview || preview.sameAsCurrent;

  return (
    <Dialog
      title={actionLabel}
      meta={currentOrder ? t("tickets.dialogs.orderLink.current", { order: currentOrder }) : t("tickets.dialogs.orderLink.noOrder")}
      closeLabel={t("tickets.dialogs.orderLink.closeWithout")}
      onClose={onClose}
      size="compact"
    >
      {step === "choose" ? (
        <>
          <form className={styles.lookup} onSubmit={onSubmit}>
            <label className={styles.label} htmlFor="order-link-number">
              {t("tickets.dialogs.orderLink.number")}
            </label>
            <div className={styles.lookupRow}>
              <input
                ref={inputRef}
                id="order-link-number"
                className={styles.input}
                inputMode="numeric"
                autoComplete="off"
                placeholder="6669"
                value={number}
                onChange={(event) => {
                  setNumber(event.target.value);
                  setPreview(null);
                  setError(null);
                }}
              />
              <Button type="submit" variant="secondary" loading={looking} disabled={!number.trim()}>
                {t("tickets.dialogs.orderLink.lookUp")}
              </Button>
            </div>
          </form>

          {error && <p className={styles.error} role="alert">{error}</p>}

          {preview && <OrderPreview preview={preview} />}

          <div className={styles.actions}>
            <Button variant="tertiary" onClick={onClose}>
              {t("tickets.panels.draft.cancel")}
            </Button>
            <Button variant="primary" disabled={blocked} onClick={() => setStep("confirm")}>
              {actionLabel}
            </Button>
          </div>
        </>
      ) : (
        preview && (
          <>
            <p className={styles.question}>
              {currentOrder
                ? t("tickets.dialogs.orderLink.questionChange", { from: currentOrder, to: preview.orderName })
                : t("tickets.dialogs.orderLink.questionLink", { order: preview.orderName })}
            </p>
            <p className={styles.consequence}>
              {t("tickets.dialogs.orderLink.consequence")}
            </p>

            {error && <p className={styles.error} role="alert">{error}</p>}

            <div className={styles.actions}>
              <Button variant="tertiary" disabled={saving} onClick={() => setStep("choose")}>
                {t("tickets.dialogs.orderLink.back")}
              </Button>
              <Button variant="primary" loading={saving} onClick={confirm}>
                {currentOrder ? t("tickets.dialogs.orderLink.yesChange") : t("tickets.dialogs.orderLink.yesLink")}
              </Button>
            </div>
          </>
        )
      )}
    </Dialog>
  );
}

function OrderPreview({ preview }: { preview: TicketOrderPreview }) {
  const t = useT();
  const locale = useLocale();
  const facts = preview.facts;
  const rows: [string, string | null | undefined][] = [
    [t("tickets.panels.section.order"), preview.orderName],
    [t("tickets.dialogs.orderLink.placed"), preview.placedAt ? formatDate(preview.placedAt, locale, { dateStyle: "short" }) : null],
    [t("tickets.panels.order.channel"), facts?.channel],
    [t("tickets.panels.order.nameOnOrder"), facts?.customerName],
    [t("tickets.panels.order.contact"), facts?.contactEmail],
    [t("tickets.panels.order.status"), facts?.orderStatus],
    [t("tickets.panels.order.items"), facts && facts.items.length > 0 ? facts.items.join(", ") : null],
  ];

  return (
    <section className={styles.preview} aria-label={t("tickets.dialogs.orderLink.previewLabel")}>
      <dl className={styles.facts}>
        {rows
          .filter(([, value]) => Boolean(value))
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {preview.sameAsCurrent ? (
        <p className={styles.note}>{t("tickets.dialogs.orderLink.already")}</p>
      ) : (
        <p className={MATCH_WARN[preview.match] ? styles.warning : styles.note}>{t(`tickets.dialogs.orderLink.match.${preview.match}`)}</p>
      )}
    </section>
  );
}
