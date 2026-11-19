import { useEffect, useState } from 'preact/hooks';

import { flattenVariants, parseMarker, planRestore, toCents } from '../../../scripts/lib/sale-prices/pricing.mjs';
import { fetchSaleMarkedProducts } from '../../../scripts/lib/sale-prices/shopify-sale-reads.mjs';
import { runRestore } from '../../../scripts/lib/sale-prices/runner.mjs';
import { graphql } from './shopify-graphql.js';
import { euro, euroFromString, plural } from './labels.js';

/**
 * « Promotions en cours »: every variant carrying a sale marker, grouped by
 * promotion, each with « Restaurer les prix ». Read from Shopify (the markers),
 * not from any app data, so it shows exactly what is on the store.
 */
export default function ActiveSales({ canWrite, refreshKey, onRestored }) {
  const [campaigns, setCampaigns] = useState(null);
  const [selected, setSelected] = useState(null);
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    try {
      setCampaigns(groupByCampaign(flattenVariants(await fetchSaleMarkedProducts(graphql))));
    } catch (err) {
      setError(`Impossible de lire les promotions en cours : ${err.message}`);
      setCampaigns([]);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  const current = selected && campaigns?.find((c) => c.id === selected);
  const plan = current ? planRestore(current.rows, { force }) : null;

  function choose(id) {
    setSelected(id === selected ? null : id);
    setForce(false);
    setConfirming(false);
    setResult(null);
  }

  async function handleRestore() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      // Re-read the markers and prices right before writing.
      const fresh = groupByCampaign(flattenVariants(await fetchSaleMarkedProducts(graphql)));
      const campaign = fresh.find((c) => c.id === selected);
      if (!campaign) throw new Error('Cette promotion n’a plus de variante soldée.');
      const { restores, cleanups, conflicts } = planRestore(campaign.rows, { force });

      const failures = [];
      setProgress({ done: 0, total: new Set([...restores, ...cleanups].map((r) => r.productId)).size });
      const tally = await runRestore({
        graphql,
        restores,
        cleanups,
        onProduct: ({ items, ok, error: err, done, total }) => {
          if (!ok) failures.push({ product: items[0].productTitle, error: err });
          setProgress({ done, total });
        }
      });
      setResult({ ...tally, failures, conflicts: conflicts.length });
      shopify.toast.show(
        tally.failed ? `${plural(tally.failed, 'variante')} en échec` : `${plural(tally.restored, 'prix restauré', 'prix restaurés')}`,
        { isError: tally.failed > 0 }
      );
      await load();
      onRestored();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <s-section heading="Promotions en cours">
      <s-stack gap="base">
        {error && <s-banner tone="critical" heading="Erreur">{error}</s-banner>}
        {campaigns === null && <s-spinner accessibilityLabel="Chargement des promotions"></s-spinner>}
        {campaigns?.length === 0 && !error && (
          <s-paragraph color="subdued">Aucun produit n'est en promotion.</s-paragraph>
        )}

        {campaigns?.map((campaign) => (
          <s-box key={campaign.id} padding="base" border="base" borderRadius="base">
            <s-stack gap="small">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-stack gap="small-200">
                  <s-heading>{campaign.label}</s-heading>
                  <s-text color="subdued">
                    {`${plural(campaign.rows.length, 'variante')} · ${campaign.counts.onSale} soldée(s)` +
                      (campaign.counts.edited ? ` · ${campaign.counts.edited} modifiée(s) à la main` : '') +
                      (campaign.counts.back ? ` · ${campaign.counts.back} déjà revenue(s) au prix d'origine` : '')}
                  </s-text>
                </s-stack>
                <s-button onClick={() => choose(campaign.id)} disabled={busy}>
                  {selected === campaign.id ? 'Fermer' : 'Restaurer les prix'}
                </s-button>
              </s-stack>

              {selected === campaign.id && plan && (
                <RestorePanel
                  plan={plan}
                  force={force}
                  setForce={(value) => {
                    setForce(value);
                    setConfirming(false);
                  }}
                  canWrite={canWrite}
                  busy={busy}
                  confirming={confirming}
                  onAsk={() => setConfirming(true)}
                  onCancel={() => setConfirming(false)}
                  onConfirm={handleRestore}
                />
              )}
            </s-stack>
          </s-box>
        ))}

        {progress && (
          <s-banner tone="info" heading="Restauration en cours…">
            {`Produit ${progress.done} sur ${progress.total}. Ne fermez pas cette page.`}
          </s-banner>
        )}

        {result && (
          <s-banner tone={result.failed || result.markersLeft ? 'warning' : 'success'} heading="Prix restaurés">
            {`${plural(result.restored, 'variante')} revenue(s) au prix d'origine.`}
            {result.conflicts > 0 && ` ${plural(result.conflicts, 'variante')} modifiée(s) à la main laissée(s) telle(s) quelle(s).`}
            {result.markersLeft > 0 && ` ${result.markersLeft} marqueur(s) non supprimé(s) : relancez la restauration pour les nettoyer.`}
            {result.failed > 0 &&
              ` ${plural(result.failed, 'variante')} en échec : ${result.failures.map((f) => `${f.product} (${f.error})`).join(' ; ')}.`}
          </s-banner>
        )}
      </s-stack>
    </s-section>
  );
}

