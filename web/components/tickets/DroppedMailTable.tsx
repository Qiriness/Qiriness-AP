"use client";

import { Button } from "@/components/ui/Button";
import type { DroppedMail } from "@/lib/types";
import { formatRelativeTime } from "@/lib/relative-time";
import styles from "./TicketTable.module.css";

interface DroppedMailTableProps {
  mail: DroppedMail[];
}

const LABELS: Record<string, string> = {
  spam: "Spam",
  irrelevant: "Irrelevant",
  keep: "Keep",
};

/**
 * Mail the spam gate dropped — `spam_audit` rows, not tickets. The email itself
 * was never stored, so there is no body, no level, no category and no message
 * count to show: what the gate wrote down is all there is.
 *
 * "Add as ticket" is deliberately disabled rather than absent. Promoting one
 * back means re-fetching it from Graph, which is the agent worker's job, and
 * hiding the button would hide the fact that this is recoverable at all. Reuses
 * TicketTable's stylesheet so the two tables cannot drift apart visually.
 */
export function DroppedMailTable({ mail }: DroppedMailTableProps) {
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
                <span className={styles.subject} title={item.subject ?? undefined}>
                  {item.subject?.trim() || "(no subject)"}
                </span>
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
                  disabled
                  title="The email body was never stored, so promoting it back needs the agent worker to re-fetch it from Graph. Not built yet."
                >
                  Add as ticket
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
