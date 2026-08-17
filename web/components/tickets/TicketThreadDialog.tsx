"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { fetchTicketThread } from "@/lib/api/tickets";
import { formatRelativeTime } from "@/lib/relative-time";
import type { TicketListItem, TicketMessage, TicketThread } from "@/lib/types";
import styles from "./TicketThreadDialog.module.css";

interface TicketThreadDialogProps {
  ticket: TicketListItem;
  onClose: () => void;
}

/**
 * The whole case in one overlay: the reply the agent would send, and under it
 * the conversation it was written from.
 *
 * WHY IN-APP RATHER THAN A LINK INTO OUTLOOK. A deep link would need the Graph
 * `webLink` for a message, and ingestion does not store one — `sanitizeGraphPayload`
 * keeps ids and addresses and deliberately nothing that is a URL into a mailbox.
 * Worse, the mailbox is read with an *application* credential, so a link built
 * from a message id resolves only for a person who happens to have that shared
 * mailbox mounted; for anyone else it is a dead end that looks like a bug. The
 * bodies are already in `ticket_messages` and already cleaned, so reading the
 * thread here is both cheaper and the same text every agent pass saw.
 *
 * TWO SECTIONS, IN THIS ORDER. The draft is what an operator is deciding about;
 * the thread is the evidence for that decision. Putting the conversation first
 * would mean scrolling past it to reach the only thing there is to act on.
 *
 * Read-only. Sending still happens in Outlook — this exists so *reading* a case
 * does not.
 */
export function TicketThreadDialog({ ticket, onClose }: TicketThreadDialogProps) {
  const [thread, setThread] = useState<TicketThread | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    fetchTicketThread(ticket.id)
      .then((loaded) => {
        if (live) setThread(loaded);
      })
      .catch((cause) => {
        if (live) setError(knowledgeErrorMessage(cause));
      });

    return () => {
      live = false;
    };
  }, [ticket.id]);

  const subject = thread?.subject ?? ticket.subject;

  return (
    <Dialog
      title={subject?.trim() || "(no subject)"}
      closeLabel="Close the conversation"
      onClose={onClose}
      meta={
        <>
          {ticket.requesterName?.trim() || "Unknown requester"}
          {ticket.orderNumber ? ` · Order ${ticket.orderNumber}` : ""}
          {thread ? ` · ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}` : ""}
        </>
      }
    >
      <section className={styles.section}>
        <h3 className={styles.heading}>Draft reply</h3>
        {thread?.draft ? (
          <>
            <pre className={styles.draft}>{thread.draft.body}</pre>
            {thread.draft.draftedAt && (
              <p className={styles.stamp}>
                Drafted{" "}
                <time dateTime={thread.draft.draftedAt}>
                  {formatRelativeTime(thread.draft.draftedAt)}
                </time>
              </p>
            )}
          </>
        ) : (
          /* Not an error and not an empty result: the drafting agent is not
             built yet, so there is nothing to have failed. Saying so beats a
             blank box that reads as a load that went wrong. */
          <p className={styles.placeholder}>
            No draft yet — the drafting agent is not built. What the agent established
            about this ticket is in the expanded row.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Conversation</h3>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : !thread ? (
          <p className={styles.placeholder}>Loading the thread…</p>
        ) : thread.messages.length === 0 ? (
          <p className={styles.placeholder}>This ticket holds no stored messages.</p>
        ) : (
          <ol className={styles.messages}>
            {thread.messages.map((message) => (
              <MessageBlock key={message.id} message={message} />
            ))}
          </ol>
        )}
      </section>
    </Dialog>
  );
}

/**
 * Who sent a message: the display name, and the address behind it when those are
 * two different things.
 *
 * THE ADDRESS IS ONLY WORTH PRINTING WHEN IT ADDS SOMETHING. A large share of
 * rows carry an address in `from_name` — Graph reports a display name only when
 * the sender's client supplied one, and plenty do not — so printing
 * `name <email>` unconditionally renders `x@y.com <x@y.com>` down half the
 * thread. Equality is what separates the two cases.
 *
 * Compared case-insensitively and trimmed, because an address is
 * case-insensitive in practice: `Jean@Qiriness.com` in the name field is the
 * same sender as `jean@qiriness.com` in the address field, and treating them as
 * different would print the duplicate this check exists to avoid.
 */
function senderIdentity(message: TicketMessage, outbound: boolean): {
  name: string;
  email: string | null;
} {
  const name = message.fromName?.trim() ?? "";
  const email = message.fromEmail?.trim() ?? "";

  // Nothing at all: the direction is the only thing left to say who this was.
  if (!name && !email) return { name: outbound ? "Qiriness" : "Unknown sender", email: null };
  // The address is the identity — as a name on its own, not repeated beside it.
  if (!name) return { name: email, email: null };
  if (!email) return { name, email: null };

  return { name, email: name.toLowerCase() === email.toLowerCase() ? null : email };
}

/**
 * One email. Inbound and outbound are visually distinct because the thread is
 * half our own replies — the Inbox holds both, and a wall of undifferentiated
 * blocks is precisely what makes Outlook tiring to read.
 */
function MessageBlock({ message }: { message: TicketMessage }) {
  const outbound = message.direction === "outbound";
  const sender = senderIdentity(message, outbound);

  return (
    <li className={`${styles.message} ${outbound ? styles.outbound : styles.inbound}`}>
      <div className={styles.messageHead}>
        <span className={styles.sender}>{sender.name}</span>
        {sender.email && <span className={styles.senderEmail}>{sender.email}</span>}
        <span className={styles.direction}>{outbound ? "Sent" : "Received"}</span>
        {message.at && (
          <time className={styles.when} dateTime={message.at}>
            {formatRelativeTime(message.at)}
          </time>
        )}
        {message.hasAttachments && <span className={styles.attachment}>Has attachments</span>}
      </div>
      {/* `pre` rather than `p`: `body_text` is plain text whose paragraph breaks
          and quoted-reply indentation are the only structure it has left after
          htmlToText, and collapsing them turns a thread into one block. */}
      {message.body?.trim() ? (
        <pre className={styles.messageBody}>{message.body}</pre>
      ) : (
        <p className={styles.placeholder}>No body stored for this message.</p>
      )}
    </li>
  );
}
