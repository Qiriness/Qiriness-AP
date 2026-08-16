// Pulls candidate TRACKING numbers out of a customer's email.
//
// Pure: text in, candidates out. No database, no judgement about whether the
// parcel exists — that is the resolver's job. The sibling of
// order-number-parser.mjs, and deliberately the same shape.
//
// WHY THIS EXISTS. A customer who is chasing a parcel very often has the
// tracking number to hand and not the order number: the tracking number is what
// our dispatch email put in front of them, and what the carrier's site asks for.
// Before this, such a ticket resolved to no order at all and every order tool
// was unavailable to it.
//
// WHAT THE STORE ACTUALLY ISSUES, counted over 815 tracking numbers on 2,006
// orders:
//    717  `6C20723002488`   digit, letter, 11 digits   -> Colissimo (84%)
//     97  `ZWLGF5DA`        5 letters, digit, 2 alnum  -> GLS (12%)
//      1  `CJ123456789FR`   2 letters, 9 digits, 2     -> UPU international
// Carriers named on the fulfillments: COLISSIMO 694, GLS 93, "Autre" 8, none 20.
//
// THE GLS PATTERN REQUIRES A DIGIT IN SIXTH POSITION, and that is not cosmetic.
// Without it the pattern is eight letters, which matches ordinary French words
// shouted in a subject line — `COMMANDE` is exactly eight. Every GLS number
// measured has a digit there (`AAAAA9AA`, `AAAAA99A`, `AAAAA9A9`, `AAAAA999`),
// so requiring it costs nothing and stops the parser proposing words.
//
// Being generous is otherwise cheap, exactly as in the order parser: a candidate
// that is not a real tracking number simply does not match a row, and one that
// matches somebody else's parcel is caught by the ownership check and never
// written. A false candidate costs a slot in a batched lookup, not a wrong
// answer.
//
// The normaliser is imported rather than defined here, deliberately: the order
// sync writes `orders.tracking_numbers` through the same function, and a second
// copy drifting by so much as a hyphen would give a lookup that silently never
// matches — which reads as "we have no record of that parcel".

import { normaliseTrackingNumber } from '../../../scripts/lib/tracking-number.mjs';

export { normaliseTrackingNumber };

const PATTERNS = [
  // Colissimo, compact or printed in groups (`6C 2072 3002 488`). The digits may
  // be separated because that is how the carrier prints them and how a customer
  // copies them; the leading digit-then-letter signature is distinctive enough
  // that allowing separators cannot start swallowing prose.
  { carrier: 'colissimo', regex: /\b\d[A-Z](?:[ .]?\d){11}\b/gi },
  // GLS. The digit in sixth position is load-bearing — see above.
  { carrier: 'gls', regex: /\b[A-Z]{5}\d[A-Z0-9]{2}\b/gi },
  // UPU/international (`CJ123456789FR`). One in the corpus, but it is the format
  // every postal operator uses for cross-border parcels, so it will recur.
  { carrier: 'upu', regex: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/gi }
];

/**
 * A match glued to a file extension is a filename, not a parcel.
 *
 * `image001.png` is the one that actually bites: Outlook embeds it in the
 * signature of a large share of business mail, and `IMAGE001` is exactly the
 * GLS shape — five letters, a digit, two more. Measured over 296 inbound
 * messages it was the only false candidate the parser proposed.
 *
 * The extension must follow with no space, so an ordinary sentence ending
 * (`6A06497617561. Pouvez-vous…`) is untouched.
 */
const FILE_EXTENSION_AFTER = /^\.[A-Za-z0-9]{2,4}\b/;

/**
 * Every distinct candidate, in the order first seen.
 *
 * Returns the normalised form as `trackingNumber`, plus the `raw` text it came
 * from, so a caller can quote the customer's own spelling back at them.
 */
export function parseTrackingCandidates(text) {
  const source = String(text || '');
  const seen = new Set();
  const candidates = [];

  for (const { carrier, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      const raw = match[0];
      if (FILE_EXTENSION_AFTER.test(source.slice(match.index + raw.length))) {
        continue;
      }
      const trackingNumber = normaliseTrackingNumber(raw);
      if (seen.has(trackingNumber)) {
        continue;
      }
      seen.add(trackingNumber);
      candidates.push({ raw, carrier, trackingNumber, index: match.index });
    }
  }

  return candidates.sort((a, b) => a.index - b.index).map(({ index, ...rest }) => rest);
}
