"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { decideOnDraft, fetchTicketThread } from "@/lib/api/tickets";
import { useT } from "@/lib/i18n/client";
import type { Translate } from "@/lib/i18n/translate";
import { formatRelativeTime } from "@/lib/relative-time";
import { TrackingText } from "@/components/ui/TrackingText";
import { awaitingDelivery, decisionLabel, deliveredLine, outboundLine, replyDelivered, replyInFlight } from "@/lib/draft-outbound";
import { replyHtmlIsEmpty, textToReplyHtml } from "@/lib/reply-html";
import { ReplyEditor, ReplyHtmlView } from "./ReplyEditor";
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
 * Sending happens here only when OUTBOUND_SEND_ENABLED is on, and then only by
 * approving: the worker sends, after checking the case again. Otherwise replies
 * are still sent from Outlook — this exists so *reading* a case does not.
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

const DRAFT_HEADING_KEYS = ["answerable", "needs_customer_input", "needs_human"];

export function TicketThreadDialog({ ticket, onClose }: TicketThreadDialogProps) {
  const t = useT();
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
        approvedBody: null,
        // The editor's HTML; the server sanitises it and derives the text.
        approvedBodyHtml: status === "edited" ? edited : null,
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
      title={subject?.trim() || t("tickets.view.noSubject")}
      closeLabel={t("tickets.dialogs.thread.close")}
      onClose={onClose}
      meta={
        <>
          {ticket.requesterName?.trim() || t("tickets.view.unknownRequester")}
          {ticket.orderNumber ? ` · ${t("tickets.panels.orderNumber", { number: ticket.orderNumber })}` : ""}
          {thread ? ` · ${t("tickets.dialogs.thread.messages", { count: thread.messages.length })}` : ""}
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
            {t("tickets.dialogs.thread.duplicate")}
            {thread.duplicateOf.reason === "identical_body"
              ? t("tickets.dialogs.thread.duplicateSame")
              : t("tickets.dialogs.thread.duplicateThread")}
            {t("tickets.dialogs.thread.duplicateEnd")}
          </p>
        )}
        {/* Below the duplicate banner and visually calmer than it, because the
            two say opposite things: that one means do not act, this one means
            read the earlier thread first. Never suppresses the draft. */}
        {thread?.relatedTo && !thread?.duplicateOf && (
          <p className={styles.related}>
            {t("tickets.dialogs.thread.related")}
          </p>
        )}
        <h3 className={styles.heading}>{t(`tickets.dialogs.thread.heading.${DRAFT_HEADING_KEYS.includes(thread?.draft?.sourceVerdict ?? "") ? thread?.draft?.sourceVerdict : "answerable"}`)}</h3>
        {thread?.draft && replyDelivered(thread.draft) ? (
          // In the mailbox now (Drafts, or sent): Outlook's, no longer a draft here.
          <p className={styles.stamp} role="status">{deliveredLine(thread.draft, t)}</p>
        ) : thread?.draft ? (
          <div className={awaitingDelivery(thread.draft) ? styles.awaiting : styles.live} aria-busy={awaitingDelivery(thread.draft) || undefined}>
            {/* The failed checks go ABOVE the text. A reviewer who reads a
                fluent draft first has already decided it is fine by the time a
                warning underneath it arrives. */}
            {!thread.draft.checksPassed && (
              <p className={styles.blocked} role="alert">
                {t("tickets.panels.draft.notSendable", { count: thread.draft.failedChecks.length })}{" "}
                {thread.draft.failedChecks.join("; ") || t("tickets.panels.draft.seeRecord")}.
              </p>
            )}
            {/* THE MODEL'S TEXT IS NEVER EDITED IN PLACE. Opening the editor
                copies it in as formatted text (its [[marker]] as the real
                link); saving writes the rewrite to separate columns and appends
                the pair to the edit log, so what the agent wrote stays readable
                beside what a person sent. */}
            {editing ? (
              <ReplyEditor
                key={thread.draft.id}
                initialHtml={edited}
                onChange={setEdited}
                label={t("tickets.panels.draft.editLabel")}
              />
            ) : (
              <pre className={styles.draft}>
                <TrackingText text={thread.draft.body} parcels={thread.parcels} link={thread.draft.replyLink} />
              </pre>
            )}
            {/* The model's text stays above; a reviewer's rewrite is shown as a
                second block rather than replacing it, because the difference
                between them is what says whether the drafting is any good. */}
            {thread.draft.approvedBody && (
              <>
                <h3 className={styles.heading}>{t("tickets.panels.draft.reviewerVersion")}</h3>
                {thread.draft.approvedBodyHtml ? (
                  <ReplyHtmlView html={thread.draft.approvedBodyHtml} />
                ) : (
                  <pre className={styles.draft}>
                    <TrackingText
                      text={thread.draft.approvedBody}
                      parcels={thread.parcels}
                      link={thread.draft.replyLink}
                    />
                  </pre>
                )}
              </>
            )}
            {/* What happens when this is sent, said in the review surface rather
                than left to the send path. An operator approving a draft is
                approving its consequence too: a terminal reply finishes the
                thread, an intermediary one hands it to whoever is waited on. */}
            <p className={styles.stamp}>
              {thread.draft.disposition === "terminal"
                ? t("tickets.panels.draft.terminal")
                : thread.draft.sourceVerdict === "needs_customer_input"
                  ? t("tickets.panels.draft.intermediaryCustomer")
                  : t("tickets.panels.draft.intermediaryColleague")}
            </p>
            {outboundLine(thread.draft.outbound, t) && (
              <p className={styles.stamp} role="status">
                {outboundLine(thread.draft.outbound, t)}
              </p>
            )}
            {/* The three decisions a person can reach by reading. With sending
                on, approving (or saving an edit) also sends — the buttons say
                so. Once a reply may be out, there is nothing left to decide. */}
            {!replyInFlight(thread.draft) && !awaitingDelivery(thread.draft) && (
            <div className={styles.actions}>
              {editing ? (
                <>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={saving !== null || replyHtmlIsEmpty(edited)}
                    onClick={() => decide("edited")}
                  >
                    {saving === "edited" ? t("tickets.panels.saving") : decisionLabel(thread.draft, "save", t)}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={saving !== null}
                    onClick={() => setEditing(false)}
                  >
                    {t("tickets.panels.draft.cancel")}
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
                      const current = thread.draft;
                      setEdited(
                        current?.approvedBodyHtml ??
                          textToReplyHtml(current?.approvedBody ?? current?.body ?? "", current?.replyLink)
                      );
                      setEditing(true);
                    }}
                  >
                    {t("tickets.panels.draft.edit")}
                  </button>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={saving !== null}
                    onClick={() => decide("approved")}
                  >
                    {saving === "approved" ? t("tickets.panels.saving") : decisionLabel(thread.draft, "approve", t)}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={saving !== null}
                    onClick={() => decide("rejected")}
                  >
                    {saving === "rejected" ? t("tickets.panels.saving") : t("tickets.panels.draft.reject")}
                  </button>
                </>
              )}
            </div>
            )}

            {decideError && (
              <p className={styles.error} role="alert">
                {decideError}
              </p>
            )}

            {thread.draft.draftedAt && (
              <p className={styles.stamp}>
                {t("tickets.panels.draft.drafted")}{" "}
                <time dateTime={thread.draft.draftedAt}>
                  {formatRelativeTime(thread.draft.draftedAt, t)}
                </time>
                {thread.draft.status !== "pending" ? ` · ${t(`tickets.panels.draft.status.${thread.draft.status}`)}` : ""}
              </p>
            )}
          </div>
        ) : (
          /* Not an error and not an empty result. Every verdict is drafted now,
             so the remaining cases are a ticket nothing has investigated yet and
             level 4, where the agent stays silent on purpose. Saying so beats a
             blank box that reads as a load that went wrong. */
          <p className={styles.placeholder}>
            {t("tickets.dialogs.thread.noDraft")}
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>{t("tickets.panels.conversation")}</h3>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : !thread ? (
          <p className={styles.placeholder}>{t("tickets.dialogs.thread.loading")}</p>
        ) : thread.messages.length === 0 ? (
          <p className={styles.placeholder}>{t("tickets.panels.thread.emptyTitle")}.</p>
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
function senderIdentity(message: TicketMessage, outbound: boolean, t: Translate): {
  name: string;
  email: string | null;
} {
  const name = message.fromName?.trim() ?? "";
  const email = message.fromEmail?.trim() ?? "";

  // Nothing at all: the direction is the only thing left to say who this was.
  if (!name && !email) return { name: outbound ? "Qiriness" : t("tickets.panels.unknownSender"), email: null };
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
  const t = useT();
  const outbound = message.direction === "outbound";
  const sender = senderIdentity(message, outbound, t);

  return (
    <li className={`${styles.message} ${outbound ? styles.outbound : styles.inbound}`}>
      <div className={styles.messageHead}>
        <span className={styles.sender}>{sender.name}</span>
        {sender.email && <span className={styles.senderEmail}>{sender.email}</span>}
        <span className={styles.direction}>{outbound ? t("tickets.dialogs.thread.sent") : t("tickets.dialogs.thread.received")}</span>
        {message.at && (
          <time className={styles.when} dateTime={message.at}>
            {formatRelativeTime(message.at, t)}
          </time>
        )}
        {message.hasAttachments && <span className={styles.attachment}>{t("tickets.dialogs.thread.hasAttachments")}</span>}
      </div>
      {/* `pre` rather than `p`: `body_text` is plain text whose paragraph breaks
          and quoted-reply indentation are the only structure it has left after
          htmlToText, and collapsing them turns a thread into one block. */}
      {message.body?.trim() ? (
        <pre className={styles.messageBody}>
          <TrackingText text={message.body} parcels={parcels} />
        </pre>
      ) : (
        <p className={styles.placeholder}>{t("tickets.panels.message.noBody")}</p>
      )}
    </li>
  );
}
