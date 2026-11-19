import { useEffect, useState } from 'preact/hooks';

import {
  campaignId,
  flattenVariants,
  parsePercent,
  planApply
} from '../../../scripts/lib/sale-prices/pricing.mjs';
import { fetchCollectionList, fetchSaleCollection } from '../../../scripts/lib/sale-prices/shopify-sale-reads.mjs';
import { runApply } from '../../../scripts/lib/sale-prices/runner.mjs';
import { graphql } from './shopify-graphql.js';
import { SKIP_LABELS, euro, euroFromString, plural } from './labels.js';

/**
 * « Nouvelle promotion »: collection + % -> preview -> confirm -> apply.
 * The collection is read again right before writing, so the prices written are
 * computed from the live prices, not from a preview that may be minutes old.
 */
export default function NewSale({ canWrite, onApplied }) {
  const [collections, setCollections] = useState([]);
  const [handle, setHandle] = useState('');
  const [percent, setPercent] = useState('20');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCollectionList(graphql)
      .then(setCollections)
      .catch((err) => setError(`Impossible de lire les collections : ${err.message}`));
  }, []);

  function resetPlan() {
    setPreview(null);
    setConfirming(false);
    setResult(null);
  }

  async function buildPlan() {
    const pct = parsePercent(percent);
    const found = await fetchSaleCollection(graphql, handle);
    if (!found) throw new Error(`Aucune collection avec l'identifiant « ${handle} ».`);
    const campaign = campaignId({ handle, percent: pct });
    const plan = planApply(flattenVariants(found.products), {
      handle,
      percent: pct,
      campaign,
      includeDrafts,
      appliedAt: new Date().toISOString()
    });
    return { ...plan, collection: found.collection, percent: pct, campaign, productCount: found.products.length };
  }

  async function handlePreview() {
    setError(null);
    resetPlan();
    if (!handle) return setError('Choisissez une collection.');
    setBusy(true);
    try {
      setPreview(await buildPlan());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    setConfirming(false);
    setError(null);
    setBusy(true);
    try {
      const fresh = await buildPlan();
      setPreview(fresh);
      const failures = [];
      setProgress({ done: 0, total: new Set(fresh.changes.map((c) => c.productId)).size });
      const tally = await runApply({
        graphql,
        changes: fresh.changes,
        onProduct: ({ items, ok, error: err, done, total }) => {
          if (!ok) failures.push({ product: items[0].productTitle, error: err });
          setProgress({ done, total });
        }
      });
      setResult({ ...tally, failures, campaign: fresh.campaign });
      shopify.toast.show(
        tally.failed ? `${plural(tally.failed, 'variante')} en échec` : `${plural(tally.applied, 'prix soldé', 'prix soldés')}`,
        { isError: tally.failed > 0 }
      );
      setPreview(null);
      onApplied();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <s-section heading="Nouvelle promotion">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Baisse le vrai prix de chaque produit de la collection et met l'ancien prix en prix barré : la promotion
          apparaît sur le site, au paiement et dans Google Ads. L'ancien prix est gardé sur chaque variante pour la
          restauration.
        </s-paragraph>

        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-select
            label="Collection"
            placeholder="Choisir une collection"
            value={handle}
            disabled={busy}
            onChange={(event) => {
              setHandle(event.currentTarget.value);
              resetPlan();
            }}
          >
            {collections.map((collection) => (
              <s-option key={collection.id} value={collection.handle}>
                {collection.title}
                {collection.productsCount !== null ? ` (${collection.productsCount})` : ''}
              </s-option>
            ))}
          </s-select>
          <s-number-field
            label="Remise"
            suffix="%"
            min={1}
            max={90}
            step={1}
            value={percent}
            disabled={busy}
            onChange={(event) => {
              setPercent(event.currentTarget.value);
              resetPlan();
            }}
          ></s-number-field>
        </s-grid>

        <s-checkbox
          label="Inclure les produits en brouillon ou archivés"
          checked={includeDrafts}
          disabled={busy}
          onChange={(event) => {
            setIncludeDrafts(event.currentTarget.checked);
            resetPlan();
          }}
        ></s-checkbox>

        <s-stack direction="inline" gap="base">
          <s-button onClick={handlePreview} loading={busy && !progress} disabled={busy}>
            Prévisualiser
          </s-button>
        </s-stack>

        {error && <s-banner tone="critical" heading="Erreur">{error}</s-banner>}

        {progress && (
          <s-banner tone="info" heading="Application en cours…">
            {`Produit ${progress.done} sur ${progress.total}. Ne fermez pas cette page.`}
          </s-banner>
        )}

        {result && (
          <s-banner tone={result.failed ? 'warning' : 'success'} heading="Promotion appliquée">
            {`${plural(result.applied, 'variante')} en promotion (${result.campaign}).`}
            {result.failed > 0 &&
              ` ${plural(result.failed, 'variante')} en échec : ${result.failures
                .map((f) => `${f.product} (${f.error})`)
                .join(' ; ')}. Relancez la même promotion : les variantes déjà soldées sont ignorées.`}
          </s-banner>
        )}

        {preview && (
          <PreviewTables preview={preview} canWrite={canWrite} busy={busy} confirming={confirming}
            onAsk={() => setConfirming(true)} onCancel={() => setConfirming(false)} onConfirm={handleApply} />
        )}
      </s-stack>
    </s-section>
  );
}

function PreviewTables({ preview, canWrite, busy, confirming, onAsk, onCancel, onConfirm }) {
  const { changes, skipped, collection, percent, productCount } = preview;
  return (
    <s-stack gap="base">
      <s-heading>{`${collection.title} : -${percent} %`}</s-heading>
      <s-paragraph>
        {`${plural(productCount, 'produit')} · ${plural(changes.length, 'prix', 'prix')} à changer · ${plural(skipped.length, 'variante ignorée', 'variantes ignorées')}`}
      </s-paragraph>

      {changes.length > 0 && (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Produit</s-table-header>
            <s-table-header>Variante</s-table-header>
            <s-table-header format="currency">Prix actuel</s-table-header>
            <s-table-header format="currency">Prix soldé</s-table-header>
            <s-table-header format="currency">Prix barré</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {changes.map((change) => (
              <s-table-row key={change.variantId}>
                <s-table-cell>{change.productTitle}</s-table-cell>
                <s-table-cell>{change.variantTitle}</s-table-cell>
                <s-table-cell>{euro(change.priceCents)}</s-table-cell>
                <s-table-cell>{euro(change.saleCents)}</s-table-cell>
                <s-table-cell>{euro(change.priceCents)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}

      {skipped.length > 0 && (
        <s-stack gap="small">
          <s-heading>Ignorées</s-heading>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Produit</s-table-header>
              <s-table-header>Variante</s-table-header>
              <s-table-header format="currency">Prix</s-table-header>
              <s-table-header>Raison</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {skipped.map((row) => (
                <s-table-row key={row.variantId}>
                  <s-table-cell>{row.productTitle}</s-table-cell>
                  <s-table-cell>{row.variantTitle}</s-table-cell>
                  <s-table-cell>{euroFromString(row.price)}</s-table-cell>
                  <s-table-cell>{SKIP_LABELS[row.reason] || row.reason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      )}

      {changes.length > 0 && !confirming && (
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={onAsk} disabled={busy || !canWrite}>
            {`Appliquer la promotion (${plural(changes.length, 'prix', 'prix')})`}
          </s-button>
          {!canWrite && <s-text color="subdued">L'application n'a pas encore le droit de modifier les prix.</s-text>}
        </s-stack>
      )}

      {confirming && (
        <s-banner tone="warning" heading="Confirmer la promotion">
          <s-stack gap="base">
            <s-paragraph>
              {`${plural(changes.length, 'prix', 'prix')} vont changer immédiatement sur la boutique en ligne (site, paiement, Google). Les prix sont relus juste avant l'application.`}
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" tone="critical" onClick={onConfirm}>Confirmer</s-button>
              <s-button onClick={onCancel}>Annuler</s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      )}
    </s-stack>
  );
}
