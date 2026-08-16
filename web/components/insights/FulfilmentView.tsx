import type { FulfilmentPanel } from "@/lib/types";
import {
  BarList,
  BlockedTile,
  EmptyState,
  Note,
  PanelSection,
  StatTile,
  TileGrid,
  hours,
  percent,
} from "./InsightsKit";
import { formatMonth } from "@/lib/insights-format";
import styles from "./FulfilmentView.module.css";

/**
 * Fulfilment: how long orders take to leave the building, and — once a carrier
 * feed exists — how long they take to arrive.
 *
 * The two halves are laid out as two sections rather than interleaved, so the
 * blocked half reads as a section waiting on data instead of as a row of broken
 * tiles among working ones.
 */
export function FulfilmentView({ panel }: { panel: FulfilmentPanel }) {
  const { summary, byMonth, byCarrier, byBucket, hasDeliveryData } = panel;

  if (!summary || summary.orders === 0) {
    return <EmptyState>No orders have been synced yet. Run `npm run sync:shopify:orders`.</EmptyState>;
  }

  const worst = byMonth.reduce<(typeof byMonth)[number] | null>((acc, m) => {
    if (m.partial || !m.measured) return acc;
    const rate = m.over72h / m.measured;
    if (!acc || rate > acc.over72h / acc.measured) return m;
    return acc;
  }, null);

  return (
    <>
      <PanelSection
        title="Order to dispatch"
        subtitle={`${summary.measured.toLocaleString()} of ${summary.orders.toLocaleString()} orders carry both timestamps, so this is measured on effectively the whole book.`}
      >
        <TileGrid>
          <StatTile
            label="Median fulfilment"
            value={hours(summary.p50Hours)}
            foot={`Mean ${hours(summary.meanHours)} — the gap is the long tail`}
          />
          <StatTile
            label="90th percentile"
            value={hours(summary.p90Hours)}
            tone={summary.p90Hours !== null && summary.p90Hours > 72 ? "warn" : "neutral"}
            foot="One order in ten takes at least this long"
          />
          <StatTile
            label="Shipped after 3 days"
            value={summary.over72h.toLocaleString()}
            of={`of ${summary.measured.toLocaleString()}`}
            tone={summary.over72h / Math.max(1, summary.measured) > 0.1 ? "bad" : "good"}
            foot={`${percent(summary.over72h, summary.measured)} past 72 hours`}
          />
          <StatTile
            label="Shipped with no tracking"
            value={summary.shippedWithoutTracking.toLocaleString()}
            tone={summary.shippedWithoutTracking > 0 ? "warn" : "good"}
            foot="Those customers cannot self-serve, and their tickets cannot be resolved by parcel number"
          />
        </TileGrid>

        <div className={styles.split}>
          <figure className={styles.figure}>
            <figcaption className={styles.figcaption}>
              <span className={styles.figTitle}>How long orders take to ship</span>
              <span className={styles.figSub}>
                All {summary.measured.toLocaleString()} measured orders. Red is past three days.
              </span>
            </figcaption>
            <BarList
              ariaLabel="Fulfilment time distribution"
              data={byBucket.map((b) => ({
                key: b.bucket,
                label: b.bucket,
                value: b.orders,
                emphasis: b.late,
                title: `${b.orders.toLocaleString()} orders shipped in ${b.bucket} (${percent(
                  b.orders,
                  summary.measured
                )})`,
              }))}
            />
          </figure>

          <figure className={styles.figure}>
            <figcaption className={styles.figcaption}>
              <span className={styles.figTitle}>Orders shipped after 72 hours</span>
              <span className={styles.figSub}>
                Share of each month. The current month is partial and marked.
              </span>
            </figcaption>
            <BarList
              ariaLabel="Share of orders shipped after 72 hours, by month"
              data={byMonth.map((m) => {
                const rate = m.measured ? (m.over72h / m.measured) * 100 : 0;
                return {
                  key: m.month,
                  label: `${formatMonth(m.month)}${m.partial ? "*" : ""}`,
                  value: rate,
                  display: m.measured ? `${rate.toFixed(1)}%` : "—",
                  emphasis: rate >= 20,
                  title: `${formatMonth(m.month)}: ${m.over72h} of ${m.measured} orders past 72h, p90 ${hours(
                    m.p90Hours
                  )}${m.partial ? " (month still in progress)" : ""}`,
                };
              })}
            />
          </figure>
        </div>

        {worst && worst.over72h / worst.measured >= 0.2 ? (
          <Note tone="warn" title={`${formatMonth(worst.month)} is the outlier`}>
            {percent(worst.over72h, worst.measured)} of that month&apos;s {worst.measured.toLocaleString()}{" "}
            orders took more than three days to ship, against a median month in the single digits, and its
            90th percentile reached {hours(worst.p90Hours)}. Worth knowing whether that was a known staffing
            gap or news — it is the difference between a metric and an alert.
          </Note>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Carriers"
        subtitle="Names are normalised before counting — the raw data spells Colissimo three ways, and a naive breakdown reports three carriers."
      >
        {byCarrier.length === 0 ? (
          <EmptyState>No carrier is recorded on any fulfilment yet.</EmptyState>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Carrier</th>
                  <th scope="col">Shipments</th>
                  <th scope="col">Share</th>
                  <th scope="col">Median dispatch</th>
                  <th scope="col">Past 3 days</th>
                </tr>
              </thead>
              <tbody>
                {byCarrier.map((c) => {
                  const total = byCarrier.reduce((sum, x) => sum + x.shipments, 0);
                  return (
                    <tr key={c.carrier}>
                      <th scope="row">{c.carrier}</th>
                      <td className={styles.n}>{c.shipments.toLocaleString()}</td>
                      <td className={styles.n}>{percent(c.shipments, total)}</td>
                      <td className={styles.n}>{hours(c.p50Hours)}</td>
                      <td className={styles.n}>
                        {c.over72h.toLocaleString()}{" "}
                        <span className={styles.muted}>({percent(c.over72h, c.shipments)})</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="Delivery"
        subtitle="Dispatch to doorstep — the half of the journey nobody can currently see."
      >
        {hasDeliveryData ? (
          <EmptyState>
            Delivery events are arriving. This section is ready for the median, the share past four days,
            and the stuck-parcel list.
          </EmptyState>
        ) : (
          <>
            <TileGrid>
              <BlockedTile
                label="Median delivery time"
                reason="No carrier scan events reach Shopify for this store"
              />
              <BlockedTile label="Delivered after 4 days" reason="Needs the same feed" />
              <BlockedTile
                label="Parcels stuck in transit"
                reason="Needs intermediate scans, not just a final delivery confirmation"
              />
              <StatTile
                label="Orders with a delivery date"
                value={summary.withDeliveryEvent.toLocaleString()}
                of={`of ${summary.orders.toLocaleString()}`}
                tone="blocked"
                foot="The coverage check behind the three blocked tiles"
              />
            </TileGrid>
            <Note title="Why this is empty, and the cheapest way to fill it">
              The schema is already there — every fulfilment record carries <code>in_transit_at</code>,{" "}
              <code>estimated_delivery_at</code> and <code>delivered_at</code>, and{" "}
              <code>orders.tracking_numbers</code> is indexed so a parcel number joins straight back to an
              order. The events never arrive. Before assuming a 3PL integration is the only route, it is
              worth asking whether dispatch can post delivery confirmations onto the Shopify fulfilment:
              that fills these columns with no new table and no new sync, and every tile above turns on by
              itself.
            </Note>
          </>
        )}
      </PanelSection>
    </>
  );
}
