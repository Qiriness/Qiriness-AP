"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { DroppedMail } from "@/lib/types";
import { formatRelativeTime } from "@/lib/relative-time";
import { DroppedMailDialog } from "./DroppedMailDialog";
import styles from "./TicketTable.module.css";

interface DroppedMailTableProps {
  mail: DroppedMail[];
  /** Overturns the gate on one row: the email becomes a ticket. */
  onPromote: (mail: DroppedMail) => void;
  /** The row a promotion is in flight for, or null. */
  pendingId: string | null;
}

const LABELS: Record<string, string> = {
  spam: "Spam",
  irrelevant: "Irrelevant",
  keep: "Keep",
};

/**
 * Mail the spam gate dropped — `spam_audit` rows, not tickets. The email itself
 * never became a ticket, so there is no level, no category and no message count
 * to show: what the gate wrote down is all there is. The body is the exception
 * and is on the row rather than in this table — it is what the dialog opens, and
 * what makes the drop reviewable at all.
 *
 * "Add as ticket" now writes. It was disabled for as long as promoting one back
 * meant re-fetching it from Graph — unreachable while the stored message ids
 * belong to another mailbox — and the stored body is what removed the need: the
 * row already holds everything a ticket message wants. Clicking it threads the
 * email in through the ordinary ingestion path and flags it for the categoriser,
 * so the agent reads it on its next poll. Reuses TicketTable's stylesheet so the
 * two tables cannot drift apart visually.
 *
 * IT IS STILL DISABLED WITHOUT A BODY, for the reason the dialog spells out in
 * three sentences: never captured, or captured and since expired. The agent
 * reads bodies, so a ticket made from a subject line is one every pass
 * downstream would skip.
 *
 * The subject opens the decision record, the same gesture as a ticket's subject
 * — but what opens is the gate's reasoning, not a conversation, because there
 * is no stored email to show. Worth a dialog anyway: the subject, the sender
 * and especially the reason are the three longest fields here and all three are
 * truncated in a row.
 */
export function DroppedMailTable({ mail, onPromote, pendingId }: DroppedMailTableProps) {
  const [openMail, setOpenMail] = useState<DroppedMail | null>(null);

  if (mail.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Nothing has been dropped</p>
        <p className={styles.emptyBody}>
          Mail blocked by the blocklist or the spam classifier will appear here.
        </p>
      </div>
    );
  }

  return (
    <>
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>
          {mail.length.toLocaleString()} dropped emails, most recent decision first
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.subjectCol}>Subject</th>
            <th scope="col">From</th>
            <th scope="col">Verdict</th>
            <th scope="col">Decided by</th>
            <th scope="col">Reason</th>
            <th scope="col">Decided</th>
            <th scope="col" className={styles.actionCol}>
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {mail.map((item) => (
            <tr key={item.id}>
              <th scope="row" className={styles.subjectCell}>
                <button
                  type="button"
                  className={styles.subjectButton}
                  title={item.subject ?? undefined}
                  onClick={() => setOpenMail(item)}
                >
                  <span className={styles.subject}>
                    {item.subject?.trim() || "(no subject)"}
                  </span>
                </button>
              </th>

              <td className={styles.requester} title={item.fromEmail ?? undefined}>
                {item.fromEmail?.trim() || <span className={styles.muted}>Unknown</span>}
              </td>

              <td>
                {/* The blocklist pass writes no label — say so rather than
                    showing an empty cell that reads as missing data. */}
                {item.label ? LABELS[item.label] ?? item.label : <span className={styles.muted}>Blocklisted</span>}
              </td>

              <td>{item.decidedBy === "llm" ? "Classifier" : "Blocklist"}</td>

              <td className={styles.reason} title={item.reason}>
                {item.reason}
              </td>

              <td className={styles.time}>
                <time dateTime={item.decidedAt ?? undefined}>
                  {formatRelativeTime(item.decidedAt) || "—"}
                </time>
              </td>

              <td className={styles.actionCol}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!item.body}
                  loading={pendingId === item.id}
                  onClick={() => onPromote(item)}
                  title={
                    item.body
                      ? "Overturn the gate: thread this email into a ticket and let the agent read it."
                      : "The text of this email is not stored, so there is nothing for the agent to read into a ticket."
                  }
                >
                  Add as ticket
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {/* Outside the scroller and outside the table, for the same reason as the
        ticket thread: an overlay is not tabular data. */}
    {openMail && (
      <DroppedMailDialog
        mail={openMail}
        onClose={() => setOpenMail(null)}
        // The dialog is where the body is read, so it is where the answer to
        // "should this have become a ticket?" is actually reached — the action
        // belongs on both, not only on the row. It closes on the click: the row
        // behind carries the pending state and then leaves the section, and a
        // dialog left open over a row that no longer exists reads as a failure.
        onPromote={() => {
          onPromote(openMail);
          setOpenMail(null);
        }}
      />
    )}
    </>
  );
}
