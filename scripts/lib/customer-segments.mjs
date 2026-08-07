// Shopify's RFM segment -> what support needs to know about it.
//
// One definition of "VIP", shared. It lives here rather than in the dashboard
// because it is a business rule about a customer, not a rendering decision: the
// drafting agent will eventually want the same answer for tone, and two places
// deciding who counts as a VIP would disagree the first time the rule moved.
// Same reasoning as support-taxonomy.mjs, which is why this sits beside it.
//
// DERIVED AT READ TIME, NEVER STORED ON A TICKET. `rfm_group` is recomputed by
// Shopify as a customer buys, so a VIP flag copied onto a ticket would be a
// snapshot of what was true the day the mail arrived — a customer who became a
// champion last week would still read as ordinary on their open thread. The join
// is cheap (one PostgREST embed on an indexed FK); the staleness is not.
//
// NOT AN EXHAUSTIVE ENUM. Shopify owns this vocabulary and can add to it, so
// nothing here assumes it has seen every value: an unrecognised group is simply
// not VIP and is labelled from its own raw text. Inventing a closed list would
// mean a new Shopify segment silently rendering as blank.

/**
 * The groups that count as VIP.
 *
 * THE BUSINESS RULE, and the one line to edit when it changes. `CHAMPIONS` and
 * `LOYAL` are Shopify's two "best customer" segments — highest recency,
 * frequency and spend. Everything else, including `ACTIVE`, is deliberately out:
 * `ACTIVE` only means "has ordered recently", which on this store is most
 * people who have ordered at all, and a badge most rows carry tells an operator
 * nothing.
 */
export const VIP_RFM_GROUPS = ['CHAMPIONS', 'LOYAL'];

/**
 * Human labels for the groups seen on real data, plus the two VIP ones.
 *
 * Partial on purpose — see the note above. `formatRfmGroup` falls back to
 * title-casing the raw value, so an unlisted segment reads as
 * "Potential Loyalist" rather than disappearing.
 */
export const RFM_GROUP_LABELS = {
  CHAMPIONS: 'Champion',
  LOYAL: 'Loyal',
  ACTIVE: 'Active',
  PROSPECTS: 'Prospect',
  DORMANT: 'Dormant',
  AT_RISK: 'At risk',
  ALMOST_LOST: 'Almost lost',
  LOST: 'Lost'
};

/**
 * Is this customer a VIP?
 *
 * Takes the raw `customers.rfm_group` value. Null, unknown and unrecognised all
 * answer false: absence of evidence is not VIP status, and a customer support
 * has never synced must not be badged as one.
 */
export function isVipRfmGroup(rfmGroup) {
  return VIP_RFM_GROUPS.includes(normaliseRfmGroup(rfmGroup));
}

/** The display label for a group, or null when there is no group at all. */
export function formatRfmGroup(rfmGroup) {
  const key = normaliseRfmGroup(rfmGroup);
  if (!key) {
    return null;
  }
  return RFM_GROUP_LABELS[key] || sentenceCase(key);
}

/** Upper-cased and trimmed, so a lower-case or padded value still matches. */
export function normaliseRfmGroup(rfmGroup) {
  if (typeof rfmGroup !== 'string') {
    return '';
  }
  return rfmGroup.trim().toUpperCase();
}

/** SENTENCE case, matching the curated labels above ("At risk", not "At Risk"). */
function sentenceCase(value) {
  const words = value.split('_').filter(Boolean).join(' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
