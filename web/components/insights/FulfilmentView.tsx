import type { FulfilmentCarrier, FulfilmentPanel } from "@/lib/types";
import {
  BarList,
  BlockedCard,
  Card,
  DeltaChip,
  Grid,
  KpiCard,
  euros,
  hours,
  percent,
} from "./InsightsKit";
import { OpenOrders } from "./OpenOrders";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { perGrain } from "./grain";
import t from "./tables.module.css";

/**
 * Fulfilment over the chosen range and platform: how long orders take to leave,
 * how many, and — once a carrier feed exists — how long they take to arrive.
 */
export function FulfilmentView({ panel, compareLabel }: { panel: FulfilmentPanel; compareLabel: string }) {
  const { current, previous } = panel.summary;
  const lateShare = current.measured ? (current.over72h / current.measured) * 100 : null;
  const previousLate = previous && previous.measured ? (previous.over72h / previous.measured) * 100 : null;
  const grain = perGrain(panel.orders);

  return (
    <>
      <Grid pin="headline" label="Fulfilment headline figures">
        <KpiCard
          label="Orders"
          value={current.orders.toLocaleString("en-GB")}
          delta={<DeltaChip current={current.orders} previous={previous?.orders} polarity="up" compareLabel={compareLabel} />}
          sub={[
            { label: "Shipped", value: current.measured.toLocaleString("en-GB") },
            { label: "Cancelled", value: current.cancelledOrders.toLocaleString("en-GB") },
          ]}
        />
        <KpiCard
          label="Median time to ship"
          value={hours(current.p50Hours)}
          delta={
            <DeltaChip current={current.p50Hours} previous={previous?.p50Hours} polarity="down" compareLabel={compareLabel} />
          }
          sub={[
            { label: "90th percentile", value: hours(current.p90Hours) },
            { label: "Average", value: hours(current.meanHours) },
          ]}
        />
        <KpiCard
          label="Shipped after 3 days"
          value={lateShare === null ? "—" : `${lateShare.toFixed(1)}%`}
          tone={lateShare !== null && lateShare > 10 ? "bad" : undefined}
          delta={<DeltaChip current={lateShare} previous={previousLate} polarity="down" points compareLabel={compareLabel} />}
          sub={[{ label: "Orders past 72 h", value: `${current.over72h.toLocaleString("en-GB")} of ${current.measured.toLocaleString("en-GB")}` }]}
        />
        <KpiCard
          label="Shipped without tracking"
          value={current.shippedWithoutTracking.toLocaleString("en-GB")}
          tone={current.shippedWithoutTracking > 0 ? "warn" : undefined}
          delta={
            <DeltaChip
              current={current.shippedWithoutTracking}
              previous={previous?.shippedWithoutTracking}
              polarity="down"
              compareLabel={compareLabel}
            />
          }
          sub={[{ label: "Share of shipped", value: percent(current.shippedWithoutTracking, current.measured) }]}
        />
      </Grid>

      <Grid min={100} pin="open-orders" label="Orders waiting to ship">
        <Card
          title="Orders waiting to ship"
          aside={<span>Now, as of the last order sync — not cut by the date range · names and emails, do not share</span>}
        >
          <OpenOrders orders={panel.openOrders} vipRuleSet={panel.vipRuleSet} />
        </Card>
      </Grid>

      <Grid min={100} pin="orders-chart" label="Orders chart">
        <Card title={`Orders ${grain}`}>
          <TimeSeriesChart
            points={panel.orders}
            unit="count"
            ariaLabel={`Orders ${grain}`}
            missingLabel="Not synced from Shopify yet"
          />
        </Card>
      </Grid>

      <Grid min={26} pin="timing" label="Time to ship">
        <Card title={`Median time to ship, ${grain}`}>
          <TimeSeriesChart
            points={panel.medianHours}
            unit="hours"
            ariaLabel={`Median time from order to dispatch, ${grain}`}
            height={240}
            threshold={{ value: 72, label: "3 days" }}
            missingLabel="Not synced from Shopify yet"
          />
        </Card>
        <Card title="How long orders take to ship">
          <BarList
            ariaLabel="Orders by time to ship"
            data={panel.buckets.map((b) => ({
              key: b.bucket,
              label: b.bucket,
              value: b.orders,
              emphasis: b.late,
              display: `${b.orders.toLocaleString("en-GB")}  ·  ${percent(b.orders, current.measured, 0)}`,
              title: `${b.orders} orders shipped in ${b.bucket}`,
            }))}
          />
        </Card>
      </Grid>

      <Grid pin="returns" label="Refunds and delivery">
        <KpiCard
          label="Refunded orders"
          value={current.refundedOrders.toLocaleString("en-GB")}
          unit={`of ${current.orders.toLocaleString("en-GB")}`}
          sub={[
            { label: "Refunded", value: euros(current.refundedAmount) },
            { label: "Returns opened", value: current.returnsOpened.toLocaleString("en-GB") },
          ]}
        />
        {panel.hasDeliveryData ? null : (
          <>
            <BlockedCard label="Median delivery time" reason="No carrier scan events reach Shopify" />
            <BlockedCard label="Delivered after 4 days" reason="Needs the same carrier feed" />
            <BlockedCard label="Parcels stuck in transit" reason="Needs intermediate carrier scans" />
          </>
        )}
      </Grid>

      <Grid min={100} pin="carriers" label="Carriers">
        <Card title="Carriers">
          {panel.carriers.length === 0 ? (
            <p className={t.muted}>No shipment with a carrier in this range.</p>
          ) : (
            <CarrierTable rows={panel.carriers} />
          )}
        </Card>
      </Grid>
    </>
  );
}

