import type { CollectionSale } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import { Caption } from "./InsightsKit";
import t from "./tables.module.css";
import styles from "./CollectionMix.module.css";

/**
 * What each collection sold in the range, busiest first, with the change on the
 * previous period and a concentration bar.
 *
 * COLLECTIONS OVERLAP, so this is a mix and not a split. A product belongs to
 * every collection that carries it — roughly four each on this shop — so a
 * product's revenue is counted in each of them and the shares add up to far
 * more than 100%. The caption says so, and nothing here sums the rows.
 *
 * THE LAST ROW IS WHAT THE RANGES MISS. Six ranges are reported — the ones the
 * business manages the catalogue by — so everything else that sold is gathered
 * into an "Outside these ranges" row rather than quietly dropped; without it
 * the card would read as the whole catalogue.
 *
 * Server-rendered: nothing here switches.
 */
export function CollectionMix({
  collections,
  productRevenue,
  compareLabel,
}: {
  collections: CollectionSale[];
  productRevenue: number;
  compareLabel: string;
}) {
  const tr = getT();
  const { euros, percentOf } = getFormat();
  const named = collections.filter((c) => c.collectionId !== null);
  const uncollected = collections.find((c) => c.collectionId === null) ?? null;
  if (named.length === 0 && (!uncollected || uncollected.revenue === 0)) {
    return <p className={t.muted}>{tr("insights.sales.noPaidLine")}</p>;
  }

  const share = (revenue: number) => (productRevenue > 0 ? (revenue / productRevenue) * 100 : null);
  const widest = Math.max(1, ...named.map((c) => c.revenue));

  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.sales.collection")}</th>
              <th scope="col" className={t.n}>{tr("insights.sales.revenue")}</th>
              <th scope="col" className={t.n} title={tr("insights.sales.shareHint")}>{tr("insights.sales.share")}</th>
              <th scope="col" className={t.n} title={tr("insights.sales.changeAgainst", { label: compareLabel })}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {named.map((collection) => (
              <tr key={collection.collectionId}>
                <th scope="row" className={styles.name} title={tr("insights.sales.productsInCollection", { count: collection.products })}>
                  {collection.title}
                </th>
                <td className={t.n}>{euros(collection.revenue)}</td>
                <td className={t.n}>{share(collection.revenue) === null ? "—" : percentOf(share(collection.revenue)!, 1)}</td>
                <td className={t.n}>
                  <Delta collection={collection} />
                </td>
              </tr>
            ))}
            {uncollected && uncollected.revenue > 0 ? (
              <tr className={styles.uncollected}>
                <th scope="row" className={styles.name} title={tr("insights.sales.noRangeHint")}>
                  {tr("insights.sales.outsideRanges")}
                </th>
                <td className={t.n}>{euros(uncollected.revenue)}</td>
                <td className={t.n}>
                  {share(uncollected.revenue) === null ? "—" : percentOf(share(uncollected.revenue)!, 1)}
                </td>
                <td className={t.n}>
                  <Delta collection={uncollected} />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {named.length > 0 ? (
        <div className={styles.concentration} aria-hidden="true">
          {named.map((collection) => (
            <i
              key={collection.collectionId}
              style={{ width: `${Math.max(2, (collection.revenue / widest) * 100).toFixed(1)}%` }}
              title={`${collection.title} · ${euros(collection.revenue)}`}
            />
          ))}
        </div>
      ) : null}

      <Caption>{tr("insights.sales.collectionNote")}</Caption>
    </>
  );
}

/** The change against the previous period, or a dash where none can be computed. */
function Delta({ collection }: { collection: CollectionSale }) {
  const tr = getT();
  const { percentOf } = getFormat();
  if (collection.previousRevenue === null) return <span className={t.muted}>—</span>;
  if (collection.previousRevenue === 0) return <span className={styles.up}>{tr("insights.sales.new")}</span>;
  const change = ((collection.revenue - collection.previousRevenue) / collection.previousRevenue) * 100;
  if (Math.abs(change) < 0.05) return <span className={t.muted}>{percentOf(0, 1)}</span>;
  return (
    <span className={change > 0 ? styles.up : styles.down}>
      {change > 0 ? "+" : "−"}
      {percentOf(Math.abs(change), 1)}
    </span>
  );
}
