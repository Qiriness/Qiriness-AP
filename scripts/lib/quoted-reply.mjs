// Removes quoted reply history from an email body, leaving only what this sender
// actually wrote.
//
// Why it matters, in both directions:
//
//   EMBEDDING. Re-embedding a quoted original means the reply's vector is
//   dominated by text already embedded on the earlier message. A follow-up
//   reading "merci, et le remboursement ?" would produce a vector nearly
//   identical to the question it quotes, so the two become indistinguishable in
//   the corpus and a similar-question search returns the same conversation twice.
//   Measured on a real mailbox, quoted messages average ~1045 tokens against ~210
//   for clean mail.
//
//   CLASSIFICATION. The categoriser reads the thread's first and latest message.
//   Without stripping, a reply's "latest message" is largely the original text
//   quoted underneath it — so the model re-reads the opening enquiry and scores
//   the customer's current mood from prose they wrote days ago.
//
// Approach: find the EARLIEST point at which any quote marker appears and cut
// from there. Everything below the first marker is history by construction.
//
// Deliberately conservative. It never returns empty: if a message is entirely
// quoted (a bare forward), the original is kept, because a blank body is worse
// for both embedding and classification than a noisy one.

/**
 * Bumped whenever the stripping behaviour changes. It is mixed into the
 * embedding hash (never into the embedded text), so a change here correctly
 * invalidates stored vectors and the reconciler re-embeds.
 */
export const STRIPPER_VERSION = 'quoted-reply/1';

// French mail routinely uses a non-breaking space before a colon.
const SP = '[ \\t\\u00a0]';

const MARKERS = [
  // -----Message d'origine----- / -----Original Message----- / Message transféré
  new RegExp(
    `^${SP}*-{2,}${SP}*(?:Message d['’]origine|Original Message|Message transf[ée]r[ée]|Forwarded message)${SP}*-{2,}`,
    'im'
  ),
  // Outlook's horizontal rule above a quoted header block.
  new RegExp(`^${SP}*_{10,}${SP}*$`, 'm'),
  // Gmail/Apple: "Le 12 juillet 2026 à 14:32, Jean <j@x.fr> a écrit :"
  new RegExp(`^${SP}*Le${SP}[\\s\\S]{0,200}?a${SP}+[ée]crit${SP}*:`, 'im'),
  // English equivalent: "On Mon, Jul 12, 2026 at 2:32 PM Jean wrote:"
  new RegExp(`^${SP}*On${SP}[\\s\\S]{0,200}?${SP}wrote${SP}*:`, 'im'),
  // Outlook header block — "De : ..." immediately followed by "Envoyé :"/"Date :".
  // Both lines are required so a plain "De :" inside prose is not a boundary.
  new RegExp(`^${SP}*De${SP}*:.*\\r?\\n${SP}*(?:Envoy[ée]|Date|Sent)${SP}*:`, 'im'),
  new RegExp(`^${SP}*From${SP}*:.*\\r?\\n${SP}*(?:Sent|Date|Envoy[ée])${SP}*:`, 'im'),
  // A quoted line. Last, so a richer header marker wins when both are present.
  /^[ \t ]*>/m
];

/**
 * @param {string|null|undefined} body cleaned plain-text email body
 * @returns {string|null} the body with quoted history removed, or the input
 *   unchanged when no marker is found or stripping would empty it
 */
export function stripQuotedReply(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return body ?? null;
  }

  const boundary = findQuoteBoundary(body);
  if (boundary === null) {
    return body;
  }

  const kept = body.slice(0, boundary).trimEnd();
  // A wholly quoted message (a bare forward, or a reply whose marker is on line
  // one) leaves nothing behind. Keep the original rather than store a blank.
  return kept.length > 0 ? kept : body;
}

/** Index of the first quote marker, or null when the body carries none. */
export function findQuoteBoundary(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }

  let earliest = null;
  for (const marker of MARKERS) {
    const match = marker.exec(body);
    if (match && (earliest === null || match.index < earliest)) {
      earliest = match.index;
    }
  }
  return earliest;
}

/** True when the body carries quoted history at all. Useful for logging. */
export function hasQuotedReply(body) {
  return findQuoteBoundary(body) !== null;
}