const OUTCOMES: { key: "lost" | "damaged" | "late"; label: string }[] = [
  { key: "lost", label: "Lost" },
  { key: "damaged", label: "Damaged" },
  { key: "late", label: "Delivered late" },
];

/**
 * `Contacted support` counts orders, not threads, and only reaches the threads
 * whose order number the resolver confirmed — so it is a floor. Lost, damaged
 * and late are placeholders nothing writes yet: dashes, never zeros.
 */
function CarrierTable({ rows }: { rows: FulfilmentCarrier[] }) {
  const total = rows.reduce((sum, c) => sum + c.shipments, 0);
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">Carrier</th>
            <th scope="col" className={t.n}>Shipments</th>
            <th scope="col" className={t.n}>Share</th>
            <th scope="col" className={t.n}>Median to ship</th>
            <th scope="col" className={t.n}>Past 3 days</th>
            <th scope="col" className={t.n} title="Orders with a ticket whose order number was confirmed — a floor">
              Contacted support
            </th>
            {OUTCOMES.map((o) => (
              <th key={o.key} scope="col" className={t.n} title="Needs a carrier delivery feed — not measured yet">
                {o.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.carrier}>
              <th scope="row">{c.carrier}</th>
              <td className={t.n}>{c.shipments.toLocaleString("en-GB")}</td>
              <td className={t.n}>{percent(c.shipments, total)}</td>
              <td className={t.n}>{hours(c.p50Hours)}</td>
              <td className={t.n}>
                {c.over72h.toLocaleString("en-GB")} <span className={t.muted}>({percent(c.over72h, c.shipments)})</span>
              </td>
              <td className={t.n}>
                {c.ordersWithTicket.toLocaleString("en-GB")}{" "}
                <span className={t.muted}>({percent(c.ordersWithTicket, c.shipments)})</span>
              </td>
              {OUTCOMES.map((o) => (
                <td key={o.key} className={`${t.n} ${t.pending}`}>
                  <span aria-hidden="true">—</span>
                  <span className={t.srOnly}>{o.label}: not measured yet</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
