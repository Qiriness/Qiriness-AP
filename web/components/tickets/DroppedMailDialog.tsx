"use client";

import { Dialog } from "@/components/ui/Dialog";
import { formatRelativeTime } from "@/lib/relative-time";
import type { DroppedMail } from "@/lib/types";
import styles from "./DroppedMailDialog.module.css";

interface DroppedMailDialogProps {
  mail: DroppedMail;
  onClose: () => void;
}

/**
 * The email the spam gate dropped, and nothing else.
 *
 * THE DECISION IS NOT REPEATED HERE. Verdict, gate, reason and timing are all
 * columns in the row this was opened from, so restating them turns the one thing
 * the table cannot show — the message itself — into a footnote on data already
 * on screen. The dialog exists to answer "should this have become a ticket?",
 * and past the subject line only the email answers that.
 *
 * THE BODY IS NULL IN THREE DIFFERENT WAYS and they are not interchangeable:
 * never captured (the row predates 08_spam_audit_body.sql and the backfill has
 * not reached it, or the message had already left the mailbox), captured and
 * since expired (the worker's retention purge), or a genuinely empty email. Each
 * gets its own sentence, because "no body" alone reads as a bug in all three
 * cases and is only actionable in the first.
 */
export function DroppedMailDialog({ mail, onClose }: DroppedMailDialogProps) {
  // Captured-then-purged, distinguished from never-captured by the stamp the
  // backfill and ingestion both write. The expiry alone would not: a row whose
  // body is still live also has one.
  const expired = !mail.body && Boolean(mail.bodyCapturedAt);

  return (
    <Dialog
      title={mail.subject?.trim() || "(no subject)"}
      closeLabel="Close the dropped mail record"
      onClose={onClose}
      meta={
        <>
          {mail.fromEmail?.trim() || "Unknown sender"}
          {mail.decidedAt ? ` · dropped ${formatRelativeTime(mail.decidedAt)}` : ""}
        </>
      }
    >
      {/* The one piece of decision context kept, because it is the only one with
          no column in the table and it changes how the text below should be
          read: the classifier errored, so this drop is a fallback rather than a
          judgement about the email. */}
      {mail.failedOpen && (
        <p className={styles.warning} role="note">
          The classifier failed on this email. The decision was taken by the fallback, not
          by a reading of the message.
        </p>
      )}

      {mail.body ? (
        <>
          {/* `pre`, like the ticket thread: this is the same cleaned plain text,
              whose paragraph breaks are the only structure it has left. */}
          <pre className={styles.body}>{mail.body}</pre>
          {mail.bodyExpiresAt && (
            <p className={styles.stamp}>
              This text is kept for review only and is deleted{" "}
              <time dateTime={mail.bodyExpiresAt}>{formatRelativeTime(mail.bodyExpiresAt)}</time>.
              The decision record is kept.
            </p>
          )}
        </>
      ) : expired ? (
        <p className={styles.placeholder}>
          The text has passed its retention window and was deleted. The decision record is
          kept indefinitely; only the message itself expires.
        </p>
      ) : (
        <p className={styles.placeholder}>
          No text was captured for this email. Decisions made before the body was stored can
          be filled in from the mailbox — run <code>npm run spam:backfill</code> from{" "}
          <code>agent/</code> — unless the message has since left the Inbox, in which case
          the row&rsquo;s decision record is all there will ever be.
        </p>
      )}
    </Dialog>
  );
}
