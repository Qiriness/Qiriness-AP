import { isReplyLinkUrl as isReplyLinkUrlRaw, splitLinkMarkers } from "../../scripts/lib/reply-link.mjs";

/**
 * The one crossing point between the browser and the shared link-marker rules,
 * for the reason `tracking-links.ts` gives: the drafting check and the screen
 * must read one pattern, or a marker the check accepts could render unlinked.
 */
export interface ReplyLink {
  url: string;
  label: string;
}

export interface ReplyLinkSegment {
  text: string;
  /** Present only on the marked word. */
  url?: string;
}

/** Splits a draft at its `[[word]]` markers, linking them when the link is usable. */
export function splitReplyLink(text: string, link: ReplyLink | null | undefined): ReplyLinkSegment[] {
  return splitLinkMarkers(text, link ?? null) as ReplyLinkSegment[];
}

/** A full https address with a real host — the check the table and the save path make. */
export function isReplyLinkUrl(value: string): boolean {
  return isReplyLinkUrlRaw(value) as boolean;
}
