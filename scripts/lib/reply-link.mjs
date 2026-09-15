// A link a rule offers the customer, and the marker a draft carries it by.
//
// THE MODEL NEVER SEES THE URL. It is told what the link opens and writes a
// marker — « cliquez [[ici]] pour consulter le guide d'utilisation » — and code
// puts the address on the marked word wherever the draft is shown. That keeps
// what `no_web_link` enforces intact: a URL typed by the model is still one it
// invented, because it was never handed one to copy (DECISIONS, « The reply
// names the parcel; the number is the link »).
//
// ONE MODULE FOR BOTH SIDES. The drafting check that proves the marker was
// placed and the dashboard that renders it read the same pattern, so a marker
// the check accepts is always one the screen can link.

/** The longest description a link may carry — a phrase, not a paragraph. */
export const MAX_LINK_LABEL = 120;

// The word between the brackets is short and single-line: « ici », « here »,
// « qui ». Anything longer is the model writing prose inside a marker.
const MARKER_SOURCE = String.raw`\[\[([^\[\]\n]{1,40})\]\]`;

/**
 * An https address a customer can click: parseable, no whitespace, a real host.
 * `http:`, `javascript:` and a half-pasted line are all refused.
 */
export function isReplyLinkUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) {
    return false;
  }
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** `{ url, label }` when both halves are usable, otherwise null. */
export function normaliseReplyLink(raw) {
  const url = String(raw?.url ?? '').trim();
  const label = String(raw?.label ?? '').trim();
  if (!isReplyLinkUrl(url) || !label || label.length > MAX_LINK_LABEL) {
    return null;
  }
  return { url, label };
}

/** Every `[[word]]` marker in a text, in order. */
export function findLinkMarkers(text) {
  return [...String(text ?? '').matchAll(new RegExp(MARKER_SOURCE, 'g'))].map((match) => ({
    index: match.index,
    length: match[0].length,
    anchor: match[1]
  }));
}

/**
 * The text cut into plain runs and linked words.
 *
 * WITH NO USABLE LINK THE TEXT COMES BACK WHOLE, markers included. A marker
 * nothing can link is a draft fault — `no_orphan_link_marker` fails it — and
 * rendering it as written is what lets a reviewer see it.
 */
export function splitLinkMarkers(text, link) {
  const source = String(text ?? '');
  const usable = normaliseReplyLink(link);
  const markers = findLinkMarkers(source);
  if (!usable || markers.length === 0) {
    return [{ text: source }];
  }

  const segments = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.index > cursor) {
      segments.push({ text: source.slice(cursor, marker.index) });
    }
    segments.push({ text: marker.anchor, url: usable.url });
    cursor = marker.index + marker.length;
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) });
  }
  return segments;
}