function RestorePanel({ plan, force, setForce, canWrite, busy, confirming, onAsk, onCancel, onConfirm }) {
  const { restores, cleanups, conflicts, skipped } = plan;
  const total = restores.length + cleanups.length;

  return (
    <s-stack gap="base">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Produit</s-table-header>
          <s-table-header>Variante</s-table-header>
          <s-table-header>Prix actuel</s-table-header>
          <s-table-header>Prix d'origine</s-table-header>
          <s-table-header>Prix barré d'origine</s-table-header>
          <s-table-header>Action</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {[...restores, ...cleanups, ...conflicts].map((row) => (
            <s-table-row key={row.variantId}>
              <s-table-cell>{row.productTitle}</s-table-cell>
              <s-table-cell>{row.variantTitle}</s-table-cell>
              <s-table-cell>{euroFromString(row.price)}</s-table-cell>
              <s-table-cell>{euro(row.targetCents)}</s-table-cell>
              <s-table-cell>{euro(row.targetCompareCents)}</s-table-cell>
              <s-table-cell>
                {conflicts.includes(row) ? (
                  <s-badge tone="warning">Modifié à la main : laissé tel quel</s-badge>
                ) : cleanups.includes(row) ? (
                  <s-badge>Déjà au prix d'origine</s-badge>
                ) : row.forced ? (
                  <s-badge tone="warning">Restauré (forcé)</s-badge>
                ) : (
                  <s-badge tone="success">Restauré</s-badge>
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {skipped.length > 0 && (
        <s-banner tone="warning" heading="Variantes à vérifier à la main">
          {skipped.map((row) => `${row.productTitle} – ${row.variantTitle}`).join(' ; ')}
        </s-banner>
      )}

      {(conflicts.length > 0 || force) && (
        <s-checkbox
          label="Restaurer aussi les prix modifiés à la main pendant la promotion"
          checked={force}
          disabled={busy}
          onChange={(event) => setForce(event.currentTarget.checked)}
        ></s-checkbox>
      )}

      {!confirming && (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant="primary" onClick={onAsk} disabled={busy || !canWrite || total === 0}>
            {`Restaurer ${plural(total, 'prix', 'prix')}`}
          </s-button>
          {!canWrite && <s-text color="subdued">L'application n'a pas encore le droit de modifier les prix.</s-text>}
        </s-stack>
      )}

      {confirming && (
        <s-banner tone="warning" heading="Confirmer la restauration">
          <s-stack gap="base">
            <s-paragraph>
              {`${plural(restores.length, 'prix', 'prix')} vont revenir immédiatement à leur prix d'origine sur la boutique en ligne.`}
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={onConfirm}>Confirmer</s-button>
              <s-button onClick={onCancel}>Annuler</s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      )}
    </s-stack>
  );
}

/** Marked rows -> [{ id, label, rows, counts }] by promotion, newest first. */
function groupByCampaign(rows) {
  const byId = new Map();
  for (const row of rows) {
    const marker = parseMarker(row.markerValue);
    const id = marker?.campaign || 'marqueur-illisible';
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: marker
          ? `${marker.collection} · -${marker.percent} % · depuis le ${(marker.appliedAt || '').slice(0, 10)}`
          : 'Marqueurs illisibles (à vérifier à la main)',
        appliedAt: marker?.appliedAt || '',
        rows: [],
        counts: { onSale: 0, edited: 0, back: 0 }
      });
    }
    const campaign = byId.get(id);
    campaign.rows.push(row);
    if (marker) {
      const now = toCents(row.price);
      if (now === marker.saleCents) campaign.counts.onSale += 1;
      else if (now === marker.originalCents) campaign.counts.back += 1;
      else campaign.counts.edited += 1;
    }
  }
  return [...byId.values()].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}
