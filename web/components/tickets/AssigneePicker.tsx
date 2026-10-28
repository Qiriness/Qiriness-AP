"use client";

/**
 * Who a ticket is with: an avatar on the queue card, and in the header a chip
 * that is a menu (anyone in the team, or nobody) with « Assign to me » beside
 * it. Only a person assigns; nothing assigns automatically, and the assignee is
 * kept through close and reopen. docs/decisions/tickets-dashboard.md § Assignment.
 */
import { useState } from "react";
import { UserIcon } from "@/components/icons";
import { assignTicket } from "@/lib/api/tickets";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import type { TicketListItem } from "@/lib/types";
import { initialsOf, useTeam } from "./team-context";
import styles from "./AssigneePicker.module.css";

/** The assignee's initials on a queue card; nothing when the ticket is with nobody. */
export function AssigneeAvatar({ ticket }: { ticket: TicketListItem }) {
  const t = useT();
  const { memberOf, currentUserId } = useTeam();
  if (!ticket.assignedTo) return null;
  const member = memberOf(ticket.assignedTo);
  const name = member?.name ?? t("tickets.panels.assign.former");
  const mine = ticket.assignedTo === currentUserId;
  const label = t("tickets.panels.assign.with", { name });
  return (
    <span className={`${styles.avatar} ${mine ? styles.avatarMine : ""}`} title={label} role="img" aria-label={label}>
      {member ? initialsOf(member.name) : "?"}
    </span>
  );
}

export function AssigneePicker({ ticket, onChanged }: { ticket: TicketListItem; onChanged: (ticket: TicketListItem) => void }) {
  const t = useT();
  const { team, currentUserId, memberOf } = useTeam();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = memberOf(ticket.assignedTo);
  const mine = Boolean(currentUserId) && ticket.assignedTo === currentUserId;

  async function assign(assigneeId: string | null) {
    if (assigneeId === ticket.assignedTo) return;
    setSaving(true);
    setError(null);
    try {
      onChanged(await assignTicket(ticket.id, assigneeId));
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (team.length === 0 && !ticket.assignedTo) return null;

  return (
    <span className={styles.picker}>
      <label className={`${styles.chip} ${ticket.assignedTo ? styles.chipAssigned : ""}`} title={error ?? undefined}>
        {current ? (
          <span className={`${styles.avatar} ${mine ? styles.avatarMine : ""}`} aria-hidden="true">
            {initialsOf(current.name)}
          </span>
        ) : (
          <UserIcon size={13} />
        )}
        <span className={styles.srOnly}>{t("tickets.panels.assign.label")}</span>
        <select
          className={styles.select}
          value={ticket.assignedTo ?? ""}
          disabled={saving}
          onChange={(event) => void assign(event.target.value || null)}
        >
          <option value="">{t("tickets.panels.assign.nobody")}</option>
          {/* A former member still holding the ticket: shown so the value is not lost. */}
          {ticket.assignedTo && !current && <option value={ticket.assignedTo}>{t("tickets.panels.assign.former")}</option>}
          {team.map((member) => (
            <option key={member.id} value={member.id}>
              {member.id === currentUserId ? t("tickets.panels.assign.me", { name: member.name }) : member.name}
            </option>
          ))}
        </select>
      </label>
      {currentUserId && !mine && team.some((member) => member.id === currentUserId) && (
        <button type="button" className={styles.toMe} disabled={saving} onClick={() => void assign(currentUserId)}>
          {t("tickets.panels.assign.toMe")}
        </button>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
