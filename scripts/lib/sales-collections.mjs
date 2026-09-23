/**
 * The product ranges the business reads its sales by — the Collection mix card
 * on Insights → Sales, and the same card in the monthly report.
 *
 * A BUSINESS JUDGEMENT, SO IT LIVES HERE AND NOT IN SQL, exactly as
 * `MARKETPLACE_CHANNELS` does in insights-range.mjs. Shopify holds 176
 * collections on this shop and most are machinery: fourteen `Diag - Soins
 * hebdomadaires "rituels" - N` variants, seasonal landing pages, and the
 * diagnostic sets the advice layer uses. Ranked by revenue those drown the six
 * ranges the owner actually manages the catalogue by, and worse, they overlap
 * each other almost completely.
 *
 * Named by the owner, 2026-09-23. `Rituel Spa` is the parent of the four
 * `Rituel Spa <theme>` collections and carries 24 products against their 5-7,
 * which is why it is the one listed.
 *
 * HANDLES, NOT TITLES. A title is edited in the Shopify admin whenever the
 * marketing copy changes; a handle is the URL and survives it. `title` here is
 * only the fallback label for a collection that has gone missing.
 */
export const SALES_COLLECTIONS = Object.freeze([
  { handle: 'gamme-anti-age-temps-sublime', title: 'Temps Sublime' },
  { handle: 'source-deau', title: 'Source d’Eau' },
  { handle: 'exception-la-ligne-anti-age-regenerante-pour-peaux-exigeantes', title: 'Exception' },
  { handle: 'active-energie-soins-coup-de-boost-pour-un-teint-eclatant-une-peau-revitalisee', title: 'Active Énergie' },
  { handle: 'eclat-parfait', title: 'Eclat Parfait' },
  { handle: 'rituel-spa', title: 'Rituel Spa' }
]);

/** Just the handles, for the SQL filter and the membership sync. */
export const SALES_COLLECTION_HANDLES = Object.freeze(SALES_COLLECTIONS.map((c) => c.handle));

/** True for a collection the sales cards read, whatever the advice layer thinks of it. */
export function isSalesCollection(handle) {
  return SALES_COLLECTION_HANDLES.includes(String(handle ?? ''));
}
