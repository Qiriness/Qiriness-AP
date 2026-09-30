import {
  isSafeReplyHref as isSafeReplyHrefRaw,
  replyHtmlIsEmpty as replyHtmlIsEmptyRaw,
  sanitiseReplyHtml as sanitiseReplyHtmlRaw,
  textToReplyHtml as textToReplyHtmlRaw,
} from "../../scripts/lib/reply-html.mjs";

import type { ReplyLink } from "./reply-links";

/**
 * The one crossing point between the browser and the shared reply-HTML rules,
 * for the reason `tracking-links.ts` gives: the editor, the save path and the
 * outbound worker must cut a reply by one rule, or what a reviewer sees in the
 * editor could differ from what the customer is sent.
 */
export function sanitiseReplyHtml(html: string): string {
  return sanitiseReplyHtmlRaw(html) as string;
}

/** A draft's plain text as editor HTML, its `[[marker]]` turned into the link. */
export function textToReplyHtml(text: string, link: ReplyLink | null | undefined): string {
  return textToReplyHtmlRaw(text, link ?? null) as string;
}

export function replyHtmlIsEmpty(html: string): boolean {
  return replyHtmlIsEmptyRaw(html) as boolean;
}

/** https, or mailto for an address: the only links a reply may carry. */
export function isSafeReplyHref(value: string): boolean {
  return isSafeReplyHrefRaw(value) as boolean;
}
