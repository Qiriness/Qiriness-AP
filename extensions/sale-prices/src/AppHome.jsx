import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { fetchAccessScopes } from '../../../scripts/lib/sale-prices/shopify-sale-reads.mjs';
import ActiveSales from './ActiveSales.jsx';
import NewSale from './NewSale.jsx';
import { graphql } from './shopify-graphql.js';

/**
 * The app's home page in Shopify Admin (Apps > Qiriness Email Agent):
 * « Prix soldés ». Puts a collection on sale by changing the real price and
 * compare-at (so Google Ads sees it), and restores the original prices.
 *
 * Same rules, reads and writes as `npm run sale:*` (scripts/lib/sale-prices/);
 * why it works this way: docs/decisions/sale-prices.md.
 */
export default async () => {
  render(<App />, document.body);
};

function App() {
  const [access, setAccess] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetchAccessScopes(graphql)
      .then(setAccess)
      .catch(() => setAccess({ scopes: [], shopDomain: null }));
  }, []);

  const canWrite = Boolean(access?.scopes.includes('write_products'));
  const refresh = () => setRefreshKey((key) => key + 1);

  return (
    <s-page heading="Prix soldés">
      {access && !canWrite && (
        <s-banner tone="warning" heading="Modification des prix pas encore autorisée">
          L'application peut afficher les promotions mais pas encore changer les prix : il lui manque l'autorisation
          « write_products ». Une fois l'application mise à jour, le propriétaire de la boutique doit accepter la
          nouvelle autorisation dans Shopify.
        </s-banner>
      )}
      <ActiveSales canWrite={canWrite} refreshKey={refreshKey} onRestored={refresh} />
      <NewSale canWrite={canWrite} onApplied={refresh} />
    </s-page>
  );
}
