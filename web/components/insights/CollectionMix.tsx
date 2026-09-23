import type { CollectionSale } from "@/lib/types";
import { Caption, euros } from "./InsightsKit";
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
  const named = collections.filter((c) => c.collectionId !== null);
  const uncollected = collections.find((c) => c.collectionId === null) ?? null;
  if (named.length === 0 && (!uncollected || uncollected.revenue === 0)) {
    return <p className={t.muted}>No paid product line in this range.</p>;
  }

  const share = (revenue: number) => (productRevenue > 0 ? (revenue / productRevenue) * 100 : null);
  const widest = Math.max(1, ...named.map((c) => c.revenue));

  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col" className={t.n}>Revenue</th>
              <th scope="col" className={t.n} title="Share of the range's paid product revenue">Share</th>
              <th scope="col" className={t.n} title={`Change against ${compareLabel}`}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {named.map((collection) => (
              <tr key={collection.collectionId}>
                <th scope="row" className={styles.name} title={`${collection.products} products sold in this collection`}>
                  {collection.title}
                </th>
                <td className={t.n}>{euros(collection.revenue)}</td>
                <td className={t.n}>{share(collection.revenue) === null ? "—" : `${share(collection.revenue)!.toFixed(1)}%`}</td>
                <td className={t.n}>
                  <Delta collection={collection} />
                </td>
              </tr>
            ))}
            {uncollected && uncollected.revenue > 0 ? (
              <tr className={styles.uncollected}>
                <th scope="row" className={styles.name} title="Products in none of the six ranges">
                  {uncollected.title}
                </th>
                <td className={t.n}>{euros(uncollected.revenue)}</td>
                <td className={t.n}>
                  {share(uncollected.revenue) === null ? "—" : `${share(uncollected.revenue)!.toFixed(1)}%`}
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

      <Caption>
        The six ranges the catalogue is managed by. A product counts in every range that carries it, so the shares
        overlap and never add up to 100%. Share is of the period&apos;s paid product revenue; everything in none of
        them is the last row.
      </Caption>
    </>
  );
}

/** The change against the previous period, or a dash where none can be computed. */
function Delta({ collection }: { collection: CollectionSale }) {
  if (collection.previousRevenue === null) return <span className={t.muted}>—</span>;
  if (collection.previousRevenue === 0) return <span className={styles.up}>new</span>;
  const change = ((collection.revenue - collection.previousRevenue) / collection.previousRevenue) * 100;
  if (Math.abs(change) < 0.05) return <span className={t.muted}>0.0%</span>;
  return (
    <span className={change > 0 ? styles.up : styles.down}>
      {change > 0 ? "+" : "−"}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}
