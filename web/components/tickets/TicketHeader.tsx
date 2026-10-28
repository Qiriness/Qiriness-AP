"use client";

/**
 * The top of an open ticket: its number, the subject, who wrote and when, the
 * chips (category, priority, state, team), and the context strip.
 *
 * The category moved out of the title line into a coloured chip, the « Next
 * action » line and the references once chipped under every message moved into
 * the strip, and the right rail became a panel opened from here.
 * docs/decisions/tickets-dashboard.md § The ticket header.
 */
import { useState } from "react";
import {
  ChevronLeftIcon,
  CopyIcon,
  GlobeIcon,
  MaximizeIcon,
  MinimizeIcon,
  OrdersIcon,
  PanelRightIcon,
  PencilIcon,
  SendIcon,
  SparkleIcon,
  TagIcon,
  TruckIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { TrackingText } from "@/components/ui/TrackingText";
import { useT } from "@/lib/i18n/client";
import { formatRelativeTime } from "@/lib/relative-time";
import { isClosed } from "@/lib/ticket-stats";
import { contextStrip, type StripPiece } from "@/lib/ticket-context-strip";
import type { TicketDetail, TicketListItem, TicketThread } from "@/lib/types";
import { formatTicketNumber } from "@/lib/types";
import type { SnoozeDelays } from "@/lib/snooze";
import { SnoozeBanner, SnoozeControl, type SnoozeChange } from "./SnoozeControl";
import { ForwardingBanner } from "./ForwardingTag";
import { CategoryIcon, PriorityDot, StatusIcons, categoryVars, priorityTitle } from "./ticket-marks";
import { contactingAddress, requesterName, ticketTitle } from "./ticket-text";
import { AssigneePicker } from "./AssigneePicker";
import styles from "./TicketHeader.module.css";

interface TicketHeaderProps {
  ticket: TicketListItem;
  detail: TicketDetail | null;
  thread: TicketThread | null;
  snoozeDelays: SnoozeDelays;
  onSnoozeChanged: (ticketId: string, change: SnoozeChange) => void;
  onChangeStatus: (ticket: TicketListItem, status: "open" | "closed") => void;
  pendingId: string | null;
  onBack: () => void;
  onOpenContext: () => void;
  focus: boolean;
  onToggleFocus: () => void;
  /** The row came back changed (an assignment). */
  onTicketChanged: (ticket: TicketListItem) => void;
}

export function TicketHeader({
  ticket,
  detail,
  thread,
  snoozeDelays,
  onSnoozeChanged,
  onChangeStatus,
  pendingId,
  onBack,
  onOpenContext,
  focus,
  onToggleFocus,
  onTicketChanged,
}: TicketHeaderProps) {
  const t = useT();
  const closed = isClosed(ticket);
  const number = formatTicketNumber(ticket.ticketNumber);
  const email = thread ? contactingAddress(thread) : null;
  const overridden = Object.keys(ticket.overrides ?? {}).length > 0;

  return (
    <div className={styles.header}>
      <div className={styles.topline}>
        <div className={styles.toplineStart}>
          <button type="button" className={styles.mobileBack} onClick={onBack}>
            <ChevronLeftIcon size={15} />
            {t("tickets.panels.backToTickets")}
          </button>
          {number && <span className={styles.kicker}>{t("tickets.panels.header.ticket", { number })}</span>}
        </div>
        <div className={styles.actions}>
          {!closed && (
            <SnoozeControl
              ticket={ticket}
              delays={snoozeDelays}
              disabled={pendingId !== null && pendingId !== ticket.id}
              onChanged={onSnoozeChanged}
            />
          )}
          <Button
            size="sm"
            variant={closed ? "secondary" : "danger"}
            loading={pendingId === ticket.id}
            disabled={pendingId !== null && pendingId !== ticket.id}
            onClick={() => onChangeStatus(ticket, closed ? "open" : "closed")}
          >
            {closed ? t("tickets.panels.reopenTicket") : t("tickets.panels.closeTicket")}
          </Button>
          <button
            type="button"
            className={`${styles.iconButton} ${focus ? styles.iconButtonOn : ""}`}
            onClick={onToggleFocus}
            aria-pressed={focus}
            title={focus ? t("tickets.panels.header.focusOff") : t("tickets.panels.header.focusOn")}
            aria-label={focus ? t("tickets.panels.header.focusOff") : t("tickets.panels.header.focusOn")}
          >
            {focus ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onOpenContext}
            title={t("tickets.panels.header.openPanel")}
            aria-label={t("tickets.panels.header.openPanel")}
          >
            <PanelRightIcon size={16} />
          </button>
        </div>
      </div>

      <h2 className={styles.title} title={ticketTitle(ticket, t)}>
        {ticketTitle(ticket, t)}
      </h2>

      <p className={styles.subline}>
        <span className={styles.who}>{requesterName(ticket, t)}</span>
        {email && <span className={styles.email}>{email}</span>}
        {ticket.lastMessageAt && (
          <span>{t("tickets.panels.header.lastMessage", { when: formatRelativeTime(ticket.lastMessageAt, t) })}</span>
        )}
        {ticket.waitingSince && !closed && (
          <span className={styles.waiting}>
            {t("tickets.panels.header.waitingSince", { when: formatRelativeTime(ticket.waitingSince, t) })}
          </span>
        )}
        {ticket.orderNumber && (
          <button type="button" className={styles.orderLink} onClick={onOpenContext} title={t("tickets.panels.header.orderInPanel")}>
            <OrdersIcon size={13} />
            {t("tickets.panels.orderNumber", { number: ticket.orderNumber })}
          </button>
        )}
      </p>

      <div className={styles.chips}>
        <span className={`${styles.chip} ${styles.categoryChip}`} style={categoryVars(ticket.category)}>
          <CategoryIcon category={ticket.category} size={13} />
          {ticket.category ? t(`category.${ticket.category}`) : t("tickets.panels.uncategorised")}
        </span>
        <span className={styles.chip}>
          <PriorityDot band={ticket.priorityBand} title={priorityTitle(ticket, t)} />
          {priorityTitle(ticket, t)}
        </span>
        {ticket.level && (
          <span className={styles.chip}>
            L{ticket.level} · {t(`levelMeaning.${ticket.level}`)}
          </span>
        )}
        {ticket.status !== "open" && <span className={styles.chip}>{t(`status.${ticket.status}`)}</span>}
        {/* The responsible team is in the ticket panel, not here: the owner asked for it off the header. */}
        <AssigneePicker ticket={ticket} onChanged={onTicketChanged} />
        {overridden && (
          <span className={`${styles.chip} ${styles.overrideChip}`} title={t("tickets.panels.header.overriddenHint")}>
            <PencilIcon size={12} />
            {t("tickets.panels.header.overridden")}
          </span>
        )}
        <StatusIcons ticket={ticket} size={13} />
      </div>

      {ticket.snooze && !closed && <SnoozeBanner snooze={ticket.snooze} />}
      {ticket.forwarding && <ForwardingBanner forwarding={ticket.forwarding} />}

      <ContextStripBar ticket={ticket} detail={detail} thread={thread} />
    </div>
  );
}

function ContextStripBar({ ticket, detail, thread }: { ticket: TicketListItem; detail: TicketDetail | null; thread: TicketThread | null }) {
  const t = useT();
  const strip = contextStrip(ticket, detail, thread);
  if (strip.pieces.length === 0 && !strip.action && !strip.approval) return null;

  return (
    <div className={styles.strip} aria-label={t("tickets.panels.strip.label")}>
      {strip.action && (
        <span className={styles.stripAction} title={strip.action}>
          <SparkleIcon size={13} />
          <strong>{t("tickets.panels.nextAction")}</strong>
          <span className={styles.stripActionText}>{strip.action}</span>
        </span>
      )}
      {strip.pieces.map((piece, index) => (
        <StripItem key={`${piece.kind}-${index}`} piece={piece} parcels={thread?.parcels ?? []} />
      ))}
      {strip.approval && (
        <span
          className={`${styles.approval} ${styles[`approval_${strip.approval}`]}`}
          title={t(`tickets.panels.strip.approvalHint.${strip.approval}`)}
        >
          <SendIcon size={12} />
          {t(`tickets.panels.strip.approval.${strip.approval}`)}
        </span>
      )}
    </div>
  );
}

function StripItem({ piece, parcels }: { piece: StripPiece; parcels: TicketThread["parcels"] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  switch (piece.kind) {
    case "order":
      return (
        <span className={styles.stripPiece}>
          <OrdersIcon size={13} />
          <strong>{piece.value}</strong>
        </span>
      );
    case "orderStatus":
      return <span className={styles.stripPiece}>{piece.value}</span>;
    case "delivery":
      return (
        <span className={styles.stripPiece}>
          <TruckIcon size={13} />
          {piece.value}
        </span>
      );
    case "parcel":
      return (
        <span className={styles.stripPiece}>
          <TrackingText text={piece.carrier ? `${piece.carrier} ${piece.value}` : piece.value} parcels={parcels} />
        </span>
      );
    case "channel":
      return (
        <span className={`${styles.stripPiece} ${styles.stripChannel}`}>
          <TagIcon size={13} />
          {piece.value}
        </span>
      );
    case "language":
      return (
        <span className={styles.stripPiece}>
          <GlobeIcon size={13} />
          {t(`tickets.panels.lang.${piece.value}`)}
        </span>
      );
    case "noOrder":
      return <span className={`${styles.stripPiece} ${styles.stripMuted}`}>{t("tickets.panels.strip.noOrder")}</span>;
    case "reference":
      return (
        <button
          type="button"
          className={`${styles.stripPiece} ${styles.stripReference}`}
          title={copied ? t("tickets.panels.strip.copied") : t("tickets.panels.strip.copy")}
          onClick={() => {
            void navigator.clipboard?.writeText(piece.value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {piece.value}
          <CopyIcon size={12} />
        </button>
      );
  }
}
