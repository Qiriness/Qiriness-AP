import { splitTrackingText } from "../../scripts/lib/tracking-number.mjs";

import type { TicketTracking } from "./types";

/**
 * The one crossing point between the browser and the shared tracking rules.
 *
 * WHY IMPORT THE .mjs RATHER THAN RESTATE IT IN TYPESCRIPT. `scripts/lib/
 * tracking-number.mjs` already owns what a tracking number looks like once it is
 * comparable, and the sync writes `orders.tracking_numbers` through the same
 * file. A TypeScript reimplementation for the client would be a second copy of a
 * normalisation rule whose whole documented purpose is that there is only one —
 * and the failure mode of drift is a number that silently never matches, which
 * reads to an operator as "we have no record of that parcel".
 *
 * ONE FILE CROSSES, so if bundling `.mjs` from outside `web/` ever becomes a
 * problem, this is the only place that has to change.
 */
export interface TrackingSegment {
  /** The text as it was written, which is what gets rendered either way. */
  text: string;
  /** Present only on a linked span: the normalised number the URL belongs to. */
  number?: string;
  carrier?: string | null;
  url?: string;
}

/**
 * Splits running text into plain runs and linkable tracking numbers.
 *
 * A number is linked only where `parcels` holds a real fulfilment URL for it.
 * Everything else — including a tracking-number-shaped string we hold no parcel
 * for — comes back as plain text.
 */
export function splitTracking(text: string, parcels: TicketTracking[]): TrackingSegment[] {
  return splitTrackingText(text, parcels) as TrackingSegment[];
}

/** True when there is anything to link, so a caller can skip the work entirely. */
export function hasLinkableParcels(parcels: TicketTracking[] | undefined | null): boolean {
  return Boolean(parcels?.some((parcel) => parcel?.number && parcel?.url));
}
