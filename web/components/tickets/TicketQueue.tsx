"use client";

/**
 * The ticket queue, in two widths.
 *
 * FULL: rounded cards — who, when and how urgent on the first line, the subject,
 * the ticket and order numbers, then the category and the status icons. The
 * priority SCORE is gone from the card (it still ranks the list); a red, amber
 * or green dot says the band.
 *
 * COMPACT: a rail of initials, each with its category edge and priority dot.
 * Opening a ticket collapses the queue to it, to give the conversation the
 * width; the expand button brings the cards back until the next ticket is
 * opened. docs/decisions/tickets-dashboard.md § The queue collapses to a rail.
 */
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import type { TicketListItem } from "@/lib/types";
import { CategoryIcon, PriorityDot, StatusIcons, TicketNumber, categoryVars, priorityTitle } from "./ticket-marks";
import { requesterInitials, requesterName, ticketAge, ticketTitle } from "./ticket-text";
import { AssigneeAvatar } from "./AssigneePicker";
import { useTeam } from "./team-context";
import styles from "./TicketQueue.module.css";

export type QueueMode = "full" | "compact";

/** Whose tickets the queue shows. `all` by default, so nothing changes until someone chooses. */
export type AssigneeFilter = "all" | "mine" | "unassigned";
export const ASSIGNEE_FILTERS: readonly AssigneeFilter[] = ["mine", "unassigned", "all"];

interface TicketQueueProps {
  /** The tab's name, e.g. « Queue ». */
  viewLabel: string;
  /** The order the tab is sorted in, said under its name. */
  orderLabel: string;
  tickets: TicketListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Said in place of the empty list while it is being read, or failed to be. */
  notice?: string | null;
  mode: QueueMode;
  onModeChange: (mode: QueueMode) => void;
  assignee: AssigneeFilter;
  onAssigneeChange: (filter: AssigneeFilter) => void;
}

export function TicketQueue({
  viewLabel,
  orderLabel,
  tickets,
  selectedId,
  onSelect,
  notice = null,
  mode,
  onModeChange,
  assignee,
  onAssigneeChange,
}: TicketQueueProps) {
  const t = useT();
  const { team, currentUserId } = useTeam();

  if (mode === "compact") {
    return (
      <aside className={`${styles.queue} ${styles.compact}`} aria-label={t("tickets.view.listLabel", { view: viewLabel })}>
        <button
          type="button"
          className={styles.railToggle}
          onClick={() => onModeChange("full")}
          title={t("tickets.panels.queue.expand")}
          aria-label={t("tickets.panels.queue.expand")}
        >
          <ChevronRightIcon size={16} />
        </button>
        <span className={styles.railCount} title={t("tickets.panels.list.count", { count: tickets.length })}>
          {tickets.length}
        </span>
        <ol className={styles.rail} role="listbox" aria-label={t("tickets.panels.list.ticketsLabel", { view: viewLabel })}>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                role="option"
                aria-selected={selectedId === ticket.id}
                className={`${styles.railTile} ${selectedId === ticket.id ? styles.railTileSelected : ""}`}
                style={categoryVars(ticket.category)}
                title={`${requesterName(ticket, t)} — ${ticketTitle(ticket, t)}`}
                onClick={() => onSelect(ticket.id)}
              >
                <span aria-hidden="true">{requesterInitials(ticket, t)}</span>
                <span className={styles.railDot}>
                  <PriorityDot band={ticket.priorityBand} title={priorityTitle(ticket, t)} />
                </span>
                <span className={styles.srOnly}>{`${requesterName(ticket, t)} — ${ticketTitle(ticket, t)}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
    );
  }

  return (
    <aside className={styles.queue} aria-label={t("tickets.view.listLabel", { view: viewLabel })}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2>{viewLabel}</h2>
          <p>
            {t("tickets.panels.list.count", { count: tickets.length })} · {orderLabel}
          </p>
        </div>
        {selectedId && (
          <button
            type="button"
            className={styles.collapse}
            onClick={() => onModeChange("compact")}
            title={t("tickets.panels.queue.collapse")}
            aria-label={t("tickets.panels.queue.collapse")}
          >
            <ChevronLeftIcon size={16} />
          </button>
        )}
      </div>

      {/* « Mine » needs to know who is reading, and the switch is pointless with no team. */}
      {team.length > 0 && currentUserId && (
        <div className={styles.segmented} role="radiogroup" aria-label={t("tickets.panels.assign.filterLabel")}>
          {ASSIGNEE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={assignee === value}
              className={assignee === value ? styles.segmentActive : undefined}
              onClick={() => onAssigneeChange(value)}
            >
              {t(`tickets.panels.assign.filter.${value}`)}
            </button>
          ))}
        </div>
      )}

      {tickets.length === 0 ? (
        <div className={styles.empty}>
          {notice ? (
            <p>{notice}</p>
          ) : (
            <>
              <p className={styles.emptyTitle}>{t("tickets.panels.list.emptyTitle")}</p>
              <p>{t("tickets.panels.list.emptyBody")}</p>
            </>
          )}
        </div>
      ) : (
        <ol className={styles.list} role="listbox" aria-label={t("tickets.panels.list.ticketsLabel", { view: viewLabel })}>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <QueueCard ticket={ticket} selected={selectedId === ticket.id} onSelect={onSelect} />
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function QueueCard({ ticket, selected, onSelect }: { ticket: TicketListItem; selected: boolean; onSelect: (id: string) => void }) {
  const t = useT();
  const title = ticketTitle(ticket, t);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`${styles.card} ${selected ? styles.cardSelected : ""}`}
      style={categoryVars(ticket.category)}
      onClick={() => onSelect(ticket.id)}
    >
      <span className={styles.cardTop}>
        <span className={styles.person}>{requesterName(ticket, t)}</span>
        <span className={styles.when}>
          <time dateTime={ticket.lastMessageAt ?? undefined}>{ticketAge(ticket, t)}</time>
          <PriorityDot band={ticket.priorityBand} title={priorityTitle(ticket, t)} />
        </span>
      </span>
      <span className={styles.subject} title={title}>
        {title}
      </span>
      <span className={styles.refs}>
        <TicketNumber ticket={ticket} className={styles.ticketNumber} />
        {ticket.orderNumber && <span>{t("tickets.panels.orderNumber", { number: ticket.orderNumber })}</span>}
      </span>
      <span className={styles.cardBottom}>
        <span className={styles.category}>
          <span className={styles.categoryIcon}>
            <CategoryIcon category={ticket.category} size={13} />
          </span>
          <span className={styles.categoryLabel}>
            {ticket.category ? t(`category.${ticket.category}`) : t("tickets.panels.uncategorised")}
          </span>
        </span>
        <span className={styles.cardMarks}>
          <StatusIcons ticket={ticket} />
          <AssigneeAvatar ticket={ticket} />
        </span>
      </span>
    </button>
  );
}
