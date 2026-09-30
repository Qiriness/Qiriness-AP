import type { Translate } from "@/lib/i18n/translate";
import type { TicketDraft, TicketDraftOutbound, TicketManualReply, TicketThread } from "@/lib/types";

/**
 * What approving a draft does, in the words both review surfaces use — the
 * tickets panel and the thread dialog. One module so the two cannot disagree
 * about whether a click sends.
 *
 * APPROVING NEVER MEANS "SENT". It queues an outbound action; the worker checks
 * the case again and may refuse, and with OUTBOUND_STOP_BEFORE_SEND it stops at
 * a reply draft in Outlook. Only `sent_confirmed` is a sent reply.
 *
 * Wording lives in the dictionary (`tickets.panels.outbound.*`); this module
 * picks the key.
 */

/** Why the worker did not send. Keys: CANCEL_REASONS; unknown reasons print raw. */
const KNOWN_NOT_SENT_REASONS = ["case_moved", "customer_wrote_again", "already_answered", "draft_withdrawn", "auto_send_off"];

/** How far sending got, or null when nothing was asked. */
export function outboundLine(outbound: TicketDraftOutbound | null, t: Translate): string | null {
  if (!outbound) return null;
  switch (outbound.state) {
    case "approved":
      return t("tickets.panels.outbound.approved");
    case "draft_created":
      return t("tickets.panels.outbound.draftCreated");
    case "send_requested":
      return t("tickets.panels.outbound.sendRequested");
    case "sent_confirmed":
      return t("tickets.panels.outbound.sent");
    case "cancelled": {
      const reason = outbound.reason ?? "";
      const words = KNOWN_NOT_SENT_REASONS.includes(reason)
        ? t(`tickets.panels.outbound.reason.${reason}`)
        : reason || t("tickets.panels.outbound.reason.default");
      return t("tickets.panels.outbound.cancelled", { reason: words });
    }
    case "failed":
      return t("tickets.panels.outbound.failed", { reason: outbound.reason ?? t("tickets.panels.outbound.unknown") });
    default:
      return null;
  }
}

/** Once the send call may have been made there is nothing left to decide. */
export function replyInFlight(draft: TicketDraft): boolean {
  return (
    draft.status === "sent" ||
    draft.outbound?.state === "send_requested" ||
    draft.outbound?.state === "sent_confirmed"
  );
}

/**
 * Approved and queued, but the worker has not reached it yet: the reply is
 * shown greyed, with no buttons, until it lands in the mailbox. Only while
 * sending is on — with it off an approval never goes anywhere by itself.
 */
export function awaitingDelivery(draft: TicketDraft): boolean {
  return (draft.status === "approved" || draft.status === "edited") && draft.outbound?.state === "approved";
}

/**
 * The approved reply has reached the mailbox — in Drafts (held), being sent,
 * or sent. From here it is Outlook's, so the page stops showing it as a draft
 * and offers to write a new reply instead.
 */
export function replyDelivered(draft: TicketDraft): boolean {
  return (
    draft.status === "sent" ||
    draft.outbound?.state === "draft_created" ||
    draft.outbound?.state === "send_requested" ||
    draft.outbound?.state === "sent_confirmed"
  );
}

/** The one line left in place of a delivered draft. */
export function deliveredLine(draft: TicketDraft, t: Translate): string {
  if (draft.status === "sent" || draft.outbound?.state === "sent_confirmed") return t("tickets.panels.delivered.sent");
  if (draft.outbound?.state === "send_requested") return t("tickets.panels.delivered.sending");
  return t("tickets.panels.delivered.draftCreated");
}

/**
 * Whether the page may offer « Create draft »: there is no agent draft still
 * waiting on a decision or on the worker.
 */
export function canComposeReply(draft: TicketDraft | null): boolean {
  if (!draft) return true;
  if (draft.status === "rejected" || draft.status === "stale") return true;
  return replyDelivered(draft);
}

/**
 * Whether the page is waiting on the worker for something on this thread — an
 * approved draft not yet in the mailbox, or a reply between queued and sent —
 * so it should look again shortly rather than stay grey until reloaded.
 */
export function awaitingWorker(thread: TicketThread | null): boolean {
  if (!thread) return false;
  if (thread.draft && (awaitingDelivery(thread.draft) || thread.draft.outbound?.state === "send_requested")) return true;
  const newest = thread.reply?.manual?.[0];
  return newest?.state === "approved" || newest?.state === "send_requested";
}

/** How far a person's own reply got, in their words. */
export function manualReplyLine(reply: TicketManualReply, t: Translate): string {
  switch (reply.state) {
    case "approved":
      return t("tickets.panels.compose.queued");
    case "draft_created":
      return t("tickets.panels.compose.inDrafts");
    case "send_requested":
      return t("tickets.panels.compose.sending");
    case "sent_confirmed":
      return t("tickets.panels.compose.sent");
    case "cancelled": {
      const reason = reply.reason ?? "";
      const words = KNOWN_NOT_SENT_REASONS.includes(reason)
        ? t(`tickets.panels.outbound.reason.${reason}`)
        : reason || t("tickets.panels.outbound.reason.default");
      return t("tickets.panels.compose.notSent", { reason: words });
    }
    default:
      return t("tickets.panels.compose.failed", { reason: reply.reason ?? t("tickets.panels.outbound.unknown") });
  }
}

/** The primary button's label: it says what the click does on this server. */
export function decisionLabel(draft: TicketDraft, kind: "approve" | "save", t: Translate): string {
  if (!draft.sendsOnApprove) return t(kind === "approve" ? "tickets.panels.decision.approve" : "tickets.panels.decision.saveEdit");
  if (draft.holdsInDrafts) return t(kind === "approve" ? "tickets.panels.decision.approveDraft" : "tickets.panels.decision.saveDraft");
  return t(kind === "approve" ? "tickets.panels.decision.approveSend" : "tickets.panels.decision.saveSend");
}

/**
 * The line shown once a reviewer has approved (or saved an edit) and moved on
 * to the next ticket. Worded from the draft the server returned, so it says
 * "queued" rather than "sent" — the worker has not run yet.
 */
export function handedOffNotice(draft: TicketDraft, name: string, t: Translate): string {
  if (draft.outbound?.state === "cancelled" || draft.outbound?.state === "failed") {
    return t("tickets.panels.handoff.refused", { name, line: outboundLine(draft.outbound, t) ?? "" });
  }
  if (!draft.sendsOnApprove) return t("tickets.panels.handoff.approvedOff", { name });
  if (draft.holdsInDrafts) return t("tickets.panels.handoff.queuedDrafts", { name });
  return t("tickets.panels.handoff.queuedSend", { name });
}
