// Shopify's RFM segment -> a label a person can read.
//
// SHOPIFY'S SEGMENTS, SHOWN AS SHOPIFY'S. These are Shopify's recency /
// frequency / monetary groups, displayed on the Customers panel and beside a
// ticket's customer as context. They DO NOT decide who is a VIP any more: that
// is the shop's own rule, in vip-rule.mjs, because CHAMPIONS + LOYAL turned out
// not to match who the business treats as one.
//
// NOT AN EXHAUSTIVE ENUM. Shopify owns this vocabulary and can add to it, so an
// unrecognised group is labelled from its own raw text rather than rendering as
// blank.

/**
 * Human labels for the groups seen on real data. Partial on purpose —
 * `formatRfmGroup` title-cases anything else.
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
