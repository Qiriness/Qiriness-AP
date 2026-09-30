import type { Translate } from "@/lib/i18n/translate";
import type { TicketDraft, TicketDraftOutbound } from "@/lib/types";

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
