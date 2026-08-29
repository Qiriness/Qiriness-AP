// The one definition of what a tracking number looks like once it is comparable.
//
// IT LIVES HERE, IN THE SHARED LAYER, BECAUSE BOTH SIDES MUST AGREE. The order
// sync writes `orders.tracking_numbers` through this function and the resolver
// normalises the customer's typing through the same one; two copies that drift
// by a hyphen would produce a lookup that silently never matches — the worst
// failure shape available, because it reads as "we have no record of that
// parcel". `agent/` already imports from `scripts/lib`, never the reverse.
//
// WHAT NEEDS REMOVING, measured on this store's data:
//   - trailing punctuation Shopify hands back: `6A06497617561.` is stored today
//   - the groups carriers print: `6C 2072 3002 488`
//   - hyphens, which some carriers and most customers add
//   - case, since customers type in lower case and Shopify stores upper

/** Uppercase, stripped of spaces, dots and hyphens. Empty string for nothing. */
export function normaliseTrackingNumber(value) {
  return String(value ?? '')
    .replace(/[\s.\-]/g, '')
    .toUpperCase();
}

/**
 * Every distinct tracking number on a mapped `fulfillments` array, normalised.
 *
 * Takes the STORED shape (`tracking_info[].number`), not Shopify's GraphQL
 * shape, so the sync and any backfill over existing rows produce the same array
 * from the same input.
 */
export function trackingNumbersFromFulfillments(fulfillments) {
  const seen = new Set();
  for (const fulfillment of Array.isArray(fulfillments) ? fulfillments : []) {
    for (const tracking of fulfillment?.tracking_info || []) {
      const number = normaliseTrackingNumber(tracking?.number);
      // A fulfillment with no carrier reference yet is normal — the warehouse
      // has picked it and nothing has been scanned. It contributes nothing.
      if (number) {
        seen.add(number);
      }
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------- linkifying

/**
 * Splits text into plain runs and the tracking numbers inside it, so a renderer
 * can turn the second kind into a link to the carrier's own page.
 *
 * IT LIVES BESIDE THE NORMALISER FOR THE SAME REASON THE NORMALISER EXISTS.
 * Four surfaces show a tracking number in running text — the email chain, the
 * dropped-mail dialog, the test chat transcript and the draft — and each one
 * rendering its own idea of what a number looks like is the drift this file was
 * written to prevent. `TicketDetailPanel` already learned the smaller version of
 * this lesson: two copies of one rendering, and the second silently dropped the
 * link.
 *
 * MATCHING IS BY NORMALISED FORM, NOT BY STRING EQUALITY, because the two sides
 * disagree by construction. Shopify stores `6C20723002488`; the carrier prints
 * `6C 2072 3002 488`; the customer pastes whichever they were looking at, often
 * with a hyphen or a trailing full stop. Comparing raw text would link the
 * number in our own dispatch mail and miss the same parcel in the customer's
 * reply — the shape that reads as "we have no record of that parcel". So each
 * known number is matched with the same separators `normaliseTrackingNumber`
 * strips, and nothing else: this function and that one must always agree on
 * that character class.
 *
 * ONLY PARCELS WE HOLD A URL FOR ARE LINKED. A number with no fulfilment URL is
 * left as text, exactly as `TrackingList` leaves it — the alternative is
 * guessing a carrier from the number's shape and building a search URL, which
 * sends a reviewer to a dead page whenever the guess is wrong. Not linking is a
 * visibly missing link; a wrong link is a broken promise.
 *
 * @param text     the running text to split
 * @param parcels  `[{ number, carrier, url }]` — the parcels this ticket holds
 * @returns segments in document order. `{ text }` for a plain run;
 *   `{ text, number, carrier, url }` for a match, where `text` is the customer's
 *   own spelling and `number` the normalised form the URL belongs to.
 */
export function splitTrackingText(text, parcels = []) {
  const source = String(text ?? '');
  const linkable = [];
  const seen = new Set();

  for (const parcel of Array.isArray(parcels) ? parcels : []) {
    const number = normaliseTrackingNumber(parcel?.number);
    const url = String(parcel?.url ?? '').trim();
    // A parcel with no number is a fulfilment the warehouse has not handed to a
    // carrier yet; one with no URL is the ordinary "we have the number and not
    // the link" case. Neither is linkable and neither is an error.
    if (!number || !url || seen.has(number)) {
      continue;
    }
    seen.add(number);
    linkable.push({ number, url, carrier: parcel?.carrier ?? null });
  }

  if (linkable.length === 0 || source.length === 0) {
    return source.length > 0 ? [{ text: source }] : [];
  }

  const matches = [];
  for (const parcel of linkable) {
    const regex = trackingNumberRegex(parcel.number);
    let match;
    while ((match = regex.exec(source)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length, text: match[0], parcel });
    }
  }

  // Longest first at a given start, so a number that is a prefix of another
  // cannot claim the shorter span and orphan the rest of the digits.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) {
      continue;
    }
    if (match.start > cursor) {
      segments.push({ text: source.slice(cursor, match.start) });
    }
    segments.push({
      text: match.text,
      number: match.parcel.number,
      carrier: match.parcel.carrier,
      url: match.parcel.url
    });
    cursor = match.end;
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) });
  }
  return segments;
}

/**
 * A known number, allowing the separators a carrier prints and a customer types.
 *
 * `\b` rather than lookbehind: this runs in the browser as well as in Node, and
 * lookbehind is the one construct old Safari still lacks. It is sufficient here
 * because every tracking number starts and ends with an alphanumeric, so a
 * number glued to a longer token has no boundary and cannot match.
 */
function trackingNumberRegex(normalised) {
  // The same character class `normaliseTrackingNumber` strips, so the two agree
  // by construction. `\s` covers the non-breaking space an HTML mail body leaves
  // behind, which is why it is not a literal space.
  const pattern = normalised.split('').join('[\\s.\\-]*');
  return new RegExp(`\\b${pattern}\\b`, 'gi');
}
