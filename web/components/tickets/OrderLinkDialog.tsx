"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { changeTicketOrder, previewTicketOrder } from "@/lib/api/tickets";
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

const TITLES: Record<TicketOrderLinkSource, string> = {
  add: "Add order number",
  edit: "Change order number",
  candidate: "Confirm this order",
};

/**
 * Shown, never enforced: a person may know the order is a gift or a second
 * mailbox. The line is here so they decide with it in view.
 */
const MATCH_TEXT: Record<TicketOrderMatch, { text: string; warn: boolean }> = {
  sender_email: { text: "Placed with the sender's email address.", warn: false },
  different_email: {
    text: "Placed with a different email address from the sender's. Link it only if you know it is theirs, for example a gift or a second address.",
    warn: true,
  },
  anonymous_marketplace: {
    text: "Marketplace order: the buyer is anonymous, so it cannot be checked against the sender.",
    warn: true,
  },
  unknown: { text: "There is no email address on one side to check against the sender.", warn: true },
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

  const actionLabel = TITLES[source];
  const blocked = !preview || preview.sameAsCurrent;

  return (
    <Dialog
      title={TITLES[source]}
      meta={currentOrder ? `Current order: ${currentOrder}` : "This ticket has no order yet."}
      closeLabel="Close without changing the order"
      onClose={onClose}
      size="compact"
    >
      {step === "choose" ? (
        <>
          <form className={styles.lookup} onSubmit={onSubmit}>
            <label className={styles.label} htmlFor="order-link-number">
              Order number
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
                Look up
              </Button>
            </div>
          </form>

          {error && <p className={styles.error} role="alert">{error}</p>}

          {preview && <OrderPreview preview={preview} />}

          <div className={styles.actions}>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
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
                ? `Change this ticket's order from ${currentOrder} to ${preview.orderName}?`
                : `Link ${preview.orderName} to this ticket?`}
            </p>
            <p className={styles.consequence}>
              This re-runs the investigation on this ticket with the new order. Its pending draft is
              rewritten from the new case file at the next drafting run.
            </p>

            {error && <p className={styles.error} role="alert">{error}</p>}

            <div className={styles.actions}>
              <Button variant="tertiary" disabled={saving} onClick={() => setStep("choose")}>
                Back
              </Button>
              <Button variant="primary" loading={saving} onClick={confirm}>
                {currentOrder ? "Yes, change the order" : "Yes, link this order"}
              </Button>
            </div>
          </>
        )
      )}
    </Dialog>
  );
}

function OrderPreview({ preview }: { preview: TicketOrderPreview }) {
  const facts = preview.facts;
  const match = MATCH_TEXT[preview.match];
  const rows: [string, string | null | undefined][] = [
    ["Order", preview.orderName],
    ["Placed", preview.placedAt ? new Date(preview.placedAt).toLocaleDateString("en-GB") : null],
    ["Sales channel", facts?.channel],
    ["Name on order", facts?.customerName],
    ["Order contact", facts?.contactEmail],
    ["Order status", facts?.orderStatus],
    ["Items", facts && facts.items.length > 0 ? facts.items.join(", ") : null],
  ];

  return (
    <section className={styles.preview} aria-label="The order you looked up">
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
        <p className={styles.note}>This is already the ticket&rsquo;s order.</p>
      ) : (
        <p className={match.warn ? styles.warning : styles.note}>{match.text}</p>
      )}
    </section>
  );
}
