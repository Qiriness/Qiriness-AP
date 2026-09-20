/**
 * Why a photo is not on screen, in words an operator can act on.
 *
 * ONE SENTENCE PER REASON, WHICH IS THE WHOLE POINT. The route already
 * distinguishes six failures and puts the answer in `X-Attachment-Reason`; until
 * this existed both panels rendered « the message may have left the mailbox »
 * for every one of them. That sentence is a guess, and on 2026-09-20 it was the
 * wrong guess for three days: a Vercel deploy with no `MS_GRAPH_*` variables
 * reported lost mail, and the photos were in the mailbox the whole time.
 *
 * THE DISTINCTION THAT MATTERS is "gone for good" against "somebody can fix
 * this". `message_gone` ends in Outlook; `graph_not_configured` ends in the
 * deployment's environment variables, and telling an operator to look in Outlook
 * for it wastes their afternoon and leaves the real fault running.
 *
 * An `<img>` cannot read a response header, so the caller re-requests the failed
 * URL to learn the reason — once, only on the failure path. An unknown or
 * unreachable reason falls back to the neutral sentence rather than inventing
 * one, because the old bug was a confident sentence about the wrong cause.
 */
export const ATTACHMENT_REASONS: Record<string, string> = {
  message_gone: "Not available — the message has left the mailbox. Nothing to open in Outlook.",
  graph_not_configured:
    "Not available — this deployment has no mailbox credentials. The photo is fine; the server cannot reach it.",
  mailbox_mismatch:
    "Not available — the server is pointed at a different mailbox from the one this mail was ingested from.",
  graph_unavailable: "Not available — the mailbox did not answer. Worth retrying.",
  too_large: "Too large to show here. Open it in Outlook.",
  not_found: "Not available — this attachment is no longer listed on the message.",
};

export const ATTACHMENT_REASON_FALLBACK =
  "Not available — the message may have left the mailbox. Open it in Outlook.";

/**
 * Ask the route why, by re-requesting the URL that just failed.
 *
 * `HEAD` rather than `GET`: the failure path needs the header and none of the
 * bytes, and on the success-that-then-failed case (a truncated image) a second
 * full download would be paid for nothing.
 */
export async function fetchAttachmentReason(src: string): Promise<string> {
  try {
    const response = await fetch(src, { method: "HEAD", cache: "no-store" });
    const reason = response.headers.get("X-Attachment-Reason");
    return (reason && ATTACHMENT_REASONS[reason]) || ATTACHMENT_REASON_FALLBACK;
  } catch {
    return ATTACHMENT_REASON_FALLBACK;
  }
}
