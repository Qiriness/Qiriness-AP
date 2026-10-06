"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/lib/i18n/client";
import { formatRelativeTime } from "@/lib/relative-time";
import { TrackingText } from "@/components/ui/TrackingText";
import type { DroppedMail } from "@/lib/types";
import styles from "./DroppedMailDialog.module.css";

interface DroppedMailDialogProps {
  mail: DroppedMail;
  onClose: () => void;
  /** Overturns the gate. Offered only where there is a body to read. */
  onPromote: () => void;
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
 * never captured (the row predates the body columns and the backfill has
 * not reached it, or the message had already left the mailbox), captured and
 * since expired (the worker's retention purge), or a genuinely empty email. Each
 * gets its own sentence, because "no body" alone reads as a bug in all three
 * cases and is only actionable in the first.
 */
export function DroppedMailDialog({ mail: listed, onClose, onPromote }: DroppedMailDialogProps) {
  const t = useT();
  // THE TEXT IS READ WHEN THE DIALOG OPENS. The list carries none: every body
  // on every /tickets load was 1.9 MB (2026-10-06). A row that already has its
  // text (`bodyLoaded` absent or true) is shown as it is.
  const [loaded, setLoaded] = useState<DroppedMail | null>(listed.bodyLoaded === false ? null : listed);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (listed.bodyLoaded !== false) return;
    let live = true;
    fetch(`/api/dropped-mail/${encodeURIComponent(listed.id)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((full: DroppedMail) => live && setLoaded(full))
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [listed]);
  const mail = loaded ?? listed;
  // Captured-then-purged, distinguished from never-captured by the stamp the
  // backfill and ingestion both write. The expiry alone would not: a row whose
  // body is still live also has one.
  const expired = !mail.body && Boolean(mail.bodyCapturedAt);

  return (
    <Dialog
      title={mail.subject?.trim() || t("tickets.view.noSubject")}
      closeLabel={t("tickets.dialogs.dropped.closeRecord")}
      onClose={onClose}
      meta={
        <>
          {mail.fromEmail?.trim() || t("tickets.panels.unknownSender")}
          {mail.decidedAt ? ` · ${t("tickets.panels.irrelevant.droppedAgo", { when: formatRelativeTime(mail.decidedAt, t) })}` : ""}
        </>
      }
    >
      {/* The one piece of decision context kept, because it is the only one with
          no column in the table and it changes how the text below should be
          read: the classifier errored, so this drop is a fallback rather than a
          judgement about the email. */}
      {mail.failedOpen && (
        <p className={styles.warning} role="note">
          {t("tickets.dialogs.dropped.failedOpen")}
        </p>
      )}

      {!loaded ? (
        <p className={styles.placeholder}>
          {loadFailed ? t("tickets.dialogs.dropped.loadFailed") : t("tickets.dialogs.dropped.loading")}
        </p>
      ) : mail.body ? (
        <>
          {/* `pre`, like the ticket thread: this is the same cleaned plain text,
              whose paragraph breaks are the only structure it has left. */}
          <pre className={styles.body}>
            <TrackingText text={mail.body} parcels={mail.parcels} />
          </pre>
          {mail.bodyExpiresAt && (
            <p className={styles.stamp}>
              {t("tickets.dialogs.dropped.keptFor")}{" "}
              <time dateTime={mail.bodyExpiresAt}>{formatRelativeTime(mail.bodyExpiresAt, t)}</time>.{" "}
              {t("tickets.dialogs.dropped.recordKept")}
            </p>
          )}

          {/* The answer to the question the dialog was opened to ask, offered
              where it is reached. Only under a body: the action refuses without
              one, and an enabled button that cannot work is worse than none.

              The sentence beside it is the honest scope of the click — this
              email, not this sender. Nothing here edits the blocklist or the
              classifier, so the next email from the same address is dropped
              again. */}
          <div className={styles.actions}>
            <Button variant="primary" size="sm" onClick={onPromote}>
              {t("tickets.panels.irrelevant.addAsTicket")}
            </Button>
            <p className={styles.stamp}>{t("tickets.dialogs.dropped.scope")}</p>
          </div>
        </>
      ) : expired ? (
        <p className={styles.placeholder}>
          {t("tickets.dialogs.dropped.expired")}
        </p>
      ) : (
        <p className={styles.placeholder}>
          {t("tickets.dialogs.dropped.noText")} <code>npm run spam:backfill</code>{" "}
          {t("tickets.dialogs.dropped.noTextFrom")} <code>agent/</code> {t("tickets.dialogs.dropped.noTextEnd")}
        </p>
      )}
    </Dialog>
  );
}
