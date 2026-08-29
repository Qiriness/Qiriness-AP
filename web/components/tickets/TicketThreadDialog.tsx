"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { decideOnDraft, fetchTicketThread } from "@/lib/api/tickets";
import { formatRelativeTime } from "@/lib/relative-time";
import { TrackingText } from "@/components/ui/TrackingText";
import type { TicketListItem, TicketMessage, TicketThread, TicketTracking } from "@/lib/types";
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
/**
 * What the draft section is called, by what the case file concluded.
 *
 * An acknowledgement is named as one rather than as a "reply", because a
 * reviewer skimming the queue needs to know before reading that this text
 * resolves nothing — it is the case where the words look most like an answer
 * and are least meant to be one.
 */
/** Written as a constant because a literal newline escape cannot survive a JSX attribute. */
const NEWLINE = String.fromCharCode(10);

const DRAFT_HEADINGS: Record<string, string> = {
  answerable: "Draft reply",
  needs_customer_input: "Draft question to the customer",
  needs_human: "Draft acknowledgement — resolves nothing",
};

export function TicketThreadDialog({ ticket, onClose }: TicketThreadDialogProps) {
  const [thread, setThread] = useState<TicketThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The editor is opt-in: a reviewer reads first and edits second, and a
  // textarea that is always open invites changing text nobody had decided about.
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  const [saving, setSaving] = useState<null | "approved" | "edited" | "rejected">(null);
  const [decideError, setDecideError] = useState<string | null>(null);

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

  const draft = thread?.draft ?? null;

  async function decide(status: "approved" | "edited" | "rejected") {
    if (!draft) return;
    setSaving(status);
    setDecideError(null);
    try {
      // The rewrite travels only on an edit. Sending it with an approval would
      // record a correction nobody made.
      const updated = await decideOnDraft(ticket.id, {
        status,
        approvedBody: status === "edited" ? edited : null,
      });
      setThread((current) => (current ? { ...current, draft: updated } : current));
      setEditing(false);
    } catch (cause) {
      setDecideError(knowledgeErrorMessage(cause));
    } finally {
      setSaving(null);
    }
  }

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
        {/* ABOVE THE HEADING, not beside the draft. If this ticket duplicates
            another the whole section is something not to act on, and a warning
            underneath the reply arrives after the reader has already decided
            it looks fine. */}
        {thread?.duplicateOf && (
          <p className={styles.duplicate} role="alert">
            Duplicate of another ticket
            {thread.duplicateOf.reason === "identical_body"
              ? " — the same message arrived twice"
              : " — part of the same email conversation"}
            . The agent will not draft here, and this reply should not be sent:
            answer on the original instead.
          </p>
        )}
        {/* Below the duplicate banner and visually calmer than it, because the
            two say opposite things: that one means do not act, this one means
            read the earlier thread first. Never suppresses the draft. */}
        {thread?.relatedTo && !thread?.duplicateOf && (
          <p className={styles.related}>
            This customer wrote to us before about the same thing — see the earlier ticket.
            The reply below takes that into account.
          </p>
        )}
        <h3 className={styles.heading}>{DRAFT_HEADINGS[thread?.draft?.sourceVerdict ?? "answerable"]}</h3>
        {thread?.draft ? (
          <>
            {/* The failed checks go ABOVE the text. A reviewer who reads a
                fluent draft first has already decided it is fine by the time a
                warning underneath it arrives. */}
            {!thread.draft.checksPassed && (
              <p className={styles.blocked} role="alert">
                Not sendable — {thread.draft.failedChecks.length || "some"} mechanical{" "}
                {thread.draft.failedChecks.length === 1 ? "check" : "checks"} failed:{" "}
                {thread.draft.failedChecks.join("; ") || "see the draft record"}.
              </p>
            )}
            {/* THE MODEL'S TEXT IS NEVER EDITED IN PLACE. Opening the editor
                copies it into a textarea; saving writes the rewrite to a
                separate column and appends the pair to the edit log, so what
                the agent wrote stays readable beside what a person sent. */}
            {editing ? (
              <textarea
                className={styles.editor}
                value={edited}
                onChange={(event) => setEdited(event.target.value)}
                rows={Math.min(24, Math.max(8, edited.split(NEWLINE).length + 2))}
                aria-label="Edit the drafted reply"
              />
            ) : (
              <pre className={styles.draft}>
                <TrackingText text={thread.draft.body} parcels={thread.parcels} />
              </pre>
            )}
            {/* The model's text stays above; a reviewer's rewrite is shown as a
                second block rather than replacing it, because the difference
                between them is what says whether the drafting is any good. */}
            {thread.draft.approvedBody && (
              <>
                <h3 className={styles.heading}>Reviewer&apos;s version</h3>
                <pre className={styles.draft}>
                  <TrackingText text={thread.draft.approvedBody} parcels={thread.parcels} />
                </pre>
              </>
            )}
            {/* What happens when this is sent, said in the review surface rather
                than left to the send path. An operator approving a draft is
                approving its consequence too: a terminal reply finishes the
                thread, an intermediary one hands it to whoever is waited on. */}
            <p className={styles.stamp}>
              {thread.draft.disposition === "terminal"
                ? "Terminal — sending this closes the ticket."
                : thread.draft.sourceVerdict === "needs_customer_input"
                  ? "Intermediary — sending this waits on the customer."
                  : "Intermediary — a colleague still owes this customer an answer."}
            </p>
            {/* The three decisions a person can reach by reading. There is no
                fourth: nothing in this codebase can send an email, so a draft
                leaves here approved, rewritten or rejected — never sent. */}
            <div className={styles.actions}>
              {editing ? (
                <>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={saving !== null || edited.trim() === ""}
                    onClick={() => decide("edited")}
                  >
                    {saving === "edited" ? "Saving…" : "Save edit"}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={saving !== null}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => {
                      // Seeded with the reviewer's own version when there is
                      // one — editing an edit continues from where they left
                      // off, not from the agent's text again.
                      setEdited(thread.draft?.approvedBody ?? thread.draft?.body ?? "");
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={saving !== null}
                    onClick={() => decide("approved")}
                  >
                    {saving === "approved" ? "Saving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={saving !== null}
                    onClick={() => decide("rejected")}
                  >
                    {saving === "rejected" ? "Saving…" : "Reject"}
                  </button>
                </>
              )}
            </div>

            {decideError && (
              <p className={styles.error} role="alert">
                {decideError}
              </p>
            )}

            {thread.draft.draftedAt && (
              <p className={styles.stamp}>
                Drafted{" "}
                <time dateTime={thread.draft.draftedAt}>
                  {formatRelativeTime(thread.draft.draftedAt)}
                </time>
                {thread.draft.status !== "pending" ? ` · ${thread.draft.status}` : ""}
              </p>
            )}
          </>
        ) : (
          /* Not an error and not an empty result. Every verdict is drafted now,
             so the remaining cases are a ticket nothing has investigated yet and
             level 4, where the agent stays silent on purpose. Saying so beats a
             blank box that reads as a load that went wrong. */
          <p className={styles.placeholder}>
            No draft — this ticket has no case file yet, or it is level 4, where the
            agent stays silent on purpose. What it established is in the expanded row.
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
              <MessageBlock key={message.id} message={message} parcels={thread.parcels} />
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
function MessageBlock({
  message,
  parcels,
}: {
  message: TicketMessage;
  parcels: TicketTracking[];
}) {
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
        <pre className={styles.messageBody}>
          <TrackingText text={message.body} parcels={parcels} />
        </pre>
      ) : (
        <p className={styles.placeholder}>No body stored for this message.</p>
      )}
    </li>
  );
}
