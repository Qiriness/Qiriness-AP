import type { TicketDraft, TicketDraftOutbound } from "@/lib/types";

/**
 * What approving a draft does, in the words both review surfaces use — the
 * tickets panel and the thread dialog. One module so the two cannot disagree
 * about whether a click sends.
 *
 * APPROVING NEVER MEANS "SENT". It queues an outbound action; the worker checks
 * the case again and may refuse, and with OUTBOUND_STOP_BEFORE_SEND it stops at
 * a reply draft in Outlook. Only `sent_confirmed` is a sent reply.
 */

/** Why the worker did not send, in the reviewer's words. Keys: CANCEL_REASONS. */
const NOT_SENT_REASONS: Record<string, string> = {
  case_moved: "the case changed after this was approved",
  customer_wrote_again: "the customer wrote again",
  already_answered: "somebody already replied",
  draft_withdrawn: "the approval was withdrawn",
  auto_send_off: "automatic sending is off",
};

/** How far sending got, or null when nothing was asked. */
export function outboundLine(outbound: TicketDraftOutbound | null): string | null {
  if (!outbound) return null;
  switch (outbound.state) {
    case "approved":
      return "Queued. The case is checked again before anything is created in the mailbox.";
    case "draft_created":
      return "Reply draft created in the support mailbox (Drafts). Not sent yet.";
    case "send_requested":
      return "Sending — waiting for it to appear in Sent Items.";
    case "sent_confirmed":
      return "Sent.";
    case "cancelled":
      return `Not sent — ${NOT_SENT_REASONS[outbound.reason ?? ""] ?? outbound.reason ?? "a check refused it"}.`;
    case "failed":
      return `Sending failed (${outbound.reason ?? "unknown"}). Check Outlook before sending again.`;
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
export function decisionLabel(draft: TicketDraft, kind: "approve" | "save"): string {
  const verb = kind === "approve" ? "Approve" : "Save";
  if (!draft.sendsOnApprove) return kind === "approve" ? "Approve" : "Save edit";
  return draft.holdsInDrafts ? `${verb} & draft in Outlook` : `${verb} & send`;
}

/**
 * The line shown once a reviewer has approved (or saved an edit) and moved on
 * to the next ticket. Worded from the draft the server returned, so it says
 * "queued" rather than "sent" — the worker has not run yet.
 */
export function handedOffNotice(draft: TicketDraft, name: string): string {
  if (draft.outbound?.state === "cancelled" || draft.outbound?.state === "failed") {
    return `Reply to ${name}: ${outboundLine(draft.outbound)}`;
  }
  if (!draft.sendsOnApprove) {
    return `Reply to ${name} approved. Sending from here is off, so send it from Outlook.`;
  }
  if (draft.holdsInDrafts) {
    return `Reply to ${name} queued. It will appear in the support mailbox's Drafts folder, ready to send from Outlook.`;
  }
  return `Reply to ${name} queued for sending. The case is checked once more before it goes.`;
}
