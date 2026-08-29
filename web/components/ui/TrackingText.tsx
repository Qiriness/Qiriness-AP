import type { TicketTracking } from "@/lib/types";
import { hasLinkableParcels, splitTracking } from "@/lib/tracking-links";
import styles from "./TrackingText.module.css";

/**
 * Running text with its tracking numbers turned into links to the carrier.
 *
 * ONE COMPONENT FOR EVERY SURFACE THAT SHOWS A NUMBER IN PROSE — the email
 * chain, the dropped-mail dialog, the draft, and the test chat transcript.
 * `TicketDetailPanel` already learned the small version of this lesson and wrote
 * it down: it had two copies of the parcel rendering, the second dropped the
 * link, and a reviewer was left pasting numbers into La Poste by hand. Four
 * copies would be worse, and the surfaces genuinely do differ — three of them
 * render inside a `pre`.
 *
 * IT RENDERS TEXT, NOT HTML. The input is `body_text`, which ingestion already
 * flattened out of HTML, and it stays a string: the segments are spans and
 * anchors built by React, so there is no path from a message body to markup.
 *
 * A NUMBER WITH NO URL IS LEFT ALONE, which is the same rule `TrackingList`
 * follows. The alternative — guessing the carrier from the number's shape and
 * building a search URL — sends a reviewer to a dead page whenever the guess is
 * wrong, and a wrong link is worse than a visibly missing one.
 *
 * `noreferrer` with `target="_blank"`: the carrier is a third party with no
 * business receiving the dashboard URL in a Referer header.
 */
export function TrackingText({
  text,
  parcels,
}: {
  text: string;
  parcels: TicketTracking[] | undefined | null;
}) {
  // The common case by a wide margin: no confirmed order, so nothing to link.
  // Returning the string itself keeps the DOM identical to what it was before
  // this component existed.
  if (!hasLinkableParcels(parcels)) {
    return <>{text}</>;
  }

  const segments = splitTracking(text, parcels ?? []);

  return (
    <>
      {segments.map((segment, index) =>
        segment.url ? (
          <a
            key={index}
            className={styles.link}
            href={segment.url}
            target="_blank"
            rel="noreferrer"
            title={segment.carrier ? `Track with ${segment.carrier}` : "Track this parcel"}
          >
            {segment.text}
          </a>
        ) : (
          // A fragment, not a span: inside a `pre` an extra element would be
          // harmless but an extra newline would not, and this way the text nodes
          // are exactly the ones the string had.
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}
