import { useEffect, useState } from 'preact/hooks';

import {
  UNREADABLE_SALE_KEY,
  diffSaleCollection,
  flattenVariants,
  groupSales,
  planRestore
} from '../../../scripts/lib/sale-prices/pricing.mjs';
import { fetchSaleCollection, fetchSaleMarkedProducts } from '../../../scripts/lib/sale-prices/shopify-sale-reads.mjs';
import { runApply, runRestore } from '../../../scripts/lib/sale-prices/runner.mjs';
import { graphql } from './shopify-graphql.js';
import { SKIP_LABELS, euro, euroFromString, plural } from './labels.js';

/**
 * « Promotions en cours »: one card per sale (collection + %), read from the
 * markers on the variants, so it shows exactly what is reduced on the store,
 * including products that have since left the collection.
 *
 * Each card also compares the sale with its collection as it is NOW: products
 * added since are offered « Appliquer -X % à ces produits », products removed
 * since are flagged (still reduced) and can be restored on their own. Nothing
 * happens by itself: a person confirms every price change.
 */
export default function ActiveSales({ canWrite, refreshKey, onChanged }) {
  const [sales, setSales] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function load() {
    setError(null);
    try {
      setSales(groupSales(flattenVariants(await fetchSaleMarkedProducts(graphql))));
    } catch (err) {
      setError(`Impossible de lire les promotions en cours : ${err.message}`);
      setSales([]);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  async function done(result) {
    setNotice(result);
    await load();
    onChanged();
  }

  return (
    <s-section heading="Promotions en cours">
      <s-stack gap="base">
        {error && <s-banner tone="critical" heading="Erreur">{error}</s-banner>}
        {notice && <s-banner tone={notice.tone} heading={notice.heading}>{notice.text}</s-banner>}
        {sales === null && <s-spinner accessibilityLabel="Chargement des promotions"></s-spinner>}
        {sales?.length === 0 && !error && <s-paragraph color="subdued">Aucun produit n'est en promotion.</s-paragraph>}
        {sales?.map((sale) => (
          <SaleCard key={sale.key} sale={sale} canWrite={canWrite} onDone={done} />
        ))}
      </s-stack>
    </s-section>
  );
}

function SaleCard({ sale, canWrite, onDone }) {
  const readable = sale.key !== UNREADABLE_SALE_KEY;
  const [diff, setDiff] = useState(null);
  const [panel, setPanel] = useState(null); // 'restore' | 'restoreRemoved' | 'applyAdded'
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    readDiff(sale)
      .then((value) => !cancelled && setDiff(value))
      .catch((err) => !cancelled && setError(`Impossible de lire la collection « ${sale.collection} » : ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [sale]);

  function open(next) {
    setPanel(panel === next ? null : next);
    setForce(false);
    setConfirming(false);
    setError(null);
  }

  const removedIds = new Set((diff?.removed || []).map((row) => row.variantId));
  const restoreRows = panel === 'restoreRemoved' ? sale.rows.filter((row) => removedIds.has(row.variantId)) : sale.rows;
  const restorePlan = panel === 'restore' || panel === 'restoreRemoved' ? planRestore(restoreRows, { force }) : null;

  async function confirmAction() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    const failures = [];
    const onProduct = ({ items, ok, error: err, done, total }) => {
      if (!ok) failures.push(`${items[0].productTitle} (${err})`);
      setProgress({ done, total });
    };
    function finish(problems, { heading, text }) {
      const failed = failures.length ? ` Échecs : ${failures.join(' ; ')}.` : '';
      shopify.toast.show(problems ? 'Terminé avec des erreurs' : heading, { isError: problems > 0 });
      setPanel(null);
      onDone({ tone: problems ? 'warning' : 'success', heading, text: text + failed });
    }

    try {
      // Everything is read again right before writing: prices, markers and the
      // collection may have moved since the card was drawn.
      const fresh = groupSales(flattenVariants(await fetchSaleMarkedProducts(graphql))).find((s) => s.key === sale.key);

      if (panel === 'applyAdded') {
        const freshDiff = await readDiff(fresh || { ...sale, rows: [] });
        const { changes } = freshDiff.added;
        if (changes.length === 0) throw new Error('Plus aucun produit à solder : la collection a changé entre-temps.');
        setProgress({ done: 0, total: new Set(changes.map((c) => c.productId)).size });
        const tally = await runApply({ graphql, changes, onProduct });
        finish(tally.failed, {
          heading: 'Promotion étendue',
          text: `${plural(tally.applied, 'variante')} ajoutée(s) à la promotion ${title(sale)}.`
        });
      } else {
        if (!fresh) throw new Error('Cette promotion n’a plus de variante soldée.');
        let rows = fresh.rows;
        if (panel === 'restoreRemoved') {
          const freshRemoved = new Set((await readDiff(fresh)).removed.map((row) => row.variantId));
          rows = rows.filter((row) => freshRemoved.has(row.variantId));
        }
        const { restores, cleanups, conflicts } = planRestore(rows, { force });
        setProgress({ done: 0, total: new Set([...restores, ...cleanups].map((r) => r.productId)).size });
        const tally = await runRestore({ graphql, restores, cleanups, onProduct });
        finish(tally.failed + tally.markersLeft, {
          heading: 'Prix restaurés',
          text:
            `${plural(tally.restored, 'variante')} revenue(s) au prix d'origine (${title(sale)}).` +
            (conflicts.length ? ` ${plural(conflicts.length, 'variante')} modifiée(s) à la main laissée(s) telle(s) quelle(s).` : '') +
            (tally.markersLeft ? ` ${tally.markersLeft} marqueur(s) non supprimé(s) : relancez la restauration.` : '')
        });
      }

    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack gap="small-200">
            <s-heading>{readable ? title(sale) : 'Marqueurs illisibles (à vérifier à la main)'}</s-heading>
            <s-text color="subdued">{summary(sale)}</s-text>
          </s-stack>
          <s-button onClick={() => open('restore')} disabled={busy}>
            {panel === 'restore' ? 'Fermer' : 'Restaurer les prix'}
          </s-button>
        </s-stack>

        {diff?.collectionMissing && (
          <s-banner tone="warning" heading="Collection introuvable">
            {`La collection « ${sale.collection} » n'existe plus. Les produits restent soldés jusqu'à la restauration.`}
          </s-banner>
        )}

        {diff && diff.added.changes.length > 0 && (
          <s-banner tone="info" heading={`${plural(new Set(diff.added.changes.map((c) => c.productId)).size, 'produit ajouté', 'produits ajoutés')} à la collection, pas encore soldé(s)`}>
            <s-stack gap="small">
              <s-paragraph>{diff.added.changes.map((c) => `${c.productTitle} – ${c.variantTitle}`).join(' ; ')}</s-paragraph>
              <s-stack direction="inline">
                <s-button onClick={() => open('applyAdded')} disabled={busy}>
                  {panel === 'applyAdded' ? 'Fermer' : `Appliquer -${sale.percent} % à ces produits`}
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {diff && !diff.collectionMissing && diff.removed.length > 0 && (
          <s-banner tone="warning" heading={`${plural(diff.removed.length, 'variante retirée', 'variantes retirées')} de la collection, toujours soldée(s)`}>
            <s-stack gap="small">
              <s-paragraph>{diff.removed.map((r) => `${r.productTitle} – ${r.variantTitle}`).join(' ; ')}</s-paragraph>
              <s-stack direction="inline">
                <s-button onClick={() => open('restoreRemoved')} disabled={busy}>
                  {panel === 'restoreRemoved' ? 'Fermer' : 'Restaurer seulement les produits retirés'}
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {error && <s-banner tone="critical" heading="Erreur">{error}</s-banner>}

        {restorePlan && (
          <RestorePanel
            plan={restorePlan}
            removedIds={removedIds}
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
            onConfirm={confirmAction}
          />
        )}

        {panel === 'applyAdded' && diff && (
          <ApplyAddedPanel
            added={diff.added}
            percent={sale.percent}
            canWrite={canWrite}
            busy={busy}
            confirming={confirming}
            onAsk={() => setConfirming(true)}
            onCancel={() => setConfirming(false)}
            onConfirm={confirmAction}
          />
        )}

        {progress && (
          <s-banner tone="info" heading="En cours…">
            {`Produit ${progress.done} sur ${progress.total}. Ne fermez pas cette page.`}
          </s-banner>
        )}
      </s-stack>
    </s-box>
  );
}

function RestorePanel({ plan, removedIds, force, setForce, canWrite, busy, confirming, onAsk, onCancel, onConfirm }) {
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
                <s-stack direction="inline" gap="small-200">
                  {conflicts.includes(row) ? (
                    <s-badge tone="warning">Modifié à la main : laissé tel quel</s-badge>
                  ) : cleanups.includes(row) ? (
                    <s-badge>Déjà au prix d'origine</s-badge>
                  ) : row.forced ? (
                    <s-badge tone="warning">Restauré (forcé)</s-badge>
                  ) : (
                    <s-badge tone="success">Restauré</s-badge>
                  )}
                  {removedIds.has(row.variantId) && <s-badge>Retiré de la collection</s-badge>}
                </s-stack>
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
        <ConfirmBanner
          heading="Confirmer la restauration"
          text={`${plural(restores.length, 'prix', 'prix')} vont revenir immédiatement à leur prix d'origine sur la boutique en ligne.`}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </s-stack>
  );
}

function ApplyAddedPanel({ added, percent, canWrite, busy, confirming, onAsk, onCancel, onConfirm }) {
  const { changes, skipped } = added;
  return (
    <s-stack gap="base">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Produit</s-table-header>
          <s-table-header>Variante</s-table-header>
          <s-table-header>Prix actuel</s-table-header>
          <s-table-header>Prix soldé</s-table-header>
          <s-table-header>Prix barré</s-table-header>
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

      {skipped.length > 0 && (
        <s-paragraph color="subdued">
          {`Non soldé(s) dans la collection : ${skipped
            .map((row) => `${row.productTitle} – ${row.variantTitle} (${SKIP_LABELS[row.reason] || row.reason})`)
            .join(' ; ')}`}
        </s-paragraph>
      )}

      {!confirming && (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant="primary" onClick={onAsk} disabled={busy || !canWrite}>
            {`Appliquer -${percent} % (${plural(changes.length, 'prix', 'prix')})`}
          </s-button>
          {!canWrite && <s-text color="subdued">L'application n'a pas encore le droit de modifier les prix.</s-text>}
        </s-stack>
      )}

      {confirming && (
        <ConfirmBanner
          heading="Confirmer"
          text={`${plural(changes.length, 'prix', 'prix')} vont baisser immédiatement sur la boutique en ligne. Les prix sont relus juste avant l'application.`}
          onConfirm={onConfirm}
          onCancel={onCancel}
          critical
        />
      )}
    </s-stack>
  );
}

function ConfirmBanner({ heading, text, onConfirm, onCancel, critical = false }) {
  return (
    <s-banner tone="warning" heading={heading}>
      <s-stack gap="base">
        <s-paragraph>{text}</s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" tone={critical ? 'critical' : 'auto'} onClick={onConfirm}>Confirmer</s-button>
          <s-button onClick={onCancel}>Annuler</s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

/** The sale against its collection now (see diffSaleCollection). */
async function readDiff(sale) {
  const found = await fetchSaleCollection(graphql, sale.collection);
  return diffSaleCollection({ sale, collectionProducts: found ? found.products : null, appliedAt: new Date().toISOString() });
}

function title(sale) {
  const collectionTitle = sale.collection;
  return `${collectionTitle} · -${sale.percent} %`;
}

function summary(sale) {
  const first = frenchDate(sale.firstAppliedAt);
  const last = frenchDate(sale.lastAppliedAt);
  const dates = first === last ? `depuis le ${first}` : `depuis le ${first}, complétée le ${last}`;
  return (
    `${plural(sale.rows.length, 'variante')} · ${sale.counts.onSale} soldée(s)` +
    (sale.counts.edited ? ` · ${sale.counts.edited} modifiée(s) à la main` : '') +
    (sale.counts.back ? ` · ${sale.counts.back} déjà revenue(s) au prix d'origine` : '') +
    (first ? ` · ${dates}` : '')
  );
}

function frenchDate(iso) {
  if (!iso) return '';
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

